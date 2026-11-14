//! What a shell command changed.
//!
//! An agent's file tools say what they changed. A shell command does not, and
//! in a cloud sandbox agents often edit with the shell (`sed -i`, a heredoc),
//! so a session there could show no changed file at all. This module looks at
//! the working tree just before a shell command runs and again just after,
//! and stores what differs with the command's event: the files, and the lines
//! added and removed.
//!
//! The working tree is read with git, into an index and an object directory
//! kept under the data directory. The repository's own index, objects and
//! HEAD are never written.
//!
//! This is done only in a sandbox (see `runtime`), where the agent is the
//! only one working. On a person's machine whatever the person saved while a
//! command ran would be put down to the agent.
//!
//! Deliberate limits:
//! - A command that moves HEAD to commits it did not make itself (`git pull`,
//!   `git checkout main`, a rebase) is not counted: what it brought in is
//!   other people's work.
//! - What git itself restores with HEAD staying put (`git stash pop`,
//!   `git checkout <branch> -- <file>`) counts as the command's.
//! - A command that carries on in the background is counted up to when the
//!   call returned.
//! - Files git ignores are not looked at. New files over 1 MB are left out.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The shell tool as Claude Code and as Cursor name it.
const SHELL_TOOLS: &[&str] = &["Bash", "Shell"];

/// How long looking at the working tree may take for one event. A hook must
/// not stall the session: past this, the look is abandoned and no more are
/// tried in that session.
const BUDGET: Duration = Duration::from_secs(5);

/// A comparison longer than this is not stored.
const MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;

/// New files larger than this are left out, and so are new files past this many at once.
const MAX_NEW_FILE_BYTES: u64 = 1024 * 1024;
const MAX_NEW_FILES: usize = 2000;

const LOCK_WAIT: Duration = Duration::from_secs(3);

/// What is remembered between the events of one session.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    /// The repository this is about.
    root: String,
    /// The working tree as last seen, as a git tree.
    tree: Option<String>,
    /// The commit that was checked out then.
    head: Option<String>,
    /// When a shell command last began, in seconds.
    at: u64,
    /// Shell commands that have begun and not ended.
    open: u32,
    /// Looking took too long once: it is not tried again.
    gave_up: bool,
}

#[derive(Debug, PartialEq)]
enum Stop {
    Failed,
    TimedOut,
    TooLarge,
}

/// Called with each captured event in a sandbox. For a shell command's start
/// it notes the working tree; for its end it answers what to store with the
/// event: `{"changes": [{"path", "status", "lines"}]}`, or
/// `{"changes_skipped": "<why>"}` when a change was seen and not counted.
/// `lines` are patch lines, `+added` and `-removed`.
pub fn observe(data_dir: &Path, record: &Value) -> Option<Value> {
    let p = &record["payload"];
    let ended = match record["hook"].as_str()?.to_lowercase().as_str() {
        "pretooluse" => false,
        "posttooluse" | "posttoolusefailure" => true,
        _ => return None,
    };
    if !SHELL_TOOLS.contains(&p["tool_name"].as_str()?) {
        return None;
    }
    let cwd = [&p["cwd"], &p["workspace_roots"][0]]
        .into_iter()
        .find_map(|v| v.as_str().filter(|dir| !dir.is_empty()))?;
    let root = crate::git::repo_root(Path::new(cwd))?;
    let stem = crate::capture::file_stem(record["session_id"].as_str());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    step(&data_dir.join("snapshots").join(stem), &root, ended, now)
}

