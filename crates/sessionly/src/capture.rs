//! Hook entry point: append the raw Claude Code hook payload to the local ledger.
//!
//! Claude Code runs this on every hook event, so it has to be fast and silent.
//! It never prints: Claude Code reads a hook's stdout, and for some events
//! (SessionStart, UserPromptSubmit, PreCompact, PostModelSwitch) that output is
//! fed to the model. Failures are logged to `_errors.log` and never surface as a
//! non-zero exit, so a capture problem can't block the user's session.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

/// Version of the raw record envelope written to disk.
pub const RECORD_VERSION: u64 = 1;

/// How long to wait for another capture to release the file before writing anyway.
const LOCK_WAIT: Duration = Duration::from_millis(1500);

/// Which agent sent a hook payload. Cursor and Grok both run hooks written
/// for Claude Code (they read `~/.claude/settings.json`), and Codex sends
/// payloads of the same shape from its own hooks file, so one capture
/// command hears from all four and has to tell them apart by the payload.
pub fn detect_source(payload: &Value) -> &'static str {
    let has = |key: &str| payload.get(key).is_some();
    let transcript = payload["transcript_path"].as_str().unwrap_or_default();
    if has("cursor_version") || has("conversation_id") || transcript.contains("/.cursor/") {
        crate::paths::CURSOR
    } else if has("workspaceRoot") || has("hookEventName") || transcript.contains("/.grok/") {
        crate::paths::GROK
    } else if is_codex_rollout(transcript) || (transcript.is_empty() && has("turn_id")) {
        crate::paths::CODEX
    } else {
        crate::paths::CLAUDE_CODE
    }
}

/// Codex's `transcript_path` can be null, as for a session with no rollout
/// file; its payloads then still say which turn they belong to (`turn_id`).
///
/// True for the path of a Codex session file: `…/rollout-<time>-<thread>.jsonl`,
/// wherever `CODEX_HOME` puts it.
fn is_codex_rollout(transcript: &str) -> bool {
    let name = transcript.rsplit(['/', '\\']).next().unwrap_or_default();
    name.starts_with("rollout-") || transcript.contains("/.codex/")
}

/// Wrap a raw hook payload in the envelope stored on disk. A payload that
/// isn't a JSON object is kept as text under `_unparsed`, still filed under
/// its session when the id can be found.
pub fn build_record(raw: &str, received_at: &str) -> Value {
    let (payload, hook, session_id, source) = match serde_json::from_str::<Value>(raw) {
        Ok(v @ Value::Object(_)) => {
            let text = |key: &str| v.get(key).and_then(Value::as_str);
            let hook = text("hook_event_name").or(text("hookEventName"));
            let hook = hook.unwrap_or("?").to_string();
            let session_id = ["session_id", "conversation_id", "sessionId"]
                .iter()
                .find_map(|key| v.get(*key).filter(|id| id.is_string()))
                .cloned()
                .unwrap_or(Value::Null);
            let source = detect_source(&v);
            (v, hook, session_id, source)
        }
        _ => (
            json!({ "_unparsed": raw }),
            find_string_field(raw, "hook_event_name").unwrap_or_else(|| "?".into()),
            find_string_field(raw, "session_id").map_or(Value::Null, Value::String),
            crate::paths::CLAUDE_CODE,
        ),
    };
    json!({
        "v": RECORD_VERSION,
        "source": source,
        "received_at": received_at,
        "hook": hook,
        "session_id": session_id,
        "payload": payload,
    })
}

/// Best-effort `"key": "value"` lookup in text that failed to parse as JSON.
fn find_string_field(raw: &str, key: &str) -> Option<String> {
    let after_key = &raw[raw.find(&format!("\"{key}\""))? + key.len() + 2..];
    let value = after_key.trim_start().strip_prefix(':')?.trim_start();
    let value = value.strip_prefix('"')?;
    let end = value.find('"')?;
    let found = &value[..end];
    (!found.is_empty() && !found.contains('\\')).then(|| found.to_string())
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

/// Read one payload from `input` and append it to
/// `raw_root/<agent>/<session_id>.jsonl`. Returns the file written and the
/// hook event's name.
///
/// `surroundings` may add to the record what only the place it runs in
/// knows (see [`in_a_sandbox`]). On a person's own machine it adds nothing.
pub fn capture(
    raw_root: &Path,
    input: &mut impl Read,
    received_at: &str,
    surroundings: impl Fn(&mut Value),
) -> Result<(PathBuf, String)> {
    let mut bytes = Vec::new();
    input.read_to_end(&mut bytes)?;
    let mut record = build_record(&String::from_utf8_lossy(&bytes), received_at);
    let stem = file_stem(record["session_id"].as_str());
    let source = record["source"]
        .as_str()
        .unwrap_or(crate::paths::CLAUDE_CODE)
        .to_string();
    let source = source.as_str();
    surroundings(&mut record);
    let path = raw_root.join(source).join(format!("{stem}.jsonl"));
    let mut line = serde_json::to_string(&record)?;
    line.push('\n');
    append(&path, line.as_bytes())?;
    let hook = record["hook"].as_str().unwrap_or("?").to_string();
    Ok((path, hook))
}

/// What a cloud agent's sandbox adds to a record: under `runtime`, what the
/// platform says about the session (see `runtime`), and for a shell command
/// what it changed in the working tree (see `changes`).
fn in_a_sandbox(record: &mut Value) {
    let text = |key: &str| record[key].as_str().unwrap_or_default().to_string();
    let Some(said) = crate::runtime::describe(&text("source"), &text("hook")) else {
        return;
    };
    record["runtime"] = said;
    let Ok(data_dir) = crate::paths::data_dir() else {
        return;
    };
    if let Some(Value::Object(seen)) = crate::changes::observe(&data_dir, record) {
        for (key, value) in seen {
            record[key] = value;
        }
    }
}

/// Hook entry point. Always returns exit code 0 and never prints.
pub fn run() -> i32 {
    let received_at = Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true);
    // No home directory: nowhere safe to write. Still read the payload, so
    // the process feeding it to us doesn't hit a closed pipe.
    let Ok(raw_dir) = crate::paths::raw_root() else {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
        return 0;
    };
    match capture(
        &raw_dir,
        &mut std::io::stdin().lock(),
        &received_at,
        in_a_sandbox,
    ) {
        Ok((_, hook)) => {
            if let Ok(data_dir) = crate::paths::data_dir() {
                crate::auto::maybe_spawn(&hook, &data_dir);
            }
        }
        Err(err) => {
            let _ = append(
                &raw_dir.join("_errors.log"),
                format!("{received_at} {err:#}\n").as_bytes(),
            );
        }
    }
    0
}

