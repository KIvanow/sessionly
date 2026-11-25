//! Import sessions of Grok's terminal agent from `~/.grok/sessions`.
//!
//! Each session is a folder (layout as described in Grok's own README):
//! - `updates.jsonl`: the conversation as a stream of updates: user messages,
//!   tool calls with their inputs, diffs and outcome, turn ends, compactions.
//! - `summary.json`: working directory, branch, title, creation and update time.
//! - `usage.json`: tokens and Grok's own cost figure, per model.
//! - `subagents/<id>/meta.json`: a subagent it started: what for, when it
//!   ran and how it ended.
//!
//! A subagent runs as a session of its own, in a folder of its own (under the
//! project of the directory it ran in). It is read into the session that
//! started it, as Claude Code's are: its tool calls are that session's,
//! marked as the subagent's. Its tokens are in that session's usage file
//! already, which counts every model call the subagent made; its own usage
//! file says how much of that was the subagent's.
//!
//! Grok names its tools differently from Claude Code. The common ones are
//! mapped to the same names (Read, Edit, Write, Bash, Grep) so sessions from
//! different agents can be compared.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::import::{edit_result, slim_input, Builder};
use crate::paths::GROK;
use crate::session::{Cost, CostSource, ModelUsage};
use crate::transcript::{Facts, ReviewSaid, SubagentFacts};

/// Grok counts money in ticks: ten billion to the dollar.
const TICKS_PER_USD: f64 = 1e10;

const FILES: &[&str] = &["updates.jsonl", "usage.json", "summary.json"];

/// Combined size of the files a session is imported from: its own, what it
/// says of its subagents, and theirs (`subagents`, their `updates.jsonl`).
pub fn session_bytes(updates: &Path, subagents: &[PathBuf]) -> u64 {
    let size = |path: &Path| fs::metadata(path).map_or(0, |m| m.len());
    let files = |updates: &Path| -> u64 {
        let dir = updates.parent().unwrap_or(Path::new("."));
        FILES.iter().map(|name| size(&dir.join(name))).sum()
    };
    let dir = updates.parent().unwrap_or(Path::new("."));
    let metas: u64 = subagent_dirs(dir)
        .iter()
        .map(|d| size(&d.join("meta.json")))
        .sum();
    files(updates) + metas + subagents.iter().map(|u| files(u)).sum::<u64>()
}

fn subagent_dirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir.join("subagents"))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect()
}

/// The subagents a session started, as its `subagents/<id>/meta.json` has
/// them, in the order they started.
fn spawned_meta(dir: &Path) -> Vec<Value> {
    let mut metas: Vec<Value> = subagent_dirs(dir)
        .iter()
        .map(|d| read_json(&d.join("meta.json")))
        .filter(|meta| child_of(meta).is_some())
        .collect();
    metas.sort_by(|a, b| a["started_at"].as_str().cmp(&b["started_at"].as_str()));
    metas
}

/// The session a subagent ran as.
fn child_of(meta: &Value) -> Option<&str> {
    meta["child_session_id"]
        .as_str()
        .or(meta["subagent_id"].as_str())
        .filter(|id| !id.is_empty())
}

/// The sessions of the subagents that a session's folder says it started.
pub fn spawned(session_dir: &Path) -> Vec<String> {
    spawned_meta(session_dir)
        .iter()
        .filter_map(|meta| child_of(meta).map(String::from))
        .collect()
}

const PARENTS_FILE: &str = "_parents.json";

/// The subagents' sessions that are read into the session that started
/// them, each with that session: kept beside the imports (`dir`) by the
/// importer, for `sync` to leave them out of the sessions.
pub fn parents(dir: &Path) -> BTreeMap<String, String> {
    let saved = read_json(&dir.join(PARENTS_FILE));
    saved
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(child, parent)| Some((child.clone(), parent.as_str()?.to_string())))
        .collect()
}

/// Keep `parents` beside the imports in `dir`, if that is not what is kept.
pub fn save_parents(dir: &Path, parents: &BTreeMap<String, String>) -> Result<()> {
    if self::parents(dir) == *parents {
        return Ok(());
    }
    crate::paths::create_private_dir(dir)?;
    let file = dir.join(PARENTS_FILE);
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string(parents)?)?;
    fs::rename(&tmp, &file)?;
    Ok(())
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
    /// The subagent it started, for `spawn_subagent`.
    started_agent: Option<String>,
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