/// One event of a shell command, in the repository at `root`, with `dir` to
/// keep what is remembered. `ended` is false for the command's start.
fn step(dir: &Path, root: &Path, ended: bool, now: u64) -> Option<Value> {
    crate::paths::create_private_dir(dir).ok()?;
    // Hooks run in parallel: one at a time looks at the tree.
    let lock = File::create(dir.join("lock")).ok()?;
    let deadline = Instant::now() + LOCK_WAIT;
    while lock.try_lock().is_err() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    let state_path = dir.join("state.json");
    let mut state: State = fs::read_to_string(&state_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    if state.gave_up {
        return None;
    }
    let root_text = root.to_string_lossy();
    if state.root != root_text {
        // Another repository than last time: start over.
        let _ = fs::remove_file(dir.join("index"));
        state = State {
            root: root_text.into_owned(),
            ..State::default()
        };
    }

    let git = Git {
        root,
        dir,
        deadline: Instant::now() + BUDGET,
    };
    let before = state.tree.take();
    let head_before = state.head.take();
    let mut said = None;
    match git.snapshot() {
        Ok((tree, head)) => {
            // Only what changed while a shell command ran is the command's:
            // without its start having been seen, the last look may be from
            // before an edit a file tool made.
            if let Some(from) = before.filter(|from| ended && state.open > 0 && *from != tree) {
                let moved = head_before != head;
                said = Some(
                    if moved && !git.made_since(head_before.as_deref(), head.as_deref(), state.at) {
                        json!({ "changes_skipped": "the commit checked out changed" })
                    } else {
                        match git.diff(&from, &tree) {
                            Ok(files) if files.is_empty() => Value::Null,
                            Ok(files) => json!({ "changes": files }),
                            Err(Stop::TooLarge) => json!({ "changes_skipped": "too large" }),
                            Err(_) => json!({ "changes_skipped": "could not be compared" }),
                        }
                    },
                );
            }
            state.tree = Some(tree);
            state.head = head;
            if ended {
                state.open = state.open.saturating_sub(1);
            } else {
                state.open += 1;
                state.at = now;
            }
        }
        Err(stop) => {
            state.open = 0;
            state.gave_up = stop == Stop::TimedOut;
            if ended {
                said = Some(json!({ "changes_skipped": "the working tree could not be read" }));
            }
        }
    }
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = fs::write(&state_path, text);
    }
    said.filter(|said| !said.is_null())
}

/// Git, run in a repository with an index and an object directory of our own.
struct Git<'a> {
    root: &'a Path,
    /// Where the index and the objects are kept.
    dir: &'a Path,
    /// When to stop waiting for git.
    deadline: Instant,
}

