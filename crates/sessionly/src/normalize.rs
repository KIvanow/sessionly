//! Build a normalized [`Session`] from captured hook events and the transcript.
//!
//! Hook events give the structure (prompts, tool calls, files, subagents);
//! the transcript gives tokens, cost, models and the git branch.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::session::*;
use crate::transcript::{self, TranscriptSummary};

const PREVIEW_CHARS: usize = 200;

/// A session built from a raw capture file, plus where its transcript is.
pub struct Built {
    pub session: Session,
    pub transcript_path: Option<PathBuf>,
}

/// Read a raw capture file, parse its transcript if present, and normalize.
/// Returns `None` if the file holds no usable events.
pub fn build_from_raw(raw_path: &Path) -> Result<Option<Built>> {
    let file =
        fs::File::open(raw_path).with_context(|| format!("opening {}", raw_path.display()))?;
    let events: Vec<Value> = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect();
    let transcript_path = events
        .iter()
        .filter_map(|e| e["payload"]["transcript_path"].as_str())
        .map(PathBuf::from)
        .find(|p| p.is_file());
    let transcript = match &transcript_path {
        Some(path) => Some(transcript::parse(path)?),
        None => None,
    };
    let Some(mut session) = from_events(&events, transcript.as_ref()) else {
        return Ok(None);
    };
    add_local_context(&mut session, transcript.as_ref());
    Ok(Some(Built {
        session,
        transcript_path,
    }))
}

/// Repository and user details read from the local machine.
fn add_local_context(session: &mut Session, transcript: Option<&TranscriptSummary>) {
    let Some(cwd) = session.cwd.as_deref().map(Path::new) else {
        return;
    };
    if let Some(root) = crate::git::repo_root(cwd) {
        session.repo = Some(Repo {
            remote: crate::git::origin_remote(&root),
            branch: transcript.and_then(|t| t.git_branch.clone()),
            root: root.to_string_lossy().into_owned(),
        });
    }
    let (name, email) = crate::git::user(cwd);
    if name.is_some() || email.is_some() {
        session.user = Some(User { name, email });
    }
}