/// What one thread's updates came to, besides the events they gave.
#[derive(Default)]
struct Thread {
    first: Option<i64>,
    last: Option<i64>,
    model: Option<String>,
    /// What the answer to each typed review command says it found.
    said: Vec<ReviewSaid>,
    /// What was said after the last tool call: the thread's last word.
    reply: String,
}

/// The session's events and what its usage file says. `updates` is the
/// session's `updates.jsonl`, and `subagents` those of the subagents it
/// started, where their folders are.
pub fn session(updates: &Path, subagents: &[PathBuf]) -> Result<(Vec<Value>, Option<Facts>)> {
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
    let main = read_thread(updates, &mut out, None)?;
    let Some(first) = main.first else {
        return Ok((Vec::new(), None));
    };

    let mut subagent_facts = Vec::new();
    for meta in spawned_meta(dir) {
        let Some(id) = child_of(&meta) else {
            continue;
        };
        let folder = subagents.iter().find(|u| {
            u.parent()
                .and_then(Path::file_name)
                .is_some_and(|n| n == id)
        });
        let mut facts = SubagentFacts {
            agent_id: id.to_string(),
            agent_type: meta["subagent_type"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(String::from),
            description: meta["description"]
                .as_str()
                .filter(|d| !d.is_empty())
                .map(String::from),
            ..Default::default()
        };
        let identity = json!({ "agent_id": id, "agent_type": facts.agent_type });
        let at = |t: DateTime<Utc>| t.to_rfc3339_opts(SecondsFormat::Secs, true);
        let started = parse_time(&meta["started_at"]);
        if let Some(started) = started {
            out.push(&at(started), "SubagentStart", identity.clone());
        }
        // One whose folder is gone, or cannot be read, is still a subagent
        // the session started, with what the session says of it.
        let thread = folder.and_then(|u| read_thread(u, &mut out, Some(id)).ok());
        if let (None, Some(first)) = (started, thread.as_ref().and_then(|t| t.first)) {
            out.push(&time_of(first), "SubagentStart", identity.clone());
        }
        // One still running, or stopped with the session, has no end.
        if let Some(ended) = parse_time(&meta["completed_at"]) {
            out.push(&at(ended), "SubagentStop", identity);
        }
        if let Some(own) = folder.and_then(|u| u.parent()) {
            let usage = &read_json(&own.join("usage.json"))["session"];
            let n = |key: &str| usage[key].as_u64().unwrap_or(0);
            facts.requests = n("modelCalls");
            facts.input_tokens =
                n("inputTokens").saturating_sub(n("cachedReadTokens") + n("cacheCreationTokens"));
            facts.output_tokens = n("outputTokens");
            facts.estimated_cost_usd = usage["costUsdTicks"].as_f64().map(|t| t / TICKS_PER_USD);
        }
        facts.findings = thread.and_then(|t| crate::reviews::findings_in(&t.reply));
        subagent_facts.push(facts);
    }

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
    if let Some(model) = summary["current_model_id"]
        .as_str()
        .or(main.model.as_deref())
    {
        start["model"] = json!(model);
    }
    out.push(&time_of(first), "SessionStart", start);

    let created = parse_time(&summary["created_at"]).or(DateTime::from_timestamp(first, 0));
    let updated = parse_time(&summary["updated_at"])
        .or(main.last.and_then(|l| DateTime::from_timestamp(l, 0)));
    let mut facts = facts(
        &read_json(&dir.join("usage.json")),
        &summary,
        created,
        updated,
    );
    facts.review_replies = main.said;
    facts.subagents = subagent_facts;
    Ok((out.finish(), Some(facts)))
}

/// Read one thread's updates into `out`: the session's own (`agent` none),
/// or a subagent's. A subagent's tool calls are marked as its, and its
/// prompt and turns are not the session's.
fn read_thread(updates: &Path, out: &mut Builder, agent: Option<&str>) -> Result<Thread> {
    let mut thread = Thread::default();
    let mut calls: HashMap<String, Call> = HashMap::new();
    let mut prompt_id: Option<String> = None;
    let mut prompt_text = String::new();
    let mut prompt_started = 0;

    // The prompt last pushed and what has been said in answer to it since
    // the last tool call: a review's reply says how many findings it has.
    let mut asked: Option<(String, String)> = None;
    let mut reply = String::new();

    // A prompt arrives in chunks: it is pushed once the next thing happens,
    // and handed back as the one now being answered.
    fn flush_prompt(
        out: &mut Builder,
        id: &Option<String>,
        text: &mut String,
        at: i64,
    ) -> Option<(String, String)> {
        if text.is_empty() {
            return None;
        }
        out.push(
            &time_of(at),
            "UserPromptSubmit",
            json!({ "prompt_id": id, "prompt": text }),
        );
        Some((id.clone().unwrap_or_default(), std::mem::take(text)))
    }
    // What the answer to a review command says it found, once it is over.
    fn flush_reply(
        said: &mut Vec<ReviewSaid>,
        asked: &mut Option<(String, String)>,
        reply: &mut String,
    ) {
        if let Some((id, prompt)) = asked.take() {
            if crate::reviews::is_typed_review(&prompt) {
                said.extend(crate::reviews::review_said(&id, reply));
            }
        }
        reply.clear();
    }

    crate::jsonl::for_each(updates, |row| {
        let Some(at) = row["timestamp"].as_i64() else {
            return;
        };
        thread.first = Some(thread.first.map_or(at, |f| f.min(at)));
        thread.last = Some(thread.last.map_or(at, |l| l.max(at)));
        let update = &row["params"]["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or_default();
        if kind != "user_message_chunk" {
            if let Some(now) = flush_prompt(out, &prompt_id, &mut prompt_text, prompt_started) {
                flush_reply(&mut thread.said, &mut asked, &mut reply);
                asked = Some(now);
            }
        }
        match kind {
            "agent_message_chunk" => {
                reply.push_str(update["content"]["text"].as_str().unwrap_or_default());
            }
            // What a subagent was told is its parent's call, not the person's prompt.
            "user_message_chunk" if agent.is_some() => {}
            "user_message_chunk" => {
                let index = update["_meta"]["promptIndex"].as_u64().unwrap_or(0);
                let id = Some(format!("p{index}"));
                if id != prompt_id {
                    if let Some(now) =
                        flush_prompt(out, &prompt_id, &mut prompt_text, prompt_started)
                    {
                        flush_reply(&mut thread.said, &mut asked, &mut reply);
                        asked = Some(now);
                    }
                    prompt_id = id;
                    prompt_started = at;
                }
                prompt_text.push_str(update["content"]["text"].as_str().unwrap_or_default());
                if thread.model.is_none() {
                    thread.model = update["_meta"]["modelId"].as_str().map(String::from);
                }
            }
            // Written as the subagent starts, while the call that started it is still on.
            "subagent_spawned" => {
                let Some(spawned) = update["subagent_id"].as_str() else {
                    return;
                };
                let call = calls
                    .values_mut()
                    .filter(|c| c.name == "spawn_subagent" && c.started_agent.is_none())
                    .max_by_key(|c| c.started);
                if let Some(call) = call {
                    call.started_agent = Some(spawned.to_string());
                }
            }
            "tool_call" | "tool_call_update" => {
                // What was said before a tool call is not the last word.
                reply.clear();
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
                let base = call_payload(id, &call, agent);
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
                        let created = result["tool_name"] == "Write" && old.is_empty();
                        edit_result(&old, &new, created)
                    };
                    if let Some(started) = &call.started_agent {
                        result["tool_response"]["agentId"] = json!(started);
                    }
                    out.push(&time_of(at), "PostToolUse", result);
                }
            }
            "turn_completed" if agent.is_none() => {
                out.push(&time_of(at), "Stop", json!({ "prompt_id": prompt_id }))
            }
            "auto_compact_completed" if agent.is_none() => {
                out.push(&time_of(at), "PostCompact", json!({}))
            }
            _ => {}
        }
    })?;
    if let Some(now) = flush_prompt(out, &prompt_id, &mut prompt_text, prompt_started) {
        flush_reply(&mut thread.said, &mut asked, &mut reply);
        asked = Some(now);
    }
    thread.reply = reply.clone();
    flush_reply(&mut thread.said, &mut asked, &mut reply);
    // Calls that never reported an outcome.
    let mut open: Vec<(String, Call)> = calls.into_iter().collect();
    open.sort_by_key(|(_, call)| call.started);
    for (id, call) in open {
        out.push(
            &time_of(call.started),
            "PreToolUse",
            call_payload(&id, &call, agent),
        );
    }
    Ok(thread)
}

