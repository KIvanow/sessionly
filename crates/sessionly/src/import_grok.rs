//! Import sessions of Grok's terminal agent from `~/.grok/sessions`.
//!
//! Each session is a folder (layout as described in Grok's own README):
//! - `updates.jsonl`: the conversation as a stream of updates: user messages,
//!   tool calls with their inputs, diffs and outcome, turn ends, compactions.
//! - `summary.json`: working directory, branch, title, creation and update time.
//! - `usage.json`: tokens and Grok's own cost figure, per model.
//!
//! Grok names its tools differently from Claude Code. The common ones are
//! mapped to the same names (Read, Edit, Write, Bash, Grep) so sessions from
//! different agents can be compared.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::import::{edit_result, slim_input, Builder};
use crate::paths::GROK;
use crate::session::{Cost, CostSource, ModelUsage};
use crate::transcript::Facts;

/// Grok counts money in ticks: ten billion to the dollar.
const TICKS_PER_USD: f64 = 1e10;

const FILES: &[&str] = &["updates.jsonl", "usage.json", "summary.json"];

/// Combined size of the files a session is imported from.
pub fn session_bytes(updates: &Path) -> u64 {
    let dir = updates.parent().unwrap_or(Path::new("."));
    FILES
        .iter()
        .filter_map(|name| fs::metadata(dir.join(name)).ok())
        .map(|m| m.len())
        .sum()
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn time_of(seconds: i64) -> String {
    DateTime::from_timestamp(seconds, 0)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn parse_time(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// A tool call being assembled from several updates.
#[derive(Default)]
struct Call {
    name: String,
    input: Value,
    /// (old text, new text) of each diff the call produced.
    diffs: Vec<(String, String)>,
    started: i64,
    prompt_id: Option<String>,
}

/// Grok's tool and its input under the names used for Claude Code's tools.
fn canonical(call: &Call) -> (String, Value) {
    let input = &call.input;
    let field = |key: &str| input.get(key).cloned().unwrap_or(Value::Null);
    match input["variant"].as_str().unwrap_or_default() {
        "ReadFile" => ("Read".into(), json!({ "file_path": field("target_file") })),
        "SearchReplace" => ("Edit".into(), json!({ "file_path": field("file_path") })),
        "Write" => ("Write".into(), json!({ "file_path": field("file_path") })),
        "Bash" => (
            "Bash".into(),
            json!({ "command": field("command"), "description": field("description") }),
        ),
        "Grep" => (
            "Grep".into(),
            json!({ "pattern": field("pattern"), "path": field("path"), "glob": field("glob") }),
        ),
        _ => (call.name.clone(), slim_input(input)),
    }
}

/// The session's events and what its usage file says. `updates` is the
/// session's `updates.jsonl`.
pub fn session(updates: &Path) -> Result<(Vec<Value>, Option<Facts>)> {
    let dir = updates
        .parent()
        .context("a Grok session lives in a folder")?;
    let summary = read_json(&dir.join("summary.json"));
    let session_id = summary["info"]["id"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| {
            dir.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let mut out = Builder::new(GROK, &session_id);

    let mut calls: HashMap<String, Call> = HashMap::new();
    let mut prompt_id: Option<String> = None;
    let mut prompt_text = String::new();
    let mut prompt_started = 0;
    let (mut first, mut last) = (None::<i64>, None::<i64>);
    let mut model: Option<String> = None;

    // A prompt arrives in chunks: it is pushed once the next thing happens.
    fn flush_prompt(out: &mut Builder, id: &Option<String>, text: &mut String, at: i64) {
        if !text.is_empty() {
            out.push(
                &time_of(at),
                "UserPromptSubmit",
                json!({ "prompt_id": id, "prompt": text }),
            );
            text.clear();
        }
    }

    crate::jsonl::for_each(updates, |row| {
        let Some(at) = row["timestamp"].as_i64() else {
            return;
        };
        first = Some(first.map_or(at, |f| f.min(at)));
        last = Some(last.map_or(at, |l| l.max(at)));
        let update = &row["params"]["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or_default();
        if kind != "user_message_chunk" {
            flush_prompt(&mut out, &prompt_id, &mut prompt_text, prompt_started);
        }
        match kind {
            "user_message_chunk" => {
                let index = update["_meta"]["promptIndex"].as_u64().unwrap_or(0);
                let id = Some(format!("p{index}"));
                if id != prompt_id {
                    flush_prompt(&mut out, &prompt_id, &mut prompt_text, prompt_started);
                    prompt_id = id;
                    prompt_started = at;
                }
                prompt_text.push_str(update["content"]["text"].as_str().unwrap_or_default());
                if model.is_none() {
                    model = update["_meta"]["modelId"].as_str().map(String::from);
                }
            }
            "tool_call" | "tool_call_update" => {
                let Some(id) = update["toolCallId"].as_str() else {
                    return;
                };
                let call = calls.entry(id.to_string()).or_insert_with(|| Call {
                    started: at,
                    prompt_id: prompt_id.clone(),
                    ..Default::default()
                });
                if let Some(name) = update["_meta"]["x.ai/tool"]["name"].as_str() {
                    call.name = name.to_string();
                }
                if update["rawInput"]
                    .as_object()
                    .is_some_and(|input| !input.is_empty())
                {
                    call.input = update["rawInput"].clone();
                }
                let content = update["content"].as_array();
                for block in content
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "diff")
                {
                    call.diffs.push((
                        block["oldText"].as_str().unwrap_or_default().to_string(),
                        block["newText"].as_str().unwrap_or_default().to_string(),
                    ));
                }
                let status = update["status"].as_str().unwrap_or_default();
                if status != "completed" && status != "failed" {
                    return;
                }
                let call = calls.remove(id).unwrap_or_default();
                let (tool, input) = canonical(&call);
                let base = json!({
                    "prompt_id": call.prompt_id,
                    "tool_use_id": id,
                    "tool_name": tool,
                    "tool_input": input,
                });
                out.push(&time_of(call.started), "PreToolUse", base.clone());
                let mut result = base;
                result["duration_ms"] = json!((at - call.started).max(0) * 1000);
                if status == "failed" {
                    let said = content
                        .into_iter()
                        .flatten()
                        .find_map(|b| b["content"]["text"].as_str())
                        .unwrap_or("failed");
                    result["error"] = json!(said);
                    out.push(&time_of(at), "PostToolUseFailure", result);
                } else {
                    let bytes = update["rawOutput"].to_string().len();
                    result["tool_response"] = if call.diffs.is_empty() {
                        json!({ "_bytes": bytes })
                    } else {
                        // Several diffs on one call are taken one after another.
                        let old: String = call
                            .diffs
                            .iter()
                            .map(|d| d.0.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        let new: String = call
                            .diffs
                            .iter()
                            .map(|d| d.1.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        let created = tool == "Write" && old.is_empty();
                        edit_result(&old, &new, created)
                    };
                    out.push(&time_of(at), "PostToolUse", result);
                }
            }
            "turn_completed" => out.push(&time_of(at), "Stop", json!({ "prompt_id": prompt_id })),
            "auto_compact_completed" => out.push(&time_of(at), "PostCompact", json!({})),
            _ => {}
        }
    })?;
    flush_prompt(&mut out, &prompt_id, &mut prompt_text, prompt_started);
    // Calls that never reported an outcome.
    let mut open: Vec<(String, Call)> = calls.into_iter().collect();
    open.sort_by_key(|(_, call)| call.started);
    for (id, call) in open {
        let (tool, input) = canonical(&call);
        out.push(
            &time_of(call.started),
            "PreToolUse",
            json!({ "prompt_id": call.prompt_id, "tool_use_id": id, "tool_name": tool, "tool_input": input }),
        );
    }

    let Some(first) = first else {
        return Ok((Vec::new(), None));
    };
    let mut start = json!({ "source": "startup" });
    if let Some(cwd) = summary["info"]["cwd"].as_str() {
        start["cwd"] = json!(cwd);
    }
    let title = ["generated_title", "session_summary"]
        .iter()
        .find_map(|key| summary[*key].as_str().filter(|t| !t.is_empty()));
    if let Some(title) = title {
        start["session_title"] = json!(title);
    }
    if let Some(model) = summary["current_model_id"].as_str().or(model.as_deref()) {
        start["model"] = json!(model);
    }
    out.push(&time_of(first), "SessionStart", start);

    let created = parse_time(&summary["created_at"]).or(DateTime::from_timestamp(first, 0));
    let updated =
        parse_time(&summary["updated_at"]).or(last.and_then(|l| DateTime::from_timestamp(l, 0)));
    Ok((
        out.finish(),
        Some(facts(
            &read_json(&dir.join("usage.json")),
            &summary,
            created,
            updated,
        )),
    ))
}

/// Tokens and cost as Grok recorded them.
fn facts(
    usage: &Value,
    summary: &Value,
    first_at: Option<DateTime<Utc>>,
    last_at: Option<DateTime<Utc>>,
) -> Facts {
    let n = |v: &Value, key: &str| v[key].as_u64().unwrap_or(0);
    let dollars = |v: &Value| {
        v["costUsdTicks"]
            .as_f64()
            .map(|ticks| ticks / TICKS_PER_USD)
    };
    let mut models: Vec<ModelUsage> = usage["session"]["modelUsage"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(model, u)| {
            let cached = n(u, "cachedReadTokens");
            let written = n(u, "cacheCreationTokens");
            ModelUsage {
                model: model.clone(),
                requests: n(u, "modelCalls"),
                // Grok's input count includes what was read from and written to the cache.
                input_tokens: n(u, "inputTokens").saturating_sub(cached + written),
                output_tokens: n(u, "outputTokens"),
                thinking_tokens: n(u, "reasoningTokens"),
                cache_read_tokens: cached,
                cache_write_5m_tokens: written,
                cache_write_1h_tokens: 0,
                estimated_cost_usd: dollars(u),
            }
        })
        .collect();
    models.sort_by(|a, b| b.requests.cmp(&a.requests).then(a.model.cmp(&b.model)));
    let total = dollars(&usage["session"]);
    Facts {
        first_at,
        last_at,
        git_branch: summary["head_branch"].as_str().map(String::from),
        version: None,
        entrypoint: summary["session_kind"].as_str().map(String::from),
        cost: total.map(|total_usd| Cost {
            total_usd,
            source: CostSource::Recorded,
            transcript_estimate_usd: total_usd,
            unpriced_requests: 0,
            untracked_usd: None,
            prompts_covered: None,
            by_branch: Vec::new(),
        }),
        usage: models,
        subagents: Vec::new(),
        tool_models: HashMap::new(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn update(at: i64, update: Value) -> Value {
        json!({ "timestamp": at, "method": "_x.ai/session/update",
                "params": { "sessionId": "g1", "update": update } })
    }

    fn tool(id: &str, name: &str) -> Value {
        json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": name,
                "rawInput": {}, "_meta": { "x.ai/tool": { "name": name } } })
    }

    fn sample(dir: &Path) -> std::path::PathBuf {
        let session = dir.join("%2Fwork%2Frepo/g1");
        fs::create_dir_all(&session).unwrap();
        let t0 = 1_794_212_700;
        let rows = vec![
            update(
                t0,
                json!({ "sessionUpdate": "hook_execution", "event_name": "session_start" }),
            ),
            update(
                t0 + 1,
                json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "add a " },
                                   "_meta": { "modelId": "grok-4.7", "promptIndex": 0 } }),
            ),
            update(
                t0 + 1,
                json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "feature" },
                                   "_meta": { "modelId": "grok-4.7", "promptIndex": 0 } }),
            ),
            update(t0 + 2, tool("c1", "read_file")),
            update(
                t0 + 2,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "kind": "read",
                                   "rawInput": { "variant": "ReadFile", "target_file": "/work/repo/a.rs" } }),
            ),
            update(
                t0 + 3,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed",
                                   "rawOutput": { "text": "x".repeat(900) } }),
            ),
            update(t0 + 4, tool("c2", "search_replace")),
            update(
                t0 + 4,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c2", "kind": "edit",
                                   "rawInput": { "variant": "SearchReplace", "file_path": "/work/repo/a.rs", "old_string": "x", "new_string": "y" },
                                   "content": [{ "type": "diff", "path": "/work/repo/a.rs",
                                                 "oldText": "keep\nold();\n", "newText": "keep\nnew_one();\nnew_two();\n" }] }),
            ),
            update(
                t0 + 6,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c2", "status": "completed" }),
            ),
            update(t0 + 7, tool("c3", "write")),
            update(
                t0 + 7,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c3", "kind": "edit",
                                   "rawInput": { "variant": "Write", "file_path": "/work/repo/b.rs", "content": "fn b() {}\n" },
                                   "content": [{ "type": "diff", "path": "/work/repo/b.rs", "oldText": "", "newText": "fn b() {}\n" }] }),
            ),
            update(
                t0 + 8,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c3", "status": "completed" }),
            ),
            update(t0 + 9, tool("c4", "run_terminal_command")),
            update(
                t0 + 9,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c4", "kind": "execute",
                                   "rawInput": { "variant": "Bash", "command": "false", "description": "fail" } }),
            ),
            update(
                t0 + 9,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c4", "status": "failed",
                                   "content": [{ "type": "content", "content": { "type": "text", "text": "Exit code 1" } }] }),
            ),
            update(t0 + 10, tool("c5", "todo_write")), // never finishes
            update(t0 + 30, json!({ "sessionUpdate": "turn_completed" })),
            update(
                t0 + 40,
                json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "thanks" },
                                    "_meta": { "promptIndex": 1 } }),
            ),
        ];
        let mut f = fs::File::create(session.join("updates.jsonl")).unwrap();
        for row in rows {
            writeln!(f, "{row}").unwrap();
        }
        fs::write(session.join("summary.json"), json!({
            "info": { "id": "g1", "cwd": "/work/repo" }, "generated_title": "Add a feature",
            "current_model_id": "grok-4.7", "head_branch": "feat", "session_kind": "interactive",
            "created_at": "2026-11-09T08:25:00.123456789Z", "updated_at": "2026-11-09T09:00:00Z"
        }).to_string()).unwrap();
        fs::write(session.join("usage.json"), json!({
            "session": { "costUsdTicks": 61_693_584_400u64,
              "modelUsage": { "grok-4.7-build": { "inputTokens": 20401, "outputTokens": 76, "cachedReadTokens": 1152,
                  "cacheCreationTokens": 0, "reasoningTokens": 29, "modelCalls": 3, "costUsdTicks": 61_693_584_400u64 } } }
        }).to_string()).unwrap();
        session.join("updates.jsonl")
    }

    #[test]
    fn rebuilds_a_grok_session() {
        let dir = tempfile::tempdir().unwrap();
        let (events, facts) = session(&sample(dir.path())).unwrap();
        let facts = facts.unwrap();
        assert!(events
            .iter()
            .all(|e| e["source"] == "grok" && e["origin"] == "transcript"));
        assert_eq!(events[0]["hook"], "SessionStart");

        let s = crate::normalize::from_events(&events, Some(&facts), GROK).unwrap();
        assert_eq!(s.source, "grok");
        assert_eq!(s.session_id, "g1");
        assert_eq!(s.title.as_deref(), Some("Add a feature"));
        assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["add a feature", "thanks"]);
        assert_eq!(s.active_ms, 29_000);

        use crate::session::ToolStatus::*;
        let calls: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.status))
            .collect();
        assert_eq!(
            calls,
            [
                ("Read", Ok),
                ("Edit", Ok),
                ("Write", Ok),
                ("Bash", Failed),
                ("todo_write", NoResult)
            ]
        );
        assert_eq!(
            s.tool_calls[0].file_path.as_deref(),
            Some("/work/repo/a.rs")
        );
        assert_eq!(s.tool_calls[1].duration_ms, Some(2000));
        assert_eq!(s.tool_calls[3].input_summary.as_deref(), Some("false"));
        assert_eq!(s.tool_calls[3].error.as_deref(), Some("Exit code 1"));

        let file = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(
            (
                file("/work/repo/a.rs").lines_added,
                file("/work/repo/a.rs").lines_removed
            ),
            (2, 1)
        );
        assert_eq!(file("/work/repo/a.rs").reads, 1);
        assert!(file("/work/repo/b.rs").created);
        assert_eq!(crate::rewrite::added_lines(&events).len(), 2);

        // tokens and cost come from Grok's own usage file
        let cost = s.cost.unwrap();
        assert!((cost.total_usd - 6.16935844).abs() < 1e-9);
        assert_eq!(cost.source, CostSource::Recorded);
        assert_eq!(s.models, ["grok-4.7-build"]);
        assert_eq!(s.usage[0].input_tokens, 20401 - 1152);
        assert_eq!(
            (
                s.usage[0].cache_read_tokens,
                s.usage[0].thinking_tokens,
                s.usage[0].requests
            ),
            (1152, 29, 3)
        );
        assert_eq!(s.repo, None); // no repository on disk in this test
        assert_eq!(facts.git_branch.as_deref(), Some("feat"));
        // the first update is a little earlier than the time in the summary
        assert_eq!(
            s.started_at.unwrap().to_rfc3339(),
            "2026-11-09T08:25:00+00:00"
        );
        assert_eq!(
            s.ended_at.unwrap().to_rfc3339(),
            "2026-11-09T09:00:00+00:00"
        );
    }

    #[test]
    fn an_empty_session_imports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("p/s");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("updates.jsonl"), "").unwrap();
        let (events, facts) = session(&session_dir.join("updates.jsonl")).unwrap();
        assert!(events.is_empty() && facts.is_none());
        assert_eq!(session_bytes(&session_dir.join("updates.jsonl")), 0);
    }
}