/// Normalize raw capture records (the envelopes written by `sessionly capture`).
pub fn from_events(events: &[Value], transcript: Option<&TranscriptSummary>) -> Option<Session> {
    let mut s = Session {
        schema_version: SCHEMA_VERSION,
        source: "claude-code".into(),
        ..Default::default()
    };
    let mut tool_ix: HashMap<String, usize> = HashMap::new();
    let mut sub_ix: HashMap<String, usize> = HashMap::new();
    let mut created: HashSet<String> = HashSet::new();
    let mut start_model = None;
    let (mut first, mut last) = (None::<DateTime<Utc>>, None::<DateTime<Utc>>);

    for record in events {
        let p = &record["payload"];
        let text = |k: &str| {
            p.get(k)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(String::from)
        };
        let Some(session_id) = text("session_id") else {
            continue;
        };
        if s.session_id.is_empty() {
            s.session_id = session_id;
        }
        s.counts.events += 1;
        let at = record["received_at"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc));
        if let Some(at) = at {
            first = Some(first.map_or(at, |f| f.min(at)));
            last = Some(last.map_or(at, |l| l.max(at)));
        }
        if s.cwd.is_none() {
            s.cwd = text("cwd");
        }
        if let Some(title) = text("session_title") {
            s.title = Some(title);
        }
        if let Some(mode) = text("permission_mode") {
            if !s.permission_modes.contains(&mode) {
                s.permission_modes.push(mode);
            }
        }

        match record["hook"].as_str().unwrap_or_default() {
            "SessionStart" => start_model = text("model").or(start_model),
            "SessionEnd" => s.end_reason = text("reason"),
            "UserPromptSubmit" => s.prompts.push(Prompt {
                prompt_id: text("prompt_id"),
                at,
                text: summarize(p["prompt"].as_str().unwrap_or_default()),
                ..Default::default()
            }),
            hook @ ("Stop" | "StopFailure") => {
                let id = text("prompt_id");
                if let Some(prompt) = s
                    .prompts
                    .iter_mut()
                    .rev()
                    .find(|pr| pr.prompt_id == id && pr.ended_at.is_none())
                {
                    prompt.ended_at = at;
                    if hook == "Stop" {
                        prompt.outcome = Some("completed".into());
                    } else {
                        prompt.outcome = Some("api_error".into());
                        prompt.error = text("error");
                    }
                }
                if hook == "StopFailure" {
                    s.counts.api_errors += 1;
                }
            }
            "PreToolUse" => {
                tool_call(&mut s, &mut tool_ix, p, at);
            }
            "PostToolUse" => {
                if let Some(call) = tool_call(&mut s, &mut tool_ix, p, at) {
                    call.status = "ok".into();
                    call.duration_ms = p["duration_ms"].as_u64();
                    let response = &p["tool_response"];
                    call.output_bytes = Some(response.to_string().len() as u64);
                    (call.lines_added, call.lines_removed) =
                        line_changes(&p["tool_input"], response);
                    if response["type"].as_str() == Some("create") {
                        created.extend(call.file_path.clone());
                    }
                }
            }
            "PostToolUseFailure" => {
                if let Some(call) = tool_call(&mut s, &mut tool_ix, p, at) {
                    let interrupted = p["is_interrupt"].as_bool() == Some(true);
                    call.status = if interrupted { "interrupted" } else { "failed" }.into();
                    call.duration_ms = p["duration_ms"].as_u64();
                    call.error = p["error"].as_str().map(|e| truncate(e, PREVIEW_CHARS));
                }
            }
            "PermissionRequest" => s.counts.permission_requests += 1,
            "PermissionDenied" => {
                s.counts.permission_denials += 1;
                if let Some(call) = tool_call(&mut s, &mut tool_ix, p, at) {
                    call.status = "denied".into();
                    call.error = p["reason"].as_str().map(|e| truncate(e, PREVIEW_CHARS));
                }
            }
            "SubagentStart" => {
                if let Some(id) = text("agent_id") {
                    sub_ix.insert(id.clone(), s.subagents.len());
                    s.subagents.push(Subagent {
                        agent_id: id,
                        agent_type: text("agent_type"),
                        started_at: at,
                        ..Default::default()
                    });
                }
            }
            // Internal agents (prompt suggestions and the like) also fire
            // SubagentStop, without a SubagentStart: those are not recorded.
            "SubagentStop" => {
                if let Some(&i) = text("agent_id").and_then(|id| sub_ix.get(&id)) {
                    s.subagents[i].ended_at = at;
                }
            }
            "PostCompact" => s.counts.compactions += 1,
            "InstructionsLoaded" => {
                if let Some(path) = text("file_path") {
                    if !s.instruction_files.contains(&path) {
                        s.instruction_files.push(path);
                    }
                }
            }
            _ => {}
        }
    }
    if s.session_id.is_empty() {
        return None;
    }

    s.active_ms = s
        .prompts
        .iter()
        .filter_map(|p| Some((p.ended_at? - p.at?).num_milliseconds().max(0)))
        .sum();
    s.files = files_touched(&s.tool_calls, &created);
    for sub in &mut s.subagents {
        sub.tool_calls = s
            .tool_calls
            .iter()
            .filter(|c| c.agent_id.as_deref() == Some(sub.agent_id.as_str()))
            .count() as u64;
    }

    if let Some(t) = transcript {
        apply_transcript(&mut s, t, &mut sub_ix);
        first = first.into_iter().chain(t.first_at).min();
        last = last.into_iter().chain(t.last_at).max();
    }
    if s.models.is_empty() {
        s.models.extend(start_model);
    }
    s.started_at = first;
    s.ended_at = last;
    s.duration_ms = first.zip(last).map(|(f, l)| (l - f).num_milliseconds());

    s.counts.prompts = s.prompts.len() as u64;
    s.counts.tool_calls = s.tool_calls.len() as u64;
    s.counts.tool_failures = s.tool_calls.iter().filter(|c| c.status == "failed").count() as u64;
    s.counts.subagents = s.subagents.len() as u64;
    s.counts.files_read = s.files.iter().filter(|f| f.reads > 0).count() as u64;
    s.counts.files_changed = s.files.iter().filter(|f| f.writes > 0).count() as u64;
    s.counts.lines_added = s.files.iter().map(|f| f.lines_added).sum();
    s.counts.lines_removed = s.files.iter().map(|f| f.lines_removed).sum();
    Some(s)
}

