//! Hook entry point: append the raw Claude Code hook payload to the local ledger.
//!
//! Claude Code runs this on every hook event, so it has to be fast and silent.
//! It never prints: Claude Code reads a hook's stdout, and for some events
//! (SessionStart, UserPromptSubmit, PreCompact, PostModelSwitch) that output is
//! fed to the model. Failures are logged to `_errors.log` and never surface as a
//! non-zero exit, so a capture problem can't block the user's session.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

/// Version of the raw record envelope written to disk.
pub const RECORD_VERSION: u64 = 1;

/// Wrap a raw hook payload in the envelope stored on disk.
pub fn build_record(raw: &str, received_at: &str) -> Value {
    let payload = match serde_json::from_str::<Value>(raw) {
        Ok(v @ Value::Object(_)) => v,
        Ok(other) => json!({ "_unparsed": other }),
        Err(_) => json!({ "_unparsed": raw }),
    };
    let hook = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();
    let session_id = payload.get("session_id").cloned().unwrap_or(Value::Null);
    json!({
        "v": RECORD_VERSION,
        "source": "claude-code",
        "received_at": received_at,
        "hook": hook,
        "session_id": session_id,
        "payload": payload,
    })
}

/// File name for a session's raw log; anything outside `[A-Za-z0-9_-]` is dropped.
pub fn file_stem(session_id: Option<&str>) -> String {
    let stem: String = session_id
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if stem.is_empty() {
        "_unknown".to_string()
    } else {
        stem
    }
}

/// Read one payload from `input` and append it to `raw_dir/<session_id>.jsonl`.
pub fn capture(raw_dir: &Path, input: &mut impl Read, received_at: &str) -> Result<PathBuf> {
    let mut raw = String::new();
    input.read_to_string(&mut raw)?;
    let record = build_record(&raw, received_at);
    let stem = file_stem(record["session_id"].as_str());
    let path = raw_dir.join(format!("{stem}.jsonl"));
    let mut line = serde_json::to_string(&record)?;
    line.push('\n');
    append(&path, line.as_bytes())?;
    Ok(path)
}

/// Hook entry point. Always returns exit code 0.
pub fn run() -> i32 {
    let received_at = Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true);
    let raw_dir = crate::paths::claude_raw_dir();
    if let Err(err) = capture(&raw_dir, &mut std::io::stdin().lock(), &received_at) {
        let _ = append(
            &raw_dir.join("_errors.log"),
            format!("{received_at} {err:#}\n").as_bytes(),
        );
    }
    0
}

/// Append `bytes` under an exclusive lock, so parallel hook calls never interleave.
fn append(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        create_private_dir(dir)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file: File = options.open(path)?;
    file.lock()?;
    file.write_all(bytes)?;
    Ok(())
}

fn create_private_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_payload_with_hook_and_session() {
        let record = build_record(
            r#"{"session_id":"abc","hook_event_name":"Stop","x":1}"#,
            "2026-01-01T00:00:00Z",
        );
        assert_eq!(record["v"], 1);
        assert_eq!(record["hook"], "Stop");
        assert_eq!(record["session_id"], "abc");
        assert_eq!(record["payload"]["x"], 1);
    }

    #[test]
    fn keeps_unparseable_input() {
        let record = build_record("not json", "t");
        assert_eq!(record["hook"], "?");
        assert_eq!(record["session_id"], Value::Null);
        assert_eq!(record["payload"]["_unparsed"], "not json");
    }

    #[test]
    fn file_stem_strips_path_tricks() {
        assert_eq!(file_stem(Some("../../etc/passwd")), "etcpasswd");
        assert_eq!(file_stem(Some("5233c02a-28f3")), "5233c02a-28f3");
        assert_eq!(file_stem(None), "_unknown");
        assert_eq!(file_stem(Some("/..")), "_unknown");
    }

    #[test]
    fn appends_one_line_per_call() {
        let dir = tempfile::tempdir().unwrap();
        let payload = br#"{"session_id":"s1","hook_event_name":"PreToolUse"}"#;
        capture(dir.path(), &mut &payload[..], "t1").unwrap();
        let path = capture(dir.path(), &mut &payload[..], "t2").unwrap();
        let text = fs::read_to_string(path).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["received_at"], "t2");
    }
}