impl Git<'_> {
    /// Run git and return what it printed, as far as it fits, and whether it
    /// all fit. `private` reads and writes our index and objects instead of
    /// the repository's.
    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        private: Option<&Path>,
    ) -> Result<(Vec<u8>, bool), Stop> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(self.root)
            .args(["-c", "core.fsmonitor=false"])
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(objects) = private {
            command
                .env("GIT_INDEX_FILE", self.dir.join("index"))
                .env("GIT_OBJECT_DIRECTORY", self.dir.join("objects"))
                .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects);
        }
        let mut child = command.spawn().map_err(|_| Stop::Failed)?;
        let mut stdout = child.stdout.take().ok_or(Stop::Failed)?;
        // Read while it runs, so a long answer cannot block it.
        let reader = std::thread::spawn(move || {
            let mut kept = Vec::new();
            let mut chunk = [0u8; 64 * 1024];
            let mut fits = true;
            while let Ok(n) = stdout.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let room = MAX_PATCH_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..n.min(room)]);
                fits &= n <= room;
            }
            (kept, fits)
        });
        if let Some(input) = input {
            let mut stdin = child.stdin.take().ok_or(Stop::Failed)?;
            let _ = stdin.write_all(input);
        }
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < self.deadline => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                gone => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(match gone {
                        Ok(_) => Stop::TimedOut,
                        Err(_) => Stop::Failed,
                    });
                }
            }
        };
        let (out, fits) = reader.join().map_err(|_| Stop::Failed)?;
        if status.success() {
            Ok((out, fits))
        } else {
            Err(Stop::Failed)
        }
    }

    fn text(&self, args: &[&str], private: Option<&Path>) -> Result<String, Stop> {
        let (out, _) = self.run(args, None, private)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }

    /// The working tree as it is now, as a git tree, and the commit checked
    /// out. Files git ignores are left out; files not yet added are in.
    fn snapshot(&self) -> Result<(String, Option<String>), Stop> {
        let paths = self.text(
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "index",
                "--git-path",
                "objects",
            ],
            None,
        )?;
        let (index, objects) = paths.split_once('\n').ok_or(Stop::Failed)?;
        let objects = Path::new(objects.trim());
        fs::create_dir_all(self.dir.join("objects")).map_err(|_| Stop::Failed)?;
        // Our index starts as a copy of the repository's, so git knows which
        // files it has already read. From then on it is the last tree seen.
        let ours = self.dir.join("index");
        if !ours.exists() && Path::new(index).is_file() {
            fs::copy(index, &ours).map_err(|_| Stop::Failed)?;
        }
        let private = Some(objects);
        self.run(&["add", "--update", "--ignore-errors"], None, private)?;
        let (others, _) = self.run(
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
            private,
        )?;
        let mut new: Vec<u8> = Vec::new();
        others
            .split(|byte| *byte == 0)
            .filter_map(|name| std::str::from_utf8(name).ok())
            // A name ending in a slash is another repository inside this one.
            .filter(|name| !name.is_empty() && !name.ends_with('/'))
            .filter(|name| {
                fs::symlink_metadata(self.root.join(name))
                    .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_NEW_FILE_BYTES)
            })
            .take(MAX_NEW_FILES)
            .for_each(|name| {
                new.extend_from_slice(name.as_bytes());
                new.push(0);
            });
        if !new.is_empty() {
            self.run(
                &["update-index", "--add", "-z", "--stdin"],
                Some(&new),
                private,
            )?;
        }
        let tree = self.text(&["write-tree"], private)?;
        let head = self.text(&["rev-parse", "--verify", "--quiet", "HEAD"], None);
        Ok((tree, head.ok().filter(|head| !head.is_empty())))
    }

    /// Whether the commits that took HEAD from `from` to `to` were all made
    /// at or after `since` (in seconds): the command committed its own work.
    /// Anything else moved HEAD to work that was already there.
    fn made_since(&self, from: Option<&str>, to: Option<&str>, since: u64) -> bool {
        let Some(to) = to else { return false };
        if let Some(from) = from {
            if self
                .run(&["merge-base", "--is-ancestor", from, to], None, None)
                .is_err()
            {
                return false;
            }
        }
        let range = from.map_or(to.to_string(), |from| format!("{from}..{to}"));
        let Ok(listed) = self.text(
            &["rev-list", "--max-count=500", "--format=%ct", &range],
            None,
        ) else {
            return false;
        };
        let times: Vec<u64> = listed.lines().filter_map(|l| l.parse().ok()).collect();
        // A clock read a moment apart on each side may differ by a second.
        times.len() < 500 && times.iter().all(|at| at + 2 >= since)
    }

    /// What differs between two trees: one entry per file, with its patch lines.
    fn diff(&self, from: &str, to: &str) -> Result<Vec<Value>, Stop> {
        let objects = self.text(
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
            None,
        )?;
        let private = Some(Path::new(&objects));
        let compare = ["diff-tree", "-r", "-M", "--no-ext-diff", "--no-textconv"];
        let (names, fits) = self.run(
            &[&compare[..], &["-z", "--name-status", from, to]].concat(),
            None,
            private,
        )?;
        if !fits {
            return Err(Stop::TooLarge);
        }
        let (patch, fits) = self.run(
            &[&compare[..], &["-p", "-U0", "--no-color", from, to]].concat(),
            None,
            private,
        )?;
        if !fits {
            return Err(Stop::TooLarge);
        }
        let mut lines = patch_lines(&String::from_utf8_lossy(&patch)).into_iter();
        let files = name_status(&names);
        // Both list the files in the same order. Should they ever not agree,
        // the files are still known, without their lines.
        let agree = lines.len() == files.len();
        Ok(files
            .into_iter()
            .map(|(status, path)| {
                let lines = lines.next().filter(|_| agree).unwrap_or_default();
                json!({
                    "path": self.root.join(path).to_string_lossy(),
                    "status": status,
                    "lines": lines,
                })
            })
            .collect())
    }
}

/// The files of `git diff-tree -z --name-status`: a status letter and the
/// path. A renamed file is listed under its new name.
fn name_status(out: &[u8]) -> Vec<(String, String)> {
    let mut fields = out
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut files = Vec::new();
    while let Some(status) = fields.next().filter(|status| !status.is_empty()) {
        let letter = status[..1].to_string();
        // A rename or a copy names two paths: where from, then where to.
        if matches!(letter.as_str(), "R" | "C") {
            fields.next();
        }
        let Some(path) = fields.next() else { break };
        files.push((letter, path));
    }
    files
}

