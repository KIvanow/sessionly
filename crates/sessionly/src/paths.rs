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

/// Raw hook payloads captured from Claude Code, one JSONL file per session.
pub fn claude_raw_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("raw").join("claude-code"))
}

/// Sessions rebuilt from transcripts by `sessionly import`, in the same
/// format as the raw capture.
pub fn claude_imported_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("imported").join("claude-code"))
}

/// What we last read from each session's transcript, kept so cost survives
/// the transcript being deleted.
pub fn claude_facts_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("transcript-facts").join("claude-code"))
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