/// Find or create the tool call a tool event refers to.
fn tool_call<'a>(
    s: &'a mut Session,
    index: &mut HashMap<String, usize>,
    p: &Value,
    at: Option<DateTime<Utc>>,
) -> Option<&'a mut ToolCall> {
    let id = p["tool_use_id"].as_str()?;
    let i = match index.get(id) {
        Some(&i) => i,
        None => {
            let text = |k: &str| p[k].as_str().filter(|v| !v.is_empty()).map(String::from);
            let tool = text("tool_name").unwrap_or_default();
            let input = &p["tool_input"];
            s.tool_calls.push(ToolCall {
                tool_use_id: id.to_string(),
                prompt_id: text("prompt_id"),
                agent_id: text("agent_id"),
                at,
                status: "no_result".into(),
                file_path: ["file_path", "notebook_path"]
                    .iter()
                    .find_map(|k| input[*k].as_str())
                    .map(String::from),
                input_sha256: sha256_hex(input.to_string().as_bytes()),
                input_summary: input_summary(&tool, input),
                tool,
                ..Default::default()
            });
            index.insert(id.to_string(), s.tool_calls.len() - 1);
            s.tool_calls.len() - 1
        }
    };
    s.tool_calls.get_mut(i)
}

/// The one input field worth showing for a tool, if any.
fn input_summary(tool: &str, input: &Value) -> Option<String> {
    let key = match tool {
        "Bash" => "command",
        "Agent" | "Task" => "description",
        "Grep" | "Glob" => "pattern",
        "WebFetch" => "url",
        "WebSearch" => "query",
        _ => return None,
    };
    input[key].as_str().map(|v| truncate(v, PREVIEW_CHARS))
}

/// Lines added and removed by a successful Write, Edit or similar call.
fn line_changes(input: &Value, response: &Value) -> (u64, u64) {
    let hunks = response["structuredPatch"].as_array();
    if let Some(hunks) = hunks.filter(|h| !h.is_empty()) {
        let mut added = 0;
        let mut removed = 0;
        for line in hunks
            .iter()
            .filter_map(|h| h["lines"].as_array())
            .flatten()
            .filter_map(Value::as_str)
        {
            match line.as_bytes().first() {
                Some(b'+') => added += 1,
                Some(b'-') => removed += 1,
                _ => {}
            }
        }
        return (added, removed);
    }
    // A newly created file has no patch: every line of the content is new.
    if response["type"].as_str() == Some("create") {
        let content = input["content"].as_str().unwrap_or_default();
        return (content.lines().count() as u64, 0);
    }
    (0, 0)
}

fn files_touched(calls: &[ToolCall], created: &HashSet<String>) -> Vec<FileTouched> {
    let mut files: Vec<FileTouched> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for call in calls.iter().filter(|c| c.status == "ok") {
        let Some(path) = call.file_path.as_deref() else {
            continue;
        };
        let is_read = match call.tool.as_str() {
            "Read" => true,
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => false,
            _ => continue,
        };
        let i = *index.entry(path).or_insert_with(|| {
            files.push(FileTouched {
                path: path.to_string(),
                created: created.contains(path),
                ..Default::default()
            });
            files.len() - 1
        });
        let file = &mut files[i];
        if is_read {
            file.reads += 1;
        } else {
            file.writes += 1;
            file.lines_added += call.lines_added;
            file.lines_removed += call.lines_removed;
        }
    }
    files
}