/// The added and removed lines of each file in a patch, as `+line` and
/// `-line`, one list per file in the patch's order.
fn patch_lines(patch: &str) -> Vec<Vec<String>> {
    let mut files: Vec<Vec<String>> = Vec::new();
    let mut in_hunk = false;
    for line in patch.lines() {
        // Inside a hunk every line begins with `+`, `-`, a space or a
        // backslash, so these two can only be the patch's own.
        if line.starts_with("diff --git ") {
            files.push(Vec::new());
            in_hunk = false;
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && (line.starts_with('+') || line.starts_with('-')) {
            if let Some(file) = files.last_mut() {
                file.push(line.to_string());
            }
        }
    }
    files
}

/// The files a shell command's event says it changed: path, whether the file
/// is new, and its patch lines.
pub fn of(record: &Value) -> impl Iterator<Item = (&str, bool, impl Iterator<Item = &str>)> {
    record["changes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            let lines = file["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            Some((file["path"].as_str()?, file["status"] == "A", lines))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Repo {
        _home: tempfile::TempDir,
        root: PathBuf,
        dir: PathBuf,
        /// The time, in seconds: each command begins later than the last.
        now: std::cell::Cell<u64>,
    }

    impl Repo {
        fn new() -> Repo {
            let home = tempfile::tempdir().unwrap();
            let root = home.path().join("repo");
            fs::create_dir_all(&root).unwrap();
            let repo = Repo {
                dir: home.path().join("snapshots/s1"),
                _home: home,
                root,
                now: std::cell::Cell::new(1_700_000_000),
            };
            repo.git(&["init", "--quiet", "--initial-branch", "main"]);
            repo.write(".gitignore", "target/\n");
            repo.write(
                "hello.py",
                "def greet(name):\n    return \"hello \" + name\n",
            );
            repo.write("old.txt", "one\ntwo\n");
            repo.commit("first");
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args([
                    "-c",
                    "user.name=Agent",
                    "-c",
                    "user.email=agent@example.com",
                ])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        /// Commit everything, at the time it is now.
        fn commit(&self, message: &str) {
            self.git(&["add", "--all"]);
            let date = format!("@{} +0000", self.now.get());
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args([
                    "-c",
                    "user.name=Agent",
                    "-c",
                    "user.email=agent@example.com",
                ])
                .args(["-c", "commit.gpgsign=false"])
                .args(["commit", "--quiet", "-m", message])
                .env("GIT_COMMITTER_DATE", &date)
                .env("GIT_AUTHOR_DATE", &date)
                .output()
                .unwrap();
            assert!(out.status.success(), "{out:?}");
        }

        fn write(&self, name: &str, content: &str) {
            let path = self.root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        /// A shell command's start, then `during`, then what its end answers.
        fn command(&self, during: impl FnOnce()) -> Option<Value> {
            self.now.set(self.now.get() + 100);
            assert_eq!(step(&self.dir, &self.root, false, self.now.get()), None);
            during();
            step(&self.dir, &self.root, true, self.now.get() + 1)
        }

        /// The changed files as (name, status, lines).
        fn changes(&self, said: Option<Value>) -> Vec<(String, String, Vec<String>)> {
            let said = said.expect("nothing was said");
            let prefix = format!("{}/", self.root.display());
            said["changes"]
                .as_array()
                .unwrap_or_else(|| panic!("{said}"))
                .iter()
                .map(|file| {
                    let lines = file["lines"].as_array().unwrap().iter();
                    (
                        file["path"].as_str().unwrap().replace(&prefix, ""),
                        file["status"].as_str().unwrap().to_string(),
                        lines.map(|l| l.as_str().unwrap().to_string()).collect(),
                    )
                })
                .collect()
        }
    }

    fn file(name: &str, status: &str, lines: &[&str]) -> (String, String, Vec<String>) {
        (
            name.to_string(),
            status.to_string(),
            lines.iter().map(|l| l.to_string()).collect(),
        )
    }

    #[test]
    fn what_a_shell_command_changed_is_told_and_the_repository_is_left_alone() {
        let repo = Repo::new();
        let objects = || repo.git(&["count-objects", "-v"]);
        let (status, before) = (repo.git(&["status", "--porcelain"]), objects());
        let said = repo.command(|| {
            repo.write(
                "hello.py",
                "def greet(name):\n    \"\"\"Greet.\"\"\"\n    return \"hello \" + name\n",
            );
            repo.write("src/new.py", "print(1)\nprint(2)\n");
            repo.write("target/built.o", "not looked at\n");
            fs::remove_file(repo.root.join("old.txt")).unwrap();
        });
        assert_eq!(
            repo.changes(said),
            [
                file("hello.py", "M", &["+    \"\"\"Greet.\"\"\""]),
                file("old.txt", "D", &["-one", "-two"]),
                file("src/new.py", "A", &["+print(1)", "+print(2)"]),
            ]
        );
        // Nothing was staged and no object was written to the repository.
        assert_eq!(repo.git(&["status", "--porcelain"]).lines().count(), 3);
        assert_ne!(repo.git(&["status", "--porcelain"]), status);
        assert_eq!(objects(), before);
        assert!(repo.git(&["diff", "--cached", "--name-only"]).is_empty());

        // A command that changes nothing says nothing.
        assert_eq!(repo.command(|| {}), None);
    }

    #[test]
    fn only_what_changed_while_a_command_ran_is_the_commands() {
        let repo = Repo::new();
        assert_eq!(repo.command(|| {}), None);
        // A file tool's edit, between two commands: it reports itself.
        repo.write("hello.py", "edited by a file tool\n");
        let said = repo.command(|| repo.write("old.txt", "one\ntwo\nthree\n"));
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["+three"])]);

        // An end whose start was not seen: nothing can be said of it.
        repo.write("hello.py", "edited again\n");
        assert_eq!(step(&repo.dir, &repo.root, true, repo.now.get() + 20), None);
        // The next command is seen whole again.
        let said = repo.command(|| repo.write("old.txt", "one\n"));
        assert_eq!(
            repo.changes(said),
            [file("old.txt", "M", &["-two", "-three"])]
        );
    }

    #[test]
    fn a_commit_the_command_made_counts_and_one_it_moved_to_does_not() {
        let repo = Repo::new();
        // Edit and commit in one command.
        let said = repo.command(|| {
            repo.git(&["checkout", "--quiet", "-b", "work"]);
            repo.write("old.txt", "one\ntwo\nmine\n");
            repo.commit("mine");
        });
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["+mine"])]);

        // Back to the branch it came from: those lines are not new work,
        // and nor are another branch's when it is checked out.
        let said = repo.command(|| {
            repo.git(&["checkout", "--quiet", "main"]);
        });
        assert_eq!(
            said,
            Some(json!({ "changes_skipped": "the commit checked out changed" }))
        );
        let said = repo.command(|| {
            repo.git(&["merge", "--quiet", "--ff-only", "work"]);
        });
        assert_eq!(
            said,
            Some(json!({ "changes_skipped": "the commit checked out changed" }))
        );

        // A rename is one file, with the lines that changed in it.
        let said = repo.command(|| {
            repo.git(&["mv", "hello.py", "greeting.py"]);
        });
        assert_eq!(repo.changes(said), [file("greeting.py", "R", &[])]);
    }

    #[test]
    fn reads_the_files_and_lines_of_a_comparison() {
        assert_eq!(
            name_status(b"M\0a b.txt\0R090\0old.rs\0new.rs\0A\0c.txt\0"),
            [
                ("M".to_string(), "a b.txt".to_string()),
                ("R".to_string(), "new.rs".to_string()),
                ("A".to_string(), "c.txt".to_string()),
            ]
        );
        let patch = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n\
                     -old\n+new\n+++ not a header\n\\ No newline at end of file\n\
                     diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n";
        assert_eq!(
            patch_lines(patch),
            [vec!["-old", "+new", "+++ not a header"], vec![]]
        );
    }

    #[test]
    fn only_shell_commands_in_a_repository_are_looked_at() {
        let repo = Repo::new();
        let data = repo.dir.parent().unwrap().parent().unwrap();
        let event = |hook: &str, tool: &str, cwd: &Path| {
            json!({ "hook": hook, "session_id": "s1",
                    "payload": { "tool_name": tool, "cwd": cwd } })
        };
        assert_eq!(
            observe(data, &event("PreToolUse", "Edit", &repo.root)),
            None
        );
        assert_eq!(observe(data, &event("Stop", "Bash", &repo.root)), None);
        assert_eq!(
            observe(data, &event("PreToolUse", "Bash", Path::new("/"))),
            None
        );
        assert!(!repo.dir.exists());

        // Cursor names the events and the tool its own way, and the folder too.
        let cursor = |hook: &str| {
            json!({ "hook": hook, "session_id": "s1",
                    "payload": { "tool_name": "Shell", "cwd": "", "workspace_roots": [repo.root] } })
        };
        assert_eq!(observe(data, &cursor("preToolUse")), None);
        repo.write("old.txt", "one\n");
        let said = observe(data, &cursor("postToolUseFailure"));
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["-two"])]);
    }
}
