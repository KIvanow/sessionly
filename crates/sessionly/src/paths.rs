use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// The user's home directory. `None` if it can't be determined: we never fall
/// back to the current directory, which could put captured prompts and file
/// contents inside a project.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Root of all local Sessionly data: `$SESSIONLY_HOME`, or `~/.sessionly`.
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("SESSIONLY_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(home_dir()
        .context("cannot find the home directory (HOME is not set); set SESSIONLY_HOME")?
        .join(".sessionly"))
}

/// The agents sessions can come from. Each has its own folders.
pub const CLAUDE_CODE: &str = "claude-code";
pub const CURSOR: &str = "cursor";
pub const GROK: &str = "grok";
pub const CODEX: &str = "codex";
pub const OPENCODE: &str = "opencode";
pub const SOURCES: &[&str] = &[CLAUDE_CODE, CURSOR, GROK, CODEX, OPENCODE];

/// Where Codex keeps its settings and sessions: `$CODEX_HOME`, or `~/.codex`.
pub fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))
}

/// OpenCode's database: `$OPENCODE_DB`, or `$XDG_DATA_HOME/opencode/opencode.db`,
/// or `~/.local/share/opencode/opencode.db`.
pub fn opencode_db() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OPENCODE_DB").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".local").join("share")))?;
    Some(data.join("opencode").join("opencode.db"))
}

/// Folder holding every agent's raw hook payloads.
pub fn raw_root() -> Result<PathBuf> {
    Ok(data_dir()?.join("raw"))
}

/// Raw hook payloads captured from one agent, one JSONL file per session.
pub fn raw_dir(source: &str) -> Result<PathBuf> {
    Ok(raw_root()?.join(source))
}

/// Local settings: machine id, server, upload policy.
pub fn config_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("config.json"))
}

/// Normalized sessions.
pub fn ledger_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("ledger.db"))
}

/// Create a directory (and its parents) readable only by the owner.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)
}
