use std::path::PathBuf;

/// Root of all local Sessionly data: `$SESSIONLY_HOME`, or `~/.sessionly`.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SESSIONLY_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    home_dir().join(".sessionly")
}

/// Raw hook payloads captured from Claude Code, one JSONL file per session.
pub fn claude_raw_dir() -> PathBuf {
    data_dir().join("raw").join("claude-code")
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
