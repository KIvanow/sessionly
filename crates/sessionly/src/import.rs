//! Backfill: rebuild a session's activity from Claude Code's transcript, for
//! sessions the hooks did not capture (or captured only partly).
//!
//! A transcript is turned into the same event records the capture hook
//! writes, so everything downstream (normalizing, rewrite rate, ledger) works
//! unchanged. The records are saved under `imported/`, which makes an imported
//! session as durable as a captured one: it survives the transcript being
//! deleted. Tool results are reduced to what normalizing needs, so the saved
//! file is far smaller than the transcript.
//!
//! What a transcript cannot tell us: permission prompts that were approved,
//! and when the session ended.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::transcript;

/// Rows a user row can be besides a prompt the person typed.
const NOT_A_PROMPT_PREFIXES: &[&str] = &[
    "<local-command-",
    "<command-name>",
    "<command-message>",
    "<task-notification",
    "<system-reminder",
    "[Request interrupted",
    "Caveat: ",
];

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// True for a user row that is something the person asked, not a tool result,
/// a notification or text Claude Code inserted.
fn is_prompt(row: &Value) -> bool {
    if row["isMeta"].as_bool() == Some(true) || row["isCompactSummary"].as_bool() == Some(true) {
        return false;
    }
    let content = &row["message"]["content"];
    let has_tool_result = content
        .as_array()
        .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"));
    if has_tool_result {
        return false;
    }
    match row["turnOrigin"].as_str() {
        Some("human" | "sdk") => true,
        Some(_) => false,
        // Older transcripts have no origin: go by what the text looks like.
        None => {
            let text = text_of(content);
            let text = text.trim_start();
            !text.is_empty() && !NOT_A_PROMPT_PREFIXES.iter().any(|p| text.starts_with(p))
        }
    }
}

/// A tool result reduced to what normalizing reads, plus its original size.
fn slim_result(result: &Value) -> Value {
    let mut slim = json!({ "_bytes": result.to_string().len() });
    for key in ["type", "structuredPatch", "interrupted"] {
        if let Some(value) = result.get(key) {
            slim[key] = value.clone();
        }
    }
    slim
}

struct Builder {
    session_id: String,
    events: Vec<(String, Value)>,
}

impl Builder {
    fn push(&mut self, at: &str, hook: &str, mut payload: Value) {
        payload["session_id"] = json!(self.session_id);
        payload["hook_event_name"] = json!(hook);
        self.events.push((
            at.to_string(),
            json!({
                "v": crate::capture::RECORD_VERSION,
                "source": "claude-code",
                "origin": "transcript",
                "received_at": at,
                "hook": hook,
                "session_id": self.session_id,
                "payload": payload,
            }),
        ));
    }
}