fn apply_transcript(s: &mut Session, t: &TranscriptSummary, sub_ix: &mut HashMap<String, usize>) {
    s.agent_version = t.version.clone();
    s.entrypoint = t.entrypoint.clone();
    let cost = t.cost();
    s.cost = Some(Cost {
        total_usd: cost.total_usd,
        source: cost.source.as_str().into(),
        transcript_estimate_usd: cost.transcript_estimate_usd,
        untracked_usd: cost.untracked_usd,
    });
    let mut usage: Vec<ModelUsage> = t
        .usage_by_model()
        .iter()
        .filter(|(model, u)| u.requests > 0 && model.as_str() != "<synthetic>")
        .map(|(model, u)| ModelUsage {
            model: model.clone(),
            requests: u.requests,
            input_tokens: u.input,
            output_tokens: u.output,
            thinking_tokens: u.thinking,
            cache_read_tokens: u.cache_read,
            cache_write_tokens: u.cache_write_5m + u.cache_write_1h,
            estimated_cost_usd: (u.unpriced_requests < u.requests).then_some(u.cost_usd),
        })
        .collect();
    usage.sort_by(|a, b| b.requests.cmp(&a.requests).then(a.model.cmp(&b.model)));
    s.models = usage.iter().map(|u| u.model.clone()).collect();
    s.usage = usage;

    for sub in &t.subagents {
        let i = *sub_ix.entry(sub.agent_id.clone()).or_insert_with(|| {
            s.subagents.push(Subagent {
                agent_id: sub.agent_id.clone(),
                ..Default::default()
            });
            s.subagents.len() - 1
        });
        let record = &mut s.subagents[i];
        record.agent_type = record.agent_type.take().or(sub.agent_type.clone());
        record.description = sub.description.clone();
        let mut priced = false;
        let mut cost = 0.0;
        for u in sub.usage.values() {
            record.requests += u.requests;
            record.input_tokens += u.input;
            record.output_tokens += u.output;
            priced |= u.unpriced_requests < u.requests;
            cost += u.cost_usd;
        }
        record.estimated_cost_usd = priced.then_some(cost);
    }
}