/// Append `bytes` in one write, under an exclusive lock so parallel hook calls
/// never interleave. If the lock can't be had in time we write anyway: a hook
/// must not stall the session.
fn append(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        crate::paths::create_private_dir(dir)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file: File = options.open(path)?;
    let deadline = Instant::now() + LOCK_WAIT;
    while file.try_lock().is_err() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A session on a person's own machine: nothing is added.
    fn local(_record: &mut Value) {}

    #[test]
    fn what_a_cloud_platform_says_is_stored_with_the_event() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = |record: &mut Value| {
            let id = format!("{}/{}", record["source"], record["hook"]);
            record["runtime"] = json!({ "kind": "cloud", "id": id });
        };
        let payload = br#"{"session_id":"s1","hook_event_name":"Stop"}"#;
        let (path, _) = capture(dir.path(), &mut &payload[..], "t", cloud).unwrap();
        let record: Value =
            serde_json::from_str(fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert_eq!(
            record["runtime"],
            json!({ "kind": "cloud", "id": "\"claude-code\"/\"Stop\"" })
        );
        assert_eq!(
            record["payload"],
            json!({ "session_id": "s1", "hook_event_name": "Stop" })
        );

        capture(dir.path(), &mut &payload[..], "t", local).unwrap();
        let last: Value =
            serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap())
                .unwrap();
        assert_eq!(last.get("runtime"), None);
    }

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
    fn unparseable_payload_still_goes_to_its_session() {
        // a lone surrogate escape is invalid JSON for serde_json
        let raw = r#"{"session_id": "abc-1", "hook_event_name":"PostToolUse", "out":"\ud83d"}"#;
        let record = build_record(raw, "t");
        assert_eq!(record["session_id"], "abc-1");
        assert_eq!(record["hook"], "PostToolUse");
        assert_eq!(record["payload"]["_unparsed"], raw);
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
        capture(dir.path(), &mut &payload[..], "t1", local).unwrap();
        let (path, hook) = capture(dir.path(), &mut &payload[..], "t2", local).unwrap();
        assert_eq!(hook, "PreToolUse");
        let text = fs::read_to_string(path).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["received_at"], "t2");
    }

    #[test]
    fn files_each_agent_under_its_own_name() {
        let dir = tempfile::tempdir().unwrap();
        let cases: [(&str, &str, &str); 5] = [
            (
                r#"{"session_id":"c1","hook_event_name":"Stop","transcript_path":"/home/u/.claude/projects/p/c1.jsonl"}"#,
                "claude-code",
                "c1",
            ),
            // Grok sends Claude's field names and its own camel-case twins.
            (
                r#"{"session_id":"g1","sessionId":"g1","hook_event_name":"Stop","hookEventName":"Stop","workspaceRoot":"/w"}"#,
                "grok",
                "g1",
            ),
            (
                r#"{"conversation_id":"k1","hook_event_name":"stop","cursor_version":"2.0"}"#,
                "cursor",
                "k1",
            ),
            // A session with no rollout file has no path to tell it by.
            (
                r#"{"session_id":"x2","turn_id":"t1","hook_event_name":"Stop","transcript_path":null}"#,
                "codex",
                "x2",
            ),
            (
                r#"{"session_id":"x1","turn_id":"t1","hook_event_name":"Stop","transcript_path":"/data/codex/sessions/2026/11/16/rollout-2026-11-16T12-00-00-x1.jsonl"}"#,
                "codex",
                "x1",
            ),
        ];
        for (payload, source, id) in cases {
            let (path, _) = capture(dir.path(), &mut payload.as_bytes(), "t", local).unwrap();
            assert_eq!(path, dir.path().join(source).join(format!("{id}.jsonl")));
            let record: Value =
                serde_json::from_str(fs::read_to_string(path).unwrap().trim()).unwrap();
            assert_eq!(record["source"], source);
            assert_eq!(record["session_id"], id);
        }
    }

    #[test]
    fn non_utf8_input_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (path, _) = capture(dir.path(), &mut &b"\xff\xfe{"[..], "t", local).unwrap();
        assert!(path.ends_with("claude-code/_unknown.jsonl"));
        assert_eq!(fs::read_to_string(path).unwrap().lines().count(), 1);
    }

    #[test]
    fn a_held_lock_delays_but_does_not_block() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let holder = File::create(&path).unwrap();
        holder.lock().unwrap();
        let start = Instant::now();
        append(&path, b"line\n").unwrap();
        assert!(start.elapsed() < LOCK_WAIT + Duration::from_secs(2));
        assert_eq!(fs::read_to_string(&path).unwrap(), "line\n");
    }
}
