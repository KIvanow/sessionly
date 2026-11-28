//! Minimal git helpers: repository root, credential-free remote, user
//! identity, and running git with a deadline and a cap on what it prints.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Why git gave no usable answer.
#[derive(Debug, PartialEq)]
pub enum Stop {
    Failed,
    TimedOut,
    TooLarge,
}

/// `git -C <root>` for reading: no file system monitor is started and no
/// optional lock is taken, so it never gets in the way of the person's own
/// git; and it is the repository at `root`, whatever git's variables in the
/// environment name (a hook that runs this is given them).
pub fn command(root: &Path) -> Command {
    let mut command = Command::new(program());
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.fsmonitor=false"])
        .env("GIT_OPTIONAL_LOCKS", "0");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
    ] {
        command.env_remove(name);
    }
    command
}

#[cfg(test)]
thread_local! {
    /// The git a test runs in place of the one on the path (a slow one, an
    /// old one), for that test's thread only.
    static PROGRAM: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Run `program` for git from now on in this thread, or git again.
#[cfg(test)]
pub fn run_instead(program: Option<PathBuf>) {
    PROGRAM.with(|p| *p.borrow_mut() = program);
}

fn program() -> std::ffi::OsString {
    #[cfg(test)]
    if let Some(program) = PROGRAM.with(|p| p.borrow().clone()) {
        return program.into();
    }
    "git".into()
}

/// Run `command` and return what it printed, as far as `max_bytes`, and
/// whether it all fit. Past `deadline` it is killed, and as soon as it has
/// printed more than `max_bytes`.
pub fn bounded(
    command: Command,
    input: Option<&[u8]>,
    max_bytes: usize,
    deadline: Instant,
) -> Result<(Vec<u8>, bool), Stop> {
    match run(command, input, max_bytes, deadline)? {
        // Stopped for printing too much, whichever came first: so it did.
        (out, None) => Ok((out, false)),
        (out, Some(status)) if status.success() => Ok((out, true)),
        _ => Err(Stop::Failed),
    }
}

/// What git says of a name, as `rev-parse --verify --quiet`, `symbolic-ref
/// --quiet` and `config --get` say it: its value, or none when there is no
/// such name (they exit 1, and print nothing). Any other answer is no answer.
pub fn lookup(command: Command, deadline: Instant) -> Result<Option<String>, Stop> {
    match run(command, None, 64 * 1024, deadline)? {
        (_, None) => Err(Stop::TooLarge),
        (out, Some(status)) => match status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&out).trim().to_string())),
            Some(1) if out.is_empty() => Ok(None),
            _ => Err(Stop::Failed),
        },
    }
}

/// Run `command` to its end, or past `deadline`, or until it has printed
/// more than `max_bytes`: what it printed, as far as that, and how it
/// ended (nothing when it was stopped for printing too much).
///
/// Git runs in a session of its own, with no terminal: nothing it starts (a
/// fetch, ssh) can ask anything, and all of that is stopped with it. Its
/// input is a file, not a pipe: git may stop reading at any time, and
/// writing to a pipe nobody reads would end this process, which does not
/// ignore that (so that `show | head` ends quietly).
fn run(
    mut command: Command,
    input: Option<&[u8]>,
    max_bytes: usize,
    deadline: Instant,
) -> Result<(Vec<u8>, Option<std::process::ExitStatus>), Stop> {
    let input = input
        .map(Input::new)
        .transpose()
        .map_err(|_| Stop::Failed)?;
    command
        .stdin(match &input {
            Some(input) => Stdio::from(input.file.try_clone().map_err(|_| Stop::Failed)?),
            None => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|err| {
        // More paths than a command line takes: a reading for fewer may fit.
        if err.kind() == std::io::ErrorKind::ArgumentListTooLong {
            Stop::TooLarge
        } else {
            Stop::Failed
        }
    })?;
    let mut stdout = child.stdout.take().ok_or(Stop::Failed)?;
    // Read while it runs, so a long answer cannot block it: done once git,
    // and whatever it started, are done printing.
    // A read that fails is no answer, not the end of one.
    let (sent, printed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        let mut fits = true;
        loop {
            let n = match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return,
            };
            let room = max_bytes.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..n.min(room)]);
            if n > room {
                fits = false;
                break;
            }
        }
        let _ = sent.send((kept, fits));
    });
    let wait = deadline.saturating_duration_since(Instant::now());
    let (out, fits) = match printed.recv_timeout(wait) {
        Ok(read) => read,
        Err(gone) => {
            stop(&mut child);
            return Err(match gone {
                std::sync::mpsc::RecvTimeoutError::Timeout => Stop::TimedOut,
                std::sync::mpsc::RecvTimeoutError::Disconnected => Stop::Failed,
            });
        }
    };
    if !fits {
        stop(&mut child);
        return Ok((out, None));
    }
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok((out, Some(status))),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(1));
            }
            gone => {
                stop(&mut child);
                return Err(match gone {
                    Ok(_) => Stop::TimedOut,
                    Err(_) => Stop::Failed,
                });
            }
        }
    }
}