pub fn summarize(text: &str) -> Text {
    Text {
        sha256: sha256_hex(text.as_bytes()),
        chars: text.chars().count() as u64,
        preview: truncate(text, PREVIEW_CHARS),
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(second: u32, hook: &str, mut payload: Value) -> Value {
        payload["session_id"] = json!("s1");
        payload["cwd"] = json!("/work/repo");
        payload["hook_event_name"] = json!(hook);
        json!({
            "v": 1, "source": "claude-code", "hook": hook, "session_id": "s1",
            "received_at": format!("2026-11-13T10:00:{second:02}.000000Z"),
            "payload": payload,
        })
    }

    fn tool(second: u32, hook: &str, id: &str, name: &str, input: Value, extra: Value) -> Value {
        let mut payload = json!({
            "prompt_id": "p1", "permission_mode": "default",
            "tool_use_id": id, "tool_name": name, "tool_input": input,
        });
        for (k, v) in extra.as_object().unwrap() {
            payload[k] = v.clone();
        }
        event(second, hook, payload)
    }

    fn sample() -> Vec<Value> {
        let write = json!({ "file_path": "/work/repo/new.txt", "content": "a\nb\nc\n" });
        let edit =
            json!({ "file_path": "/work/repo/old.rs", "old_string": "x", "new_string": "y" });
        let patch = json!({ "structuredPatch": [{ "lines": [" keep", "-x", "+y", "+z"] }] });
        vec![
            event(
                0,
                "InstructionsLoaded",
                json!({ "file_path": "/home/u/.claude/CLAUDE.md" }),
            ),
            event(
                0,
                "SessionStart",
                json!({ "source": "startup", "model": "claude-opus-5-5" }),
            ),
            event(
                1,
                "UserPromptSubmit",
                json!({ "prompt_id": "p1", "prompt": "do the thing", "permission_mode": "default" }),
            ),
            tool(
                2,
                "PreToolUse",
                "t1",
                "Bash",
                json!({ "command": "echo hi" }),
                json!({}),
            ),
            tool(
                3,
                "PostToolUse",
                "t1",
                "Bash",
                json!({ "command": "echo hi" }),
                json!({ "tool_response": { "stdout": "hi" }, "duration_ms": 700 }),
            ),
            tool(
                4,
                "PreToolUse",
                "t2",
                "Bash",
                json!({ "command": "ls nope" }),
                json!({}),
            ),
            tool(
                4,
                "PostToolUseFailure",
                "t2",
                "Bash",
                json!({ "command": "ls nope" }),
                json!({ "error": "Exit code 2", "is_interrupt": false, "duration_ms": 30 }),
            ),
            tool(5, "PreToolUse", "t3", "Write", write.clone(), json!({})),
            tool(
                5,
                "PostToolUse",
                "t3",
                "Write",
                write,
                json!({ "tool_response": { "type": "create", "structuredPatch": [] } }),
            ),
            tool(
                6,
                "PreToolUse",
                "t4",
                "Read",
                json!({ "file_path": "/work/repo/old.rs" }),
                json!({}),
            ),
            tool(
                6,
                "PostToolUse",
                "t4",
                "Read",
                json!({ "file_path": "/work/repo/old.rs" }),
                json!({ "tool_response": { "type": "text" } }),
            ),
            tool(7, "PreToolUse", "t5", "Edit", edit.clone(), json!({})),
            tool(
                7,
                "PostToolUse",
                "t5",
                "Edit",
                edit,
                json!({ "tool_response": patch }),
            ),
            // asked for permission, never got a result
            tool(
                8,
                "PreToolUse",
                "t6",
                "Write",
                json!({ "file_path": "/work/repo/no.txt", "content": "x" }),
                json!({}),
            ),
            event(8, "PermissionRequest", json!({ "tool_name": "Write" })),
            event(
                9,
                "SubagentStart",
                json!({ "agent_id": "a1", "agent_type": "Explore" }),
            ),
            tool(
                10,
                "PreToolUse",
                "t7",
                "Grep",
                json!({ "pattern": "TODO" }),
                json!({ "agent_id": "a1" }),
            ),
            tool(
                10,
                "PostToolUse",
                "t7",
                "Grep",
                json!({ "pattern": "TODO" }),
                json!({ "agent_id": "a1", "tool_response": {} }),
            ),
            event(
                11,
                "SubagentStop",
                json!({ "agent_id": "a1", "agent_type": "Explore" }),
            ),
            // internal agent: stop without start
            event(
                12,
                "SubagentStop",
                json!({ "agent_id": "zz", "agent_type": "" }),
            ),
            event(
                21,
                "Stop",
                json!({ "prompt_id": "p1", "last_assistant_message": "done" }),
            ),
            event(22, "SessionEnd", json!({ "reason": "other" })),
        ]
    }

    #[test]
    fn normalizes_a_full_session() {
        let s = from_events(&sample(), None).unwrap();
        assert_eq!(s.session_id, "s1");
        assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(s.end_reason.as_deref(), Some("other"));
        assert_eq!(s.models, ["claude-opus-5-5"]);
        assert_eq!(s.permission_modes, ["default"]);
        assert_eq!(s.instruction_files, ["/home/u/.claude/CLAUDE.md"]);
        assert_eq!(s.duration_ms, Some(22_000));
        assert_eq!(s.active_ms, 20_000);
        assert!(s.cost.is_none());

        assert_eq!(s.prompts.len(), 1);
        assert_eq!(s.prompts[0].text.preview, "do the thing");
        assert_eq!(s.prompts[0].text.chars, 12);
        assert_eq!(s.prompts[0].outcome.as_deref(), Some("completed"));

        let status: Vec<_> = s.tool_calls.iter().map(|c| c.status.as_str()).collect();
        assert_eq!(
            status,
            ["ok", "failed", "ok", "ok", "ok", "no_result", "ok"]
        );
        assert_eq!(s.tool_calls[0].input_summary.as_deref(), Some("echo hi"));
        assert_eq!(s.tool_calls[0].duration_ms, Some(700));
        assert_eq!(s.tool_calls[1].error.as_deref(), Some("Exit code 2"));
        assert_eq!(s.tool_calls[6].agent_id.as_deref(), Some("a1"));

        assert_eq!(s.counts.events, 22);
        assert_eq!(s.counts.tool_calls, 7);
        assert_eq!(s.counts.tool_failures, 1);
        assert_eq!(s.counts.permission_requests, 1);
        assert_eq!(s.counts.subagents, 1);
        assert_eq!(s.subagents[0].tool_calls, 1);
        assert!(s.subagents[0].ended_at.is_some());
    }

    #[test]
    fn tracks_files_and_line_changes() {
        let s = from_events(&sample(), None).unwrap();
        let by_path = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        let new = by_path("/work/repo/new.txt");
        assert!(new.created);
        assert_eq!((new.writes, new.lines_added, new.lines_removed), (1, 3, 0));
        let old = by_path("/work/repo/old.rs");
        assert!(!old.created);
        assert_eq!((old.reads, old.writes), (1, 1));
        assert_eq!((old.lines_added, old.lines_removed), (2, 1));
        // the write that never completed is not a touched file
        assert!(s.files.iter().all(|f| f.path != "/work/repo/no.txt"));
        assert_eq!(s.counts.files_changed, 2);
        assert_eq!(s.counts.files_read, 1);
        assert_eq!((s.counts.lines_added, s.counts.lines_removed), (5, 1));
    }

    #[test]
    fn keeps_hashes_not_content() {
        let secret = "x".repeat(500);
        let events = vec![event(
            1,
            "UserPromptSubmit",
            json!({ "prompt_id": "p", "prompt": secret }),
        )];
        let s = from_events(&events, None).unwrap();
        let text = &s.prompts[0].text;
        assert_eq!(text.chars, 500);
        assert_eq!(text.preview.chars().count(), PREVIEW_CHARS + 1); // plus ellipsis
        assert_eq!(text.sha256.len(), 64);
        assert!(!serde_json::to_string(&s).unwrap().contains(&secret));
    }

    #[test]
    fn api_error_and_denied_calls() {
        let events = vec![
            event(
                1,
                "UserPromptSubmit",
                json!({ "prompt_id": "p1", "prompt": "go" }),
            ),
            tool(
                2,
                "PreToolUse",
                "t1",
                "Bash",
                json!({ "command": "rm -rf /" }),
                json!({}),
            ),
            tool(
                2,
                "PermissionDenied",
                "t1",
                "Bash",
                json!({ "command": "rm -rf /" }),
                json!({ "reason": "destructive" }),
            ),
            event(
                3,
                "StopFailure",
                json!({ "prompt_id": "p1", "error": "rate_limit" }),
            ),
        ];
        let s = from_events(&events, None).unwrap();
        assert_eq!(s.tool_calls[0].status, "denied");
        assert_eq!(s.counts.permission_denials, 1);
        assert_eq!(s.counts.api_errors, 1);
        assert_eq!(s.prompts[0].outcome.as_deref(), Some("api_error"));
        assert_eq!(s.prompts[0].error.as_deref(), Some("rate_limit"));
    }

    #[test]
    fn no_events_no_session() {
        assert!(from_events(&[], None).is_none());
        assert!(from_events(&[json!({ "payload": { "_unparsed": "x" } })], None).is_none());
    }
}