/// Read one transcript file (the main one, or a subagent's) into events.
fn read_file(
    path: &Path,
    agent: Option<(&str, Option<&str>)>,
    out: &mut Builder,
) -> Result<FileFacts> {
    let mut facts = FileFacts::default();
    // tool_use_id -> (name, input, timestamp)
    let mut calls: HashMap<String, (String, Value, String)> = HashMap::new();
    let mut prompt_id: Option<String> = None;
    // The turn in progress: its prompt id, and when the model last finished
    // an answer in it. Headless runs write no turn-duration row, so that
    // finish is the only sign the turn ended.
    let mut open_turn: Option<Value> = None;
    let mut answered_at: Option<String> = None;
    let with_agent = |mut payload: Value| {
        if let Some((id, kind)) = agent {
            payload["agent_id"] = json!(id);
            payload["agent_type"] = json!(kind.unwrap_or_default());
        }
        payload
    };

    crate::jsonl::for_each(path, |row| {
        let Some(at) = row["timestamp"].as_str() else {
            match row["type"].as_str() {
                Some("custom-title") => {
                    facts.custom_title = row["customTitle"].as_str().map(String::from)
                }
                Some("ai-title") => facts.ai_title = row["aiTitle"].as_str().map(String::from),
                _ => {}
            }
            return;
        };
        if facts.first_at.is_none() {
            facts.first_at = Some(at.to_string());
        }
        facts.last_at = Some(at.to_string());
        if facts.cwd.is_none() {
            facts.cwd = row["cwd"].as_str().map(String::from);
        }
        if let Some(id) = row["promptId"].as_str() {
            prompt_id = Some(id.to_string());
        }
        match row["type"].as_str() {
            Some("user") if is_prompt(&row) && agent.is_none() => {
                if let (Some(id), Some(done)) = (open_turn.take(), answered_at.take()) {
                    out.push(&done, "Stop", json!({ "prompt_id": id }));
                }
                open_turn = Some(row["promptId"].clone());
                answered_at = None;
                let mut payload = json!({
                    "prompt_id": row["promptId"],
                    "prompt": text_of(&row["message"]["content"]),
                });
                if let Some(mode) = row["permissionMode"].as_str() {
                    payload["permission_mode"] = json!(mode);
                }
                out.push(at, "UserPromptSubmit", payload);
            }
            Some("user") => {
                let blocks = row["message"]["content"].as_array();
                for block in blocks
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "tool_result")
                {
                    let Some(id) = block["tool_use_id"].as_str() else {
                        continue;
                    };
                    let Some((name, input, started)) = calls.remove(id) else {
                        continue;
                    };
                    let mut payload = with_agent(json!({
                        "prompt_id": prompt_id,
                        "tool_use_id": id,
                        "tool_name": name,
                        "tool_input": input,
                    }));
                    let elapsed = || {
                        let parse = |t: &str| chrono::DateTime::parse_from_rfc3339(t).ok();
                        Some((parse(at)? - parse(&started)?).num_milliseconds().max(0))
                    };
                    if let Some(ms) = elapsed() {
                        payload["duration_ms"] = json!(ms);
                    }
                    let error = text_of(&block["content"]);
                    let hook = match row["toolDenialKind"].as_str() {
                        Some("user-rejected") => "ToolRejected",
                        Some("automode-blocked" | "permission-rule") => {
                            payload["reason"] = json!(error);
                            "PermissionDenied"
                        }
                        Some("interrupted") => {
                            payload["error"] = json!(error);
                            payload["is_interrupt"] = json!(true);
                            "PostToolUseFailure"
                        }
                        _ if block["is_error"].as_bool() == Some(true) => {
                            payload["error"] = json!(error);
                            "PostToolUseFailure"
                        }
                        _ => {
                            payload["tool_response"] = slim_result(&row["toolUseResult"]);
                            "PostToolUse"
                        }
                    };
                    out.push(at, hook, payload);
                }
            }
            Some("assistant") => {
                if agent.is_none() && row["message"]["stop_reason"] == "end_turn" {
                    answered_at = Some(at.to_string());
                }
                let blocks = row["message"]["content"].as_array();
                for block in blocks
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "tool_use")
                {
                    let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str())
                    else {
                        continue;
                    };
                    let input = block["input"].clone();
                    calls.insert(
                        id.to_string(),
                        (name.to_string(), input.clone(), at.to_string()),
                    );
                    out.push(
                        at,
                        "PreToolUse",
                        with_agent(json!({
                            "prompt_id": prompt_id,
                            "tool_use_id": id,
                            "tool_name": name,
                            "tool_input": input,
                        })),
                    );
                }
            }
            Some("system") if agent.is_none() => match row["subtype"].as_str() {
                Some("turn_duration") => {
                    open_turn = None;
                    out.push(at, "Stop", json!({ "prompt_id": prompt_id }));
                }
                Some("compact_boundary") => out.push(at, "PostCompact", json!({})),
                _ => {}
            },
            _ => {}
        }
    })?;
    if let (Some(id), Some(done)) = (open_turn, answered_at) {
        out.push(&done, "Stop", json!({ "prompt_id": id }));
    }
    Ok(facts)
}

#[derive(Default)]
struct FileFacts {
    first_at: Option<String>,
    last_at: Option<String>,
    cwd: Option<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
}