/// Stop git and all it started: the session it leads, which stays its own
/// until git is waited for.
fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(id) = i32::try_from(child.id()) {
        unsafe {
            libc::kill(-id, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// What git is given to read: a file of our own, gone once nothing has it
/// open.
struct Input {
    file: std::fs::File,
    path: PathBuf,
}

impl Input {
    fn new(bytes: &[u8]) -> std::io::Result<Input> {
        use std::io::{Seek, SeekFrom};
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        loop {
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("sessionly-git-{}-{n}", std::process::id()));
            let mut options = std::fs::OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let file = match options.open(&path) {
                Ok(file) => file,
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            };
            let mut input = Input { file, path };
            // An open file stays while it is read: on unix it can go at once.
            #[cfg(unix)]
            let _ = std::fs::remove_file(&input.path);
            input.file.write_all(bytes)?;
            input.file.seek(SeekFrom::Start(0))?;
            return Ok(input);
        }
    }
}

impl Drop for Input {
    fn drop(&mut self) {
        if cfg!(not(unix)) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The repository a worktree at `root` is of: its common git directory,
/// the same for each of its worktrees. Asked without `--path-format`, which
/// git before 2.31 does not know (and prints back as if it were the answer).
pub fn common_dir(root: &Path, deadline: Instant) -> Result<PathBuf, Stop> {
    let mut command = command(root);
    command.args(["rev-parse", "--git-common-dir"]);
    let (out, fits) = bounded(command, None, 4096, deadline)?;
    let text = String::from_utf8_lossy(&out);
    let mut lines = text.lines();
    match (fits, lines.next(), lines.next()) {
        // Relative to the worktree's top, where it ran.
        (true, Some(dir), None) if !dir.is_empty() => {
            root.join(dir).canonicalize().map_err(|_| Stop::Failed)
        }
        _ => Err(Stop::Failed),
    }
}

/// The repository a worktree's `.git` names, read as git reads it, without
/// running it: the directory itself, or the one a `.git` file names, and
/// the common directory that one's `commondir` names, if any. None when it
/// names none that is there (a worktree pruned since) or cannot be read.
pub fn named_common_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    let git_dir = if std::fs::metadata(&dot).ok()?.is_dir() {
        dot
    } else {
        let mut text = String::new();
        std::fs::File::open(&dot)
            .ok()?
            .take(4096)
            .read_to_string(&mut text)
            .ok()?;
        let named = text.lines().next()?.strip_prefix("gitdir:")?.trim();
        if named.is_empty() {
            return None;
        }
        // Relative to where the file is.
        root.join(named)
    };
    let common = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) => match text.lines().next().map(str::trim) {
            Some(named) if !named.is_empty() => git_dir.join(named),
            _ => return None,
        },
        Err(_) => git_dir,
    };
    common.canonicalize().ok().filter(|dir| dir.is_dir())
}

/// Walk up from `dir` to the directory containing `.git` (a directory, or a
/// file for worktrees and submodules).
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

/// Read a git config value as seen from `dir`. If `dir` no longer exists only
/// the global config is consulted, never the directory we happen to run in.
fn config(dir: &Path, key: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    if dir.is_dir() {
        cmd.arg("-C").arg(dir).args(["config", "--get", key]);
    } else {
        cmd.args(["config", "--global", "--get", key]);
    }
    let out = cmd.output().ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !value.is_empty()).then_some(value)
}

/// `origin` remote of the repository at `root`, as `host/owner/repo`.
pub fn origin_remote(root: &Path) -> Option<String> {
    normalize_remote(&config(root, "remote.origin.url")?)
}

/// The branch checked out at `root` right now. `None` on a detached HEAD.
pub fn current_branch(root: &Path) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()?;
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !branch.is_empty()).then_some(branch)
}

/// Git user (name, email) as configured for `dir`, falling back to global config.
pub fn user(dir: &Path) -> (Option<String>, Option<String>) {
    (config(dir, "user.name"), config(dir, "user.email"))
}

