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
/// optional lock is taken, so it never gets in the way of the person's own git.
pub fn command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.fsmonitor=false"])
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

/// Run `command` and return what it printed, as far as `max_bytes`, and
/// whether it all fit. Past `deadline` it is killed.
pub fn bounded(
    mut command: Command,
    input: Option<&[u8]>,
    max_bytes: usize,
    deadline: Instant,
) -> Result<(Vec<u8>, bool), Stop> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
            let room = max_bytes.saturating_sub(kept.len());
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
            Ok(None) if Instant::now() < deadline => {
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

    #[test]
    fn finds_repo_root_from_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(repo_root(&sub), Some(dir.path().to_path_buf()));
    }
}
