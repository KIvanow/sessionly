//! Minimal git helpers: repository root, credential-free remote, and user identity.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Walk up from `dir` to the directory containing `.git` (a directory, or a
/// file for worktrees and submodules).
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

fn config(dir: &Path, key: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    if dir.is_dir() {
        cmd.arg("-C").arg(dir);
    }
    let out = cmd.args(["config", "--get", key]).output().ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !value.is_empty()).then_some(value)
}

/// `origin` remote of the repository at `root`, as `host/owner/repo`.
pub fn origin_remote(root: &Path) -> Option<String> {
    normalize_remote(&config(root, "remote.origin.url")?)
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
            _ => return Some(url.trim_end_matches(".git").to_string()), // local path
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