/// `git@github.com:o/r.git`, `https://user:token@github.com/o/r.git` and
/// `ssh://git@github.com:22/o/r` all become `github.com/o/r`. Credentials are
/// dropped so the result is safe to store and upload.
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        // scp-like syntax: [user@]host:path
        None => match url.split_once(':') {
            Some((host, path)) if !host.contains('/') => format!("{host}/{path}"),
            _ => return None, // a local path is not a shareable remote
        },
    };
    let (authority, path) = rest.split_once('/').unwrap_or((rest.as_str(), ""));
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next().unwrap_or(host);
    let path = path.trim_matches('/').trim_end_matches(".git");
    Some(if path.is_empty() {
        host.to_string()
    } else {
        format!("{host}/{path}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_remote_forms() {
        for url in [
            "git@github.com:KIvanow/sessionly.git",
            "https://github.com/KIvanow/sessionly.git",
            "https://user:ghp_secret@github.com/KIvanow/sessionly",
            "ssh://git@github.com:22/KIvanow/sessionly.git",
        ] {
            assert_eq!(
                normalize_remote(url).as_deref(),
                Some("github.com/KIvanow/sessionly"),
                "{url}"
            );
        }
        assert_eq!(normalize_remote(""), None);
        assert_eq!(normalize_remote("/home/me/repos/thing.git"), None);
        assert_eq!(normalize_remote("../thing"), None);
    }

    fn git(root: &Path, args: &[&str]) {
        let out = command(root)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    }

    #[test]
    fn a_name_there_is_none_of_is_told_from_no_answer() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "--quiet"]);
        let far = Instant::now() + Duration::from_secs(10);
        let look = |root: &Path, args: &[&str]| {
            let mut command = command(root);
            command.args(args);
            lookup(command, far)
        };
        // No commit yet: no HEAD, and no remote's either.
        assert_eq!(
            look(dir.path(), &["rev-parse", "--verify", "--quiet", "HEAD"]),
            Ok(None)
        );
        assert_eq!(
            look(
                dir.path(),
                &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]
            ),
            Ok(None)
        );
        git(
            dir.path(),
            &["commit", "--quiet", "--allow-empty", "-m", "x"],
        );
        let head = look(dir.path(), &["rev-parse", "--verify", "--quiet", "HEAD"]);
        assert_eq!(head.unwrap().map(|sha| sha.len()), Some(40));
        // Not a repository: no answer at all.
        let gone = dir.path().join("gone");
        assert_eq!(
            look(&gone, &["rev-parse", "--verify", "--quiet", "HEAD"]),
            Err(Stop::Failed)
        );
    }

    #[test]
    fn a_repository_is_the_same_from_each_of_its_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "--quiet"]);
        git(&main, &["commit", "--quiet", "--allow-empty", "-m", "x"]);
        let wt = dir.path().join("wt");
        git(&main, &["worktree", "add", "--quiet", wt.to_str().unwrap()]);
        let far = Instant::now() + Duration::from_secs(10);
        let common = main.join(".git").canonicalize().unwrap();
        assert_eq!(common_dir(&main, far), Ok(common.clone()));
        assert_eq!(common_dir(&wt, far), Ok(common.clone()));
        assert_eq!(common_dir(&dir.path().join("none"), far), Err(Stop::Failed));
        // What their `.git` says, as git says it; and nothing once a
        // worktree's own directory in the repository is gone.
        assert_eq!(named_common_dir(&main), Some(common.clone()));
        assert_eq!(named_common_dir(&wt), Some(common.clone()));
        assert_eq!(named_common_dir(&dir.path().join("none")), None);
        let name = wt.file_name().unwrap();
        std::fs::remove_dir_all(common.join("worktrees").join(name)).unwrap();
        assert_eq!(named_common_dir(&wt), None);
    }

    #[test]
    fn more_arguments_than_a_command_line_takes_is_too_large() {
        let mut command = Command::new("true");
        command.args(std::iter::repeat_n("x".repeat(1000), 16 * 1024));
        let far = Instant::now() + Duration::from_secs(10);
        assert_eq!(bounded(command, None, 10, far), Err(Stop::TooLarge));
    }

    #[cfg(unix)]
    #[test]
    fn the_deadline_holds_while_what_git_started_keeps_its_output_open() {
        let dir = tempfile::tempdir().unwrap();
        for (n, then) in ["exit 0", "sleep 30"].iter().enumerate() {
            // It starts one that goes on printing (a fetch, ssh), and ends or not.
            let pid = dir.path().join(format!("pid{n}"));
            let mut command = Command::new("sh");
            command.args([
                "-c",
                &format!("sleep 30 & echo $! > {}; {then}", pid.display()),
            ]);
            let started = Instant::now();
            let result = bounded(command, None, 1024, started + Duration::from_secs(1));
            assert_eq!(result, Err(Stop::TimedOut), "{then}");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{then}: {:?}",
                started.elapsed()
            );
            // And that one is stopped too.
            let pid: i32 = std::fs::read_to_string(&pid)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let gone = (0..200).any(|_| {
                std::thread::sleep(Duration::from_millis(10));
                unsafe { libc::kill(pid, 0) != 0 }
            });
            assert!(gone, "{then}: what it started goes on");
        }
    }

    /// As `main` has it, a write to a pipe nobody reads ends the process:
    /// so this one runs in a process of its own.
    #[cfg(unix)]
    #[test]
    fn git_that_stops_reading_what_it_is_given_ends_nothing_else() {
        const CHILD: &str = "SESSIONLY_TEST_SIGPIPE";
        if std::env::var_os(CHILD).is_some() {
            unsafe {
                libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            }
            let input = vec![b'0'; 4 << 20];
            let far = Instant::now() + Duration::from_secs(10);
            let _ = bounded(Command::new("true"), Some(&input), 10, far);
            std::thread::sleep(Duration::from_millis(300));
            return;
        }
        let out = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "git::tests::git_that_stops_reading_what_it_is_given_ends_nothing_else",
                "--test-threads=1",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "{:?}", out.status);
        assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
    }

    #[test]
    fn finds_repo_root_from_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(repo_root(&sub), Some(dir.path().to_path_buf()));
    }
}