/// What a tool call's events say of it. A subagent's calls are its own, of
/// no prompt of the session's.
fn call_payload(id: &str, call: &Call, agent: Option<&str>) -> Value {
    let (tool, input) = canonical(call);
    let mut payload = json!({
        "prompt_id": call.prompt_id,
        "tool_use_id": id,
        "tool_name": tool,
        "tool_input": input,
    });
    if let Some(agent) = agent {
        payload["agent_id"] = json!(agent);
        payload["prompt_id"] = Value::Null;
    }
    payload
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
pub(crate) mod tests {
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
        let (events, facts) = session(&sample(dir.path()), &[]).unwrap();
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
    fn a_reviews_reply_says_what_it_found() {
        let dir = tempfile::tempdir().unwrap();
        let updates = sample(dir.path());
        let t0 = 1_794_212_700;
        let mut f = fs::OpenOptions::new().append(true).open(&updates).unwrap();
        for row in [
            update(
                t0 + 50,
                json!({ "sessionUpdate": "user_message_chunk", "_meta": { "promptIndex": 2 },
                        "content": { "type": "text", "text": "/code-review #41" } }),
            ),
            update(
                t0 + 55,
                json!({ "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "I found 2 issues." } }),
            ),
            update(t0 + 56, json!({ "sessionUpdate": "turn_completed" })),
        ] {
            writeln!(f, "{row}").unwrap();
        }
        let (events, facts) = session(&updates, &[]).unwrap();
        // What the reply says is a fact of the session, and no event of it.
        assert_eq!(events[0]["hook"], "SessionStart");
        let said = &facts.as_ref().unwrap().review_replies;
        assert_eq!((said.len(), said[0].findings), (1, 2));
        let s = crate::normalize::from_events(&events, facts.as_ref(), GROK).unwrap();
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.pull_number, r.findings))
            .collect();
        assert_eq!(runs, [(Some(41), Some(2))]);
    }

    /// A session in which `/review #64` ran its reviewer as a subagent: the
    /// parent's folder, and the reviewer's own beside it. The parent's usage
    /// counts the reviewer's model calls too.
    pub(crate) fn reviewed(dir: &Path) -> (PathBuf, PathBuf) {
        let t0 = 1_794_212_700;
        let parent = dir.join("%2Fwork%2Frepo/g1");
        let child = dir.join("%2Fwork%2Frepo/r1");
        fs::create_dir_all(parent.join("subagents/r1")).unwrap();
        fs::create_dir_all(&child).unwrap();
        let write = |path: PathBuf, rows: Vec<Value>| {
            let mut f = fs::File::create(path).unwrap();
            for row in rows {
                writeln!(f, "{row}").unwrap();
            }
        };
        write(
            parent.join("updates.jsonl"),
            vec![
                update(
                    t0,
                    json!({ "sessionUpdate": "user_message_chunk", "_meta": { "promptIndex": 0 },
                            "content": { "type": "text", "text": "/review #64" } }),
                ),
                update(t0 + 5, tool("c1", "spawn_subagent")),
                update(
                    t0 + 6,
                    json!({ "sessionUpdate": "subagent_spawned", "subagent_id": "r1",
                            "child_session_id": "r1", "description": "[reviewer] pr #64" }),
                ),
                update(
                    t0 + 300,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }),
                ),
                update(
                    t0 + 310,
                    json!({ "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": "Posted a pending review." } }),
                ),
                update(t0 + 311, json!({ "sessionUpdate": "turn_completed" })),
            ],
        );
        fs::write(
            parent.join("subagents/r1/meta.json"),
            json!({ "subagent_id": "r1", "child_session_id": "r1", "parent_session_id": "g1",
                    "subagent_type": "general-purpose", "description": "[reviewer] pr #64",
                    "status": "completed", "started_at": "2026-11-09T08:25:06.2Z",
                    "completed_at": "2026-11-09T08:29:50.5Z" })
            .to_string(),
        )
        .unwrap();
        fs::write(parent.join("usage.json"), json!({
            "session": { "costUsdTicks": 30_000_000_000u64, "modelUsage": { "grok-4.7-build": {
                "inputTokens": 900, "outputTokens": 90, "modelCalls": 9, "costUsdTicks": 30_000_000_000u64 } } }
        }).to_string()).unwrap();
        write(
            child.join("updates.jsonl"),
            vec![
                update(
                    t0 + 6,
                    json!({ "sessionUpdate": "user_message_chunk", "_meta": { "promptIndex": 0 },
                            "content": { "type": "text", "text": "You are a meticulous code reviewer." } }),
                ),
                update(t0 + 7, tool("k1", "read_file")),
                update(
                    t0 + 7,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": "k1",
                            "rawInput": { "variant": "ReadFile", "target_file": "/work/repo/a.rs" } }),
                ),
                update(
                    t0 + 8,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": "k1", "status": "completed" }),
                ),
                update(
                    t0 + 280,
                    json!({ "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": "I found 3 issues." } }),
                ),
                update(t0 + 281, json!({ "sessionUpdate": "turn_completed" })),
            ],
        );
        fs::write(
            child.join("summary.json"),
            json!({ "info": { "id": "r1", "cwd": "/work/repo" }, "session_kind": "subagent" })
                .to_string(),
        )
        .unwrap();
        fs::write(child.join("usage.json"), json!({
            "session": { "costUsdTicks": 20_000_000_000u64, "inputTokens": 600, "cachedReadTokens": 100,
                         "outputTokens": 60, "modelCalls": 6 }
        }).to_string()).unwrap();
        (parent.join("updates.jsonl"), child.join("updates.jsonl"))
    }

    #[test]
    fn a_subagent_is_read_into_the_session_that_started_it() {
        let dir = tempfile::tempdir().unwrap();
        let (parent, child) = reviewed(dir.path());
        assert_eq!(spawned(parent.parent().unwrap()), ["r1"]);
        let (events, facts) = session(&parent, std::slice::from_ref(&child)).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), GROK).unwrap();

        // What it was told is no prompt of the session's, and its calls are its own.
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["/review #64"]);
        let calls: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.agent_id.as_deref()))
            .collect();
        assert_eq!(calls, [("spawn_subagent", None), ("Read", Some("r1"))]);
        assert_eq!(s.files[0].reads, 1);

        let sub = &s.subagents[0];
        assert_eq!(
            (
                sub.agent_id.as_str(),
                sub.agent_type.as_deref(),
                sub.description.as_deref()
            ),
            ("r1", Some("general-purpose"), Some("[reviewer] pr #64"))
        );
        assert_eq!(
            (
                sub.tool_calls,
                sub.requests,
                sub.input_tokens,
                sub.output_tokens
            ),
            (1, 6, 500, 60)
        );
        assert_eq!(sub.estimated_cost_usd, Some(2.0));
        // The session's own figure already has the subagent's in it.
        assert_eq!(s.cost.as_ref().unwrap().total_usd, 3.0);

        // The review is its parent's: it ran in the subagent, and took as long as that did.
        let run = &s.reviews[0];
        assert_eq!(
            (
                run.command.as_str(),
                run.pull_number,
                run.subagents,
                run.estimated_cost_usd
            ),
            ("review", Some(64), 1, Some(2.0))
        );
        assert_eq!(run.duration_ms, Some(290_000));
    }

    #[test]
    fn a_subagent_whose_folder_is_gone_is_what_its_session_says() {
        let dir = tempfile::tempdir().unwrap();
        let (parent, _) = reviewed(dir.path());
        let (events, facts) = session(&parent, &[]).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), GROK).unwrap();
        assert_eq!(s.tool_calls.len(), 1);
        let sub = &s.subagents[0];
        assert_eq!(
            (
                sub.agent_id.as_str(),
                sub.tool_calls,
                sub.estimated_cost_usd
            ),
            ("r1", 0, None)
        );
        assert!(sub.started_at.is_some() && sub.ended_at.is_some());
        assert_eq!(
            (s.reviews[0].subagents, s.reviews[0].estimated_cost_usd),
            (1, None)
        );
    }

    #[test]
    fn the_parents_of_subagents_are_kept_once() {
        let dir = tempfile::tempdir().unwrap();
        assert!(parents(dir.path()).is_empty());
        let kept = BTreeMap::from([("r1".to_string(), "g1".to_string())]);
        save_parents(dir.path(), &kept).unwrap();
        assert_eq!(parents(dir.path()), kept);
        save_parents(dir.path(), &BTreeMap::new()).unwrap();
        assert!(parents(dir.path()).is_empty());
    }

    #[test]
    fn an_empty_session_imports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("p/s");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("updates.jsonl"), "").unwrap();
        let (events, facts) = session(&session_dir.join("updates.jsonl"), &[]).unwrap();
        assert!(events.is_empty() && facts.is_none());
        assert_eq!(session_bytes(&session_dir.join("updates.jsonl"), &[]), 0);
    }
}