/// The session's activity as capture records, in time order. Empty if the
/// transcript has no dated rows.
pub fn events_from_transcript(path: &Path) -> Result<Vec<Value>> {
    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut out = Builder {
        session_id,
        events: Vec::new(),
    };
    let main = read_file(path, None, &mut out)?;
    let Some(started) = main.first_at.clone() else {
        return Ok(Vec::new());
    };

    let subagent_dir = path.with_extension("").join("subagents");
    let mut files: Vec<PathBuf> = fs::read_dir(&subagent_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    for file in files {
        let stem = file
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let agent_id = stem.strip_prefix("agent-").unwrap_or(&stem).to_string();
        let meta: Value = fs::read_to_string(file.with_extension("meta.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        let agent_type = meta["agentType"].as_str();
        let facts = read_file(&file, Some((&agent_id, agent_type)), &mut out)?;
        let identity =
            json!({ "agent_id": agent_id, "agent_type": agent_type.unwrap_or_default() });
        if let (Some(first), Some(last)) = (facts.first_at, facts.last_at) {
            out.push(&first, "SubagentStart", identity.clone());
            out.push(&last, "SubagentStop", identity);
        }
    }

    let mut start = json!({
        "source": "startup",
        "transcript_path": path,
        // used to notice that the transcript has grown since the import
        "transcript_bytes": transcript::tree_size(path),
    });
    if let Some(cwd) = &main.cwd {
        start["cwd"] = json!(cwd);
    }
    if let Some(title) = main.custom_title.or(main.ai_title) {
        start["session_title"] = json!(title);
    }
    out.push(&started, "SessionStart", start);

    // Time order, with the session start first among equals. The sort is
    // stable, so events of one file keep their order.
    out.events.sort_by(|a, b| {
        let rank = |e: &Value| u8::from(e["hook"] != "SessionStart");
        a.0.cmp(&b.0).then(rank(&a.1).cmp(&rank(&b.1)))
    });
    Ok(out.events.into_iter().map(|(_, event)| event).collect())
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub imported: u64,
    pub up_to_date: u64,
    /// Transcripts with nothing to import.
    pub empty: u64,
    pub failed: Vec<(PathBuf, String)>,
}

/// The transcript path and size recorded in an import file's first record.
fn imported_from(import_file: &Path) -> Option<(PathBuf, u64)> {
    use std::io::BufRead;
    let mut line = String::new();
    std::io::BufReader::new(fs::File::open(import_file).ok()?)
        .read_line(&mut line)
        .ok()?;
    let record: Value = serde_json::from_str(&line).ok()?;
    let payload = &record["payload"];
    Some((
        PathBuf::from(payload["transcript_path"].as_str()?),
        payload["transcript_bytes"].as_u64()?,
    ))
}

/// Write `events` as an import file, replacing any earlier one in one step.
fn write_import(import_file: &Path, events: &[Value]) -> Result<()> {
    use std::io::Write;
    if let Some(dir) = import_file.parent() {
        crate::paths::create_private_dir(dir)?;
    }
    let tmp = import_file.with_extension(format!("jsonl.{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = std::io::BufWriter::new(options.open(&tmp)?);
    for event in events {
        serde_json::to_writer(&mut out, event)?;
        out.write_all(b"\n")?;
    }
    out.flush()?;
    drop(out);
    fs::rename(&tmp, import_file)?;
    Ok(())
}

fn import_one(transcript: &Path, imported_dir: &Path, report: &mut Report) {
    let stem = transcript
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let target = imported_dir.join(format!("{}.jsonl", crate::capture::file_stem(Some(&stem))));
    let size = transcript::tree_size(transcript);
    if imported_from(&target).is_some_and(|(_, bytes)| bytes == size) {
        report.up_to_date += 1;
        return;
    }
    let result = events_from_transcript(transcript).and_then(|events| {
        if events.is_empty() {
            return Ok(false);
        }
        write_import(&target, &events)?;
        Ok(true)
    });
    match result {
        Ok(true) => report.imported += 1,
        Ok(false) => report.empty += 1,
        Err(err) => report
            .failed
            .push((transcript.to_path_buf(), format!("{err:#}"))),
    }
}

/// Import transcripts from Claude Code's projects directory: all of them, or
/// only the sessions whose id starts with one of `only`.
pub fn import_all(projects_dir: &Path, imported_dir: &Path, only: &[String]) -> Result<Report> {
    let mut transcripts: Vec<PathBuf> = fs::read_dir(projects_dir)
        .with_context(|| format!("reading {}", projects_dir.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|project| fs::read_dir(project.path()).ok())
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter(|p| {
            let stem = p.file_stem().unwrap_or_default().to_string_lossy();
            only.is_empty() || only.iter().any(|prefix| stem.starts_with(prefix.as_str()))
        })
        .collect();
    transcripts.sort();
    let mut report = Report::default();
    for transcript in transcripts {
        import_one(&transcript, imported_dir, &mut report);
    }
    Ok(report)
}

/// Re-import sessions that were imported before and whose transcript has
/// grown since. Never imports a session for the first time.
pub fn refresh(imported_dir: &Path) -> Report {
    let mut report = Report::default();
    let files = fs::read_dir(imported_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"));
    for file in files {
        if let Some((transcript, _)) = imported_from(&file).filter(|(t, _)| t.is_file()) {
            import_one(&transcript, imported_dir, &mut report);
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_rows(path: &Path, rows: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        for row in rows {
            writeln!(f, "{row}").unwrap();
        }
    }

    fn ts(second: u32) -> String {
        format!("2026-11-01T10:00:{second:02}.000Z")
    }

    fn user(second: u32, prompt_id: &str, content: Value, extra: Value) -> Value {
        let mut row = json!({ "type": "user", "timestamp": ts(second), "promptId": prompt_id,
                              "cwd": "/work/repo", "message": { "role": "user", "content": content } });
        for (k, v) in extra.as_object().unwrap() {
            row[k] = v.clone();
        }
        row
    }

    fn tool_use(second: u32, id: &str, name: &str, input: Value) -> Value {
        json!({ "type": "assistant", "timestamp": ts(second),
                "message": { "id": format!("m-{id}"), "model": "claude-opus-5-5",
                             "usage": { "output_tokens": 10 },
                             "content": [{ "type": "text", "text": "ok" },
                                         { "type": "tool_use", "id": id, "name": name, "input": input }] } })
    }

    fn result(second: u32, id: &str, block_extra: Value, row_extra: Value) -> Value {
        let mut block =
            json!({ "type": "tool_result", "tool_use_id": id, "content": "output text" });
        for (k, v) in block_extra.as_object().unwrap() {
            block[k] = v.clone();
        }
        user(second, "p1", json!([block]), row_extra)
    }

    fn sample(dir: &Path) -> PathBuf {
        let main = dir.join("proj/sess-1.jsonl");
        let big_file = "x".repeat(5000);
        write_rows(
            &main,
            &[
                json!({ "type": "ai-title", "aiTitle": "Generated title" }),
                user(
                    1,
                    "p1",
                    json!("build the thing"),
                    json!({ "turnOrigin": "human", "permissionMode": "default" }),
                ),
                user(
                    1,
                    "p1",
                    json!([{ "type": "text", "text": "[Image: …]" }]),
                    json!({ "isMeta": true }),
                ),
                tool_use(
                    2,
                    "t1",
                    "Write",
                    json!({ "file_path": "/work/repo/new.rs", "content": "fn a() {}\nfn b() {}\n" }),
                ),
                result(
                    3,
                    "t1",
                    json!({}),
                    json!({ "toolUseResult": { "type": "create", "structuredPatch": [], "content": big_file } }),
                ),
                tool_use(4, "t2", "Edit", json!({ "file_path": "/work/repo/old.rs" })),
                result(
                    5,
                    "t2",
                    json!({}),
                    json!({ "toolUseResult": { "originalFile": big_file,
                    "structuredPatch": [{ "lines": ["-old();", "+new_one();", "+new_two();"] }] } }),
                ),
                tool_use(6, "t3", "Bash", json!({ "command": "false" })),
                result(
                    6,
                    "t3",
                    json!({ "is_error": true, "content": [{ "type": "text", "text": "Exit code 1" }] }),
                    json!({ "toolUseResult": "Error: Exit code 1" }),
                ),
                tool_use(7, "t4", "Bash", json!({ "command": "rm -rf x" })),
                result(
                    8,
                    "t4",
                    json!({ "is_error": true }),
                    json!({ "toolDenialKind": "user-rejected", "toolUseResult": "User rejected tool use" }),
                ),
                tool_use(9, "t5", "Bash", json!({ "command": "curl evil" })),
                result(
                    9,
                    "t5",
                    json!({ "is_error": true }),
                    json!({ "toolDenialKind": "automode-blocked" }),
                ),
                tool_use(10, "t6", "Agent", json!({ "description": "look" })),
                result(
                    14,
                    "t6",
                    json!({}),
                    json!({ "toolUseResult": { "status": "completed" } }),
                ),
                user(
                    15,
                    "p1",
                    json!("<task-notification>done</task-notification>"),
                    json!({ "turnOrigin": "task_notification" }),
                ),
                json!({ "type": "system", "subtype": "turn_duration", "timestamp": ts(16), "durationMs": 15000 }),
                user(20, "p2", json!("and now this"), json!({})), // old style: no origin
                user(
                    21,
                    "p2",
                    json!("<local-command-stdout>x</local-command-stdout>"),
                    json!({}),
                ),
                tool_use(
                    22,
                    "t7",
                    "Read",
                    json!({ "file_path": "/work/repo/old.rs" }),
                ), // never answered
                json!({ "type": "custom-title", "customTitle": "My title" }),
            ],
        );
        write_rows(
            &dir.join("proj/sess-1/subagents/agent-a1.jsonl"),
            &[
                user(
                    11,
                    "p1",
                    json!("sub task"),
                    json!({ "isSidechain": true, "turnOrigin": "human" }),
                ),
                tool_use(12, "s1", "Grep", json!({ "pattern": "TODO" })),
                result(
                    13,
                    "s1",
                    json!({}),
                    json!({ "toolUseResult": { "numFiles": 2 } }),
                ),
            ],
        );
        fs::write(
            dir.join("proj/sess-1/subagents/agent-a1.meta.json"),
            r#"{"agentType":"Explore"}"#,
        )
        .unwrap();
        main
    }

    #[test]
    fn rebuilds_a_session_from_its_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let events = events_from_transcript(&sample(dir.path())).unwrap();
        assert_eq!(events[0]["hook"], "SessionStart");
        assert!(events
            .iter()
            .all(|e| e["origin"] == "transcript" && e["session_id"] == "sess-1"));
        let times: Vec<&str> = events
            .iter()
            .map(|e| e["received_at"].as_str().unwrap())
            .collect();
        assert!(
            times.windows(2).all(|w| w[0] <= w[1]),
            "events are in time order"
        );

        let s = crate::normalize::from_events(&events, None).unwrap();
        assert_eq!(s.captured_by, crate::session::CapturedBy::Transcript);
        assert!(s.captured_from_start);
        assert_eq!(s.title.as_deref(), Some("My title"));
        assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(s.permission_modes, ["default"]);

        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["build the thing", "and now this"]);
        use crate::session::{Outcome, ToolStatus::*};
        assert_eq!(s.prompts[0].outcome, Some(Outcome::Completed));
        assert_eq!(s.prompts[1].outcome, None);
        assert_eq!(s.active_ms, 15_000);

        let status: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.status))
            .collect();
        assert_eq!(
            status,
            [
                ("Write", Ok),
                ("Edit", Ok),
                ("Bash", Failed),
                ("Bash", Rejected),
                ("Bash", Denied),
                ("Agent", Ok),
                ("Grep", Ok),
                ("Read", NoResult)
            ]
        );
        assert_eq!(s.tool_calls[0].duration_ms, Some(1000));
        assert_eq!(s.tool_calls[2].error.as_deref(), Some("Exit code 1"));
        assert_eq!(s.tool_calls[6].agent_id.as_deref(), Some("a1"));
        assert_eq!(s.counts.permission_denials, 1);
        assert_eq!(s.counts.tool_failures, 1);

        assert_eq!(s.subagents.len(), 1);
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("Explore"));
        assert_eq!(s.subagents[0].tool_calls, 1);

        let file = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        assert!(file("/work/repo/new.rs").created);
        assert_eq!(file("/work/repo/new.rs").lines_added, 2);
        assert_eq!(
            (
                file("/work/repo/old.rs").lines_added,
                file("/work/repo/old.rs").lines_removed
            ),
            (2, 1)
        );
        // line hashes for the rewrite rate come through too
        let lines = crate::rewrite::added_lines(&events);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].1.len(), 2);
    }

    #[test]
    fn saved_import_is_small_and_refreshes_when_the_transcript_grows() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = sample(dir.path());
        let imported = dir.path().join("imported");
        let projects = dir.path().to_path_buf();

        let first = import_all(&projects, &imported, &[]).unwrap();
        assert_eq!(
            (first.imported, first.up_to_date, first.failed.len()),
            (1, 0, 0)
        );
        let file = imported.join("sess-1.jsonl");
        let saved = fs::read_to_string(&file).unwrap();
        assert!(
            !saved.contains(&"x".repeat(100)),
            "tool results are not copied"
        );
        assert!(saved.len() < 8000, "{} bytes", saved.len());
        // output size is still known
        let events: Vec<Value> = saved
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let s = crate::normalize::from_events(&events, None).unwrap();
        assert!(s.tool_calls[0].output_bytes.unwrap() > 5000);

        assert_eq!(import_all(&projects, &imported, &[]).unwrap().up_to_date, 1);
        assert_eq!(
            refresh(&imported),
            Report {
                up_to_date: 1,
                ..Default::default()
            }
        );

        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        writeln!(
            f,
            "{}",
            user(30, "p3", json!("third"), json!({ "turnOrigin": "human" }))
        )
        .unwrap();
        assert_eq!(refresh(&imported).imported, 1);
        assert!(fs::read_to_string(&file).unwrap().contains("third"));

        // only the named sessions; an unknown prefix matches nothing
        let none = import_all(&projects, &imported, &["zzz".to_string()]).unwrap();
        assert_eq!(none, Report::default());
        // the transcript goes away: the import stays as it is
        fs::remove_dir_all(dir.path().join("proj")).unwrap();
        assert_eq!(refresh(&imported), Report::default());
        assert!(file.exists());
    }

    #[test]
    fn a_turn_without_a_duration_row_ends_when_the_model_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p/headless.jsonl");
        let answer = |second: u32, stop_reason: &str| {
            json!({ "type": "assistant", "timestamp": ts(second),
                    "message": { "id": format!("m{second}"), "stop_reason": stop_reason, "content": [] } })
        };
        write_rows(
            &path,
            &[
                user(1, "p1", json!("first"), json!({ "turnOrigin": "sdk" })),
                answer(3, "tool_use"),
                answer(9, "end_turn"),
                user(20, "p2", json!("second"), json!({ "turnOrigin": "sdk" })),
                answer(22, "tool_use"), // cut off: never finished
            ],
        );
        let events = events_from_transcript(&path).unwrap();
        let s = crate::normalize::from_events(&events, None).unwrap();
        assert_eq!(s.active_ms, 8_000);
        assert_eq!(
            s.prompts[0].outcome,
            Some(crate::session::Outcome::Completed)
        );
        assert_eq!(s.prompts[1].outcome, None);
    }

    #[test]
    fn a_transcript_without_dated_rows_imports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p/empty.jsonl");
        write_rows(&path, &[json!({ "type": "ai-title", "aiTitle": "t" })]);
        assert!(events_from_transcript(&path).unwrap().is_empty());
        let report = import_all(dir.path(), &dir.path().join("imported"), &[]).unwrap();
        assert_eq!(report.empty, 1);
    }
}
