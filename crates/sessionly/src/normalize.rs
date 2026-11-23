//! Build a normalized [`Session`] from captured hook events and the transcript.
//!
//! Hook events give the structure (prompts, tool calls, files, subagents);
//! the transcript gives tokens, cost, models and the git branch.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::session::*;
use crate::transcript::{self, Facts};

const PREVIEW_CHARS: usize = 200;

/// A session built from a raw capture file.
pub struct Built {
    pub session: Session,
    /// Where the hooks said the transcript is, whether or not it still exists.
    pub transcript_path: Option<PathBuf>,
    /// Hashes of the lines the agent added, per changed file and model (see `rewrite`).
    pub added_lines: Vec<crate::rewrite::FileLines>,
    /// What a cloud platform said about the session, if it ran in one.
    pub runtime: Option<crate::runtime::Seen>,
}

/// Read a capture or import file of one agent (`source`), add what is known
/// about cost and usage, and normalize. Returns `None` if the file holds no
/// usable events.
///
/// For Claude Code the facts come from its transcript: they are saved in
/// `facts_dir` after each successful read and loaded from there when the
/// transcript itself is gone. For other agents the importer saved them.
pub fn build_from_raw(raw_path: &Path, facts_dir: &Path, source: &str) -> Result<Option<Built>> {
    build_with(raw_path, facts_dir, source, &HashMap::new())
}

/// As `build_from_raw`, with what hook captures saw shell commands change
/// (`seen`, from `changes::seen_in`) put with the same commands in the file.
pub fn build_with(
    raw_path: &Path,
    facts_dir: &Path,
    source: &str,
    seen: &HashMap<String, Value>,
) -> Result<Option<Built>> {
    let mut events: Vec<Value> = Vec::new();
    crate::jsonl::for_each(raw_path, |record| events.push(record))?;
    crate::changes::add_seen(&mut events, seen);
    let transcript_path = events
        .iter()
        .find_map(|e| e["payload"]["transcript_path"].as_str())
        .map(PathBuf::from);
    let saved = facts_dir.join(format!(
        "{}.json",
        raw_path.file_stem().unwrap_or_default().to_string_lossy()
    ));
    let claude_transcript = transcript_path
        .as_deref()
        .filter(|p| source == crate::paths::CLAUDE_CODE && p.is_file());
    let facts = match claude_transcript {
        Some(path) => {
            let facts = transcript::parse(path)?.facts();
            facts.save(&saved)?;
            Some(facts)
        }
        None => Facts::load(&saved),
    };
    let Some((mut session, reviews)) = assemble(&events, facts.as_ref(), source) else {
        return Ok(None);
    };
    // Nothing was asked and no tool ran: an agent that was opened and closed
    // again, or the blank chat Cursor announces before anyone types.
    let spent = session.cost.as_ref().is_some_and(|c| c.total_usd > 0.0);
    if session.prompts.is_empty() && session.tool_calls.is_empty() && !spent {
        return Ok(None);
    }
    let runtime = crate::runtime::Seen::of(&events);
    add_local_context(&mut session, facts.as_ref(), runtime.as_ref());
    // After the repository is known: a review's runs are read against it.
    add_reviews(&mut session, &reviews, facts.as_ref());
    // A call whose model is not known is put down to the session's main one.
    let main = session.models.first();
    let models: HashMap<&str, &str> = session
        .tool_calls
        .iter()
        .filter_map(|c| Some((c.tool_use_id.as_str(), c.model.as_ref().or(main)?.as_str())))
        .collect();
    let added_lines = crate::rewrite::added_lines_by_model(&events, &models);
    Ok(Some(Built {
        session,
        transcript_path,
        added_lines,
        runtime,
    }))
}

/// True for what a skill is called (`code-review`, `plugin:name`), which is
/// kept: the model writes the field, and anything else in it is text that is
/// not.
fn is_skill_name(written: &str) -> bool {
    let shaped = |c: char| c.is_alphanumeric() || "_-:.".contains(c);
    !written.is_empty() && written.chars().count() <= 100 && written.chars().all(shaped)
}

/// Repository and user details read from the local machine, and for a
/// session in the cloud (`runtime`) what the platform said instead.
fn add_local_context(
    session: &mut Session,
    facts: Option<&Facts>,
    runtime: Option<&crate::runtime::Seen>,
) {
    // A sandbox holds one session and the one branch its agent makes for the
    // work: all of what it spent is that branch's, the turns before it was
    // made too.
    if let (Some(_), Some(cost)) = (runtime, session.cost.as_mut()) {
        cost.by_branch.clear();
    }
    if let Some(cwd) = session.cwd.as_deref().map(Path::new) {
        if let Some(root) = crate::git::repo_root(cwd) {
            let recorded = facts.and_then(|f| f.git_branch.clone());
            session.repo = Some(Repo {
                remote: crate::git::origin_remote(&root),
                // A sandbox holds one session, and its agent makes a branch
                // for the work after the session has begun: the branch
                // checked out now is the session's. On a person's machine it
                // may be anything by now, so only the transcript is believed.
                branch: match runtime {
                    Some(_) => crate::git::current_branch(&root).or(recorded),
                    None => recorded,
                },
                root: root.to_string_lossy().into_owned(),
            });
        }
        let (name, email) = crate::git::user(cwd);
        if name.is_some() || email.is_some() {
            session.user = Some(User { name, email });
        }
    }
    if let Some(runtime) = runtime {
        apply_runtime(session, runtime);
    }
}

/// Mark a session as having run in the cloud. Git there is set up as the
/// agent, so the person is the one the platform named, or nobody.
pub fn apply_runtime(session: &mut Session, runtime: &crate::runtime::Seen) {
    // A Cursor cloud agent's session id is the agent's id (`bc-…`), should
    // its socket not have said so.
    let own = (session.source == crate::paths::CURSOR && session.session_id.starts_with("bc-"))
        .then(|| session.session_id.clone());
    session.runtime = Some(Runtime {
        kind: RuntimeKind::Cloud,
        id: runtime.id.clone().or(own),
    });
    session.user = runtime.user_email.clone().map(|email| User {
        name: None,
        email: Some(email),
    });
    if session.entrypoint.is_none() {
        session.entrypoint = runtime.started_from.clone();
    }
}

/// Normalize raw capture records (the envelopes written by `sessionly capture`),
/// where the session ran in no repository that is known.
#[cfg(test)]
pub fn from_events(events: &[Value], facts: Option<&Facts>, source: &str) -> Option<Session> {
    let (mut s, reviews) = assemble(events, facts, source)?;
    add_reviews(&mut s, &reviews, facts);
    Some(s)
}

/// The session's review runs and their count, from what its events showed.
pub(crate) fn add_reviews(s: &mut Session, seen: &crate::reviews::Seen, facts: Option<&Facts>) {
    s.reviews = crate::reviews::runs(s, seen, facts);
    // Codex's `/review` is in its rollout only: without what that says, how
    // many there were is not known, which is not none.
    let unseen = s.source == crate::paths::CODEX && !facts.is_some_and(|f| f.review_modes_read);
    let counted = crate::reviews::counted(&s.source) && !unseen;
    s.counts.reviews = counted.then_some(s.reviews.len() as u64);
}

/// The session without its review runs, and what its events showed of them.
pub(crate) fn assemble(
    events: &[Value],
    facts: Option<&Facts>,
    source: &str,
) -> Option<(Session, crate::reviews::Seen)> {
    let mut s = Session {
        schema_version: SCHEMA_VERSION,
        source: source.into(),
        collector_version: env!("CARGO_PKG_VERSION").into(),
        ..Default::default()
    };
    let mut tool_ix: HashMap<String, usize> = HashMap::new();
    let mut sub_ix: HashMap<String, usize> = HashMap::new();
    let mut created: HashSet<String> = HashSet::new();
    // What shell commands changed, by the call's place in `tool_calls`.
    let mut by_shell: HashMap<usize, Vec<FileTouched>> = HashMap::new();
    let mut reviews = crate::reviews::Seen::default();
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
        if record["origin"].as_str() == Some("transcript") {
            s.captured_by = CapturedBy::Transcript;
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

        let hook = record["hook"].as_str().unwrap_or_default();
        reviews.event(source, hook, p, at);
        // A shell command says nothing of what it changed. In a sandbox the
        // capture looked at the working tree around it (see `changes`).
        if matches!(hook, "PostToolUse" | "PostToolUseFailure") {
            let changed: Vec<FileTouched> = crate::changes::of(record)
                .map(|(path, created, lines)| {
                    let (added, removed) = count_patch(lines);
                    FileTouched {
                        path: path.to_string(),
                        writes: 1,
                        created,
                        lines_added: added,
                        lines_removed: removed,
                        ..Default::default()
                    }
                })
                .collect();
            let id = p["tool_use_id"].as_str().unwrap_or_default();
            if !changed.is_empty() && tool_call(&mut s, &mut tool_ix, p, at).is_some() {
                by_shell.entry(tool_ix[id]).or_default().extend(changed);
            }
        }
        match hook {
            "SessionStart" => {
                start_model = text("model").or(start_model);
                // A session that starts again is open again.
                s.end_reason = None;
                // Any other source (resume, compact) means it began earlier.
                if matches!(p["source"].as_str(), Some("startup" | "clear" | "fork")) {
                    s.captured_from_start = true;
                }
            }
            "SessionEnd" => s.end_reason = text("reason"),
            "UserPromptSubmit" => s.prompts.push(Prompt {
                prompt_id: turn_of(p),
                at,
                text: summarize(p["prompt"].as_str().unwrap_or_default()),
                ..Default::default()
            }),
            hook @ ("Stop" | "StopFailure") => {
                let id = turn_of(p);
                // A turn can stop more than once (a stop hook can make the agent
                // continue); the latest stop is when it really ended.
                if let Some(prompt) = s.prompts.iter_mut().rev().find(|pr| pr.prompt_id == id) {
                    prompt.ended_at = at;
                    if hook == "Stop" {
                        prompt.outcome = Some(Outcome::Completed);
                    } else {
                        prompt.outcome = Some(Outcome::ApiError);
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
                    call.status = ToolStatus::Ok;
                    call.duration_ms = p["duration_ms"].as_u64();
                    let response = &p["tool_response"];
                    // An imported result is reduced and carries its original size.
                    call.output_bytes = Some(
                        response["_bytes"]
                            .as_u64()
                            .unwrap_or(response.to_string().len() as u64),
                    );
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
                    call.status = if interrupted {
                        ToolStatus::Interrupted
                    } else {
                        ToolStatus::Failed
                    };
                    call.duration_ms = p["duration_ms"].as_u64();
                    call.error = p["error"].as_str().map(|e| truncate(e, PREVIEW_CHARS));
                }
            }
            // Only the transcript importer produces this: hooks don't say how
            // a permission prompt was answered.
            "ToolRejected" => {
                if let Some(call) = tool_call(&mut s, &mut tool_ix, p, at) {
                    call.status = ToolStatus::Rejected;
                }
            }
            "PermissionRequest" => s.counts.permission_requests += 1,
            "PermissionDenied" => {
                s.counts.permission_denials += 1;
                if let Some(call) = tool_call(&mut s, &mut tool_ix, p, at) {
                    call.status = ToolStatus::Denied;
                    call.error = p["reason"].as_str().map(|e| truncate(e, PREVIEW_CHARS));
                }
            }
            "SubagentStart" => {
                // Also fires when a subagent is resumed: keep the first start.
                if let Some(id) = text("agent_id").filter(|id| !sub_ix.contains_key(id)) {
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
            // SubagentStop without a SubagentStart: a stop alone doesn't make
            // a subagent. One with its own transcript is added from there.
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
    for (call, changed) in &by_shell {
        let call = &mut s.tool_calls[*call];
        call.lines_added += changed.iter().map(|f| f.lines_added).sum::<u64>();
        call.lines_removed += changed.iter().map(|f| f.lines_removed).sum::<u64>();
    }
    s.files = files_touched(&s.tool_calls, &created, &by_shell);
    for sub in &mut s.subagents {
        sub.tool_calls = s
            .tool_calls
            .iter()
            .filter(|c| c.agent_id.as_deref() == Some(sub.agent_id.as_str()))
            .count() as u64;
    }

    if let Some(facts) = facts {
        apply_facts(&mut s, facts, &mut sub_ix);
        first = first.into_iter().chain(facts.first_at).min();
        last = last.into_iter().chain(facts.last_at).max();
    }
    if s.models.is_empty() {
        s.models.extend(start_model);
    }
    s.started_at = first;
    s.ended_at = last;
    s.duration_ms = first.zip(last).map(|(f, l)| (l - f).num_milliseconds());

    s.counts.prompts = s.prompts.len() as u64;
    s.counts.tool_calls = s.tool_calls.len() as u64;
    s.counts.tool_failures = s
        .tool_calls
        .iter()
        .filter(|c| c.status == ToolStatus::Failed)
        .count() as u64;
    s.counts.subagents = s.subagents.len() as u64;
    s.counts.files_read = s.files.iter().filter(|f| f.reads > 0).count() as u64;
    s.counts.files_changed = s.files.iter().filter(|f| f.writes > 0).count() as u64;
    s.counts.lines_added = s.files.iter().map(|f| f.lines_added).sum();
    s.counts.lines_removed = s.files.iter().map(|f| f.lines_removed).sum();
    Some((s, reviews))
}

/// The turn a hook event belongs to. Claude Code names it `prompt_id`;
/// Codex's hooks name it `turn_id`.
fn turn_of(p: &Value) -> Option<String> {
    [&p["prompt_id"], &p["turn_id"]]
        .into_iter()
        .find_map(|id| id.as_str().filter(|id| !id.is_empty()))
        .map(String::from)
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
                prompt_id: turn_of(p),
                agent_id: text("agent_id"),
                model: text("model"),
                at,
                status: ToolStatus::NoResult,
                file_path: ["file_path", "notebook_path"]
                    .iter()
                    .find_map(|k| input[*k].as_str())
                    .map(String::from),
                input_sha256: sha256_hex(input.to_string().as_bytes()),
                input_summary: input_summary(&tool, input),
                skill: (tool == "Skill")
                    .then(|| input["skill"].as_str().filter(|v| is_skill_name(v)))
                    .flatten()
                    .map(String::from),
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
        return count_patch(
            hunks
                .iter()
                .filter_map(|h| h["lines"].as_array())
                .flatten()
                .filter_map(Value::as_str),
        );
    }
    // A newly created file has no patch: every line of the content is new.
    if response["type"].as_str() == Some("create") {
        let content = input["content"].as_str().unwrap_or_default();
        return (content.lines().count() as u64, 0);
    }
    (0, 0)
}

/// How many of a patch's lines are added (`+`) and removed (`-`).
fn count_patch<'a>(lines: impl Iterator<Item = &'a str>) -> (u64, u64) {
    let (mut added, mut removed) = (0, 0);
    for line in lines {
        match line.as_bytes().first() {
            Some(b'+') => added += 1,
            Some(b'-') => removed += 1,
            _ => {}
        }
    }
    (added, removed)
}

/// The files the session read or changed, in the order it first touched
/// them: through the file tools, and (`by_shell`, by the call's place in
/// `calls`) through shell commands where that is known.
fn files_touched(
    calls: &[ToolCall],
    created: &HashSet<String>,
    by_shell: &HashMap<usize, Vec<FileTouched>>,
) -> Vec<FileTouched> {
    let mut files: Vec<FileTouched> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (position, call) in calls.iter().enumerate() {
        // A command that failed may still have changed files.
        for changed in by_shell.get(&position).into_iter().flatten() {
            match index.get(changed.path.as_str()) {
                Some(&i) => {
                    files[i].writes += 1;
                    files[i].lines_added += changed.lines_added;
                    files[i].lines_removed += changed.lines_removed;
                }
                None => {
                    index.insert(&changed.path, files.len());
                    files.push(changed.clone());
                }
            }
        }
        if call.status != ToolStatus::Ok {
            continue;
        }
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

fn apply_facts(s: &mut Session, facts: &Facts, sub_ix: &mut HashMap<String, usize>) {
    s.agent_version = facts.version.clone();
    s.entrypoint = facts.entrypoint.clone();
    s.cost = facts.cost.clone();
    s.models = facts.usage.iter().map(|u| u.model.clone()).collect();
    s.usage = facts.usage.clone();
    for call in s.tool_calls.iter_mut().filter(|c| c.model.is_none()) {
        call.model = facts.tool_models.get(&call.tool_use_id).cloned();
    }
    for sub in &facts.subagents {
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
        record.requests = sub.requests;
        record.input_tokens = sub.input_tokens;
        record.output_tokens = sub.output_tokens;
        record.estimated_cost_usd = sub.estimated_cost_usd;
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
    fn a_skill_is_kept_by_its_name_and_not_by_text_in_its_place() {
        assert!(is_skill_name("code-review"));
        assert!(is_skill_name("acme_tools:security-review.v2"));
        assert!(!is_skill_name(""));
        assert!(!is_skill_name("code-review 62 see ~/clients/acme/notes"));
        assert!(!is_skill_name(&"a".repeat(101)));
    }

    #[test]
    fn normalizes_a_full_session() {
        let s = from_events(&sample(), None, "claude-code").unwrap();
        assert_eq!(s.session_id, "s1");
        assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(s.end_reason.as_deref(), Some("other"));
        assert!(s.captured_from_start);
        assert_eq!(s.collector_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(s.models, ["claude-opus-5-5"]);
        assert_eq!(s.permission_modes, ["default"]);
        assert_eq!(s.instruction_files, ["/home/u/.claude/CLAUDE.md"]);
        assert_eq!(s.duration_ms, Some(22_000));
        assert_eq!(s.active_ms, 20_000);
        assert!(s.cost.is_none());

        assert_eq!(s.prompts.len(), 1);
        assert_eq!(s.prompts[0].text.preview, "do the thing");
        assert_eq!(s.prompts[0].text.chars, 12);
        assert_eq!(s.prompts[0].outcome, Some(Outcome::Completed));

        use ToolStatus::{Failed, NoResult, Ok};
        let status: Vec<_> = s.tool_calls.iter().map(|c| c.status).collect();
        assert_eq!(status, [Ok, Failed, Ok, Ok, Ok, NoResult, Ok]);
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
        let s = from_events(&sample(), None, "claude-code").unwrap();
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
        let s = from_events(&events, None, "claude-code").unwrap();
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
        let s = from_events(&events, None, "claude-code").unwrap();
        assert_eq!(s.tool_calls[0].status, ToolStatus::Denied);
        assert_eq!(s.counts.permission_denials, 1);
        assert_eq!(s.counts.api_errors, 1);
        assert_eq!(s.prompts[0].outcome, Some(Outcome::ApiError));
        assert_eq!(s.prompts[0].error.as_deref(), Some("rate_limit"));
    }

    #[test]
    fn resumed_session_is_open_again_and_marked_partial() {
        let events = vec![
            event(1, "SessionStart", json!({ "source": "resume" })),
            event(2, "SessionEnd", json!({ "reason": "other" })),
            event(3, "SessionStart", json!({ "source": "resume" })),
        ];
        let s = from_events(&events, None, "claude-code").unwrap();
        assert_eq!(s.end_reason, None);
        assert!(!s.captured_from_start);
    }

    #[test]
    fn resumed_subagent_is_one_subagent() {
        let start = || json!({ "agent_id": "a1", "agent_type": "Explore" });
        let events = vec![
            event(1, "SubagentStart", start()),
            event(2, "SubagentStop", start()),
            event(3, "SubagentStart", start()),
            event(4, "SubagentStop", start()),
        ];
        let s = from_events(&events, None, "claude-code").unwrap();
        assert_eq!(s.counts.subagents, 1);
        assert_eq!(s.subagents[0].started_at.unwrap().timestamp() % 60, 1);
        assert_eq!(s.subagents[0].ended_at.unwrap().timestamp() % 60, 4);
    }

    #[test]
    fn a_turn_that_stops_twice_ends_at_the_last_stop() {
        let events = vec![
            event(
                1,
                "UserPromptSubmit",
                json!({ "prompt_id": "p1", "prompt": "go" }),
            ),
            event(5, "Stop", json!({ "prompt_id": "p1" })),
            event(9, "Stop", json!({ "prompt_id": "p1" })),
        ];
        assert_eq!(
            from_events(&events, None, "claude-code").unwrap().active_ms,
            8_000
        );
    }

    #[test]
    fn codex_hooks_name_the_turn_their_own_way() {
        let events = vec![
            event(
                1,
                "UserPromptSubmit",
                json!({ "turn_id": "t1", "prompt": "one" }),
            ),
            event(
                2,
                "PreToolUse",
                json!({ "turn_id": "t1", "tool_use_id": "c1", "tool_name": "Bash" }),
            ),
            event(3, "Stop", json!({ "turn_id": "t1" })),
            event(
                4,
                "UserPromptSubmit",
                json!({ "turn_id": "t2", "prompt": "two" }),
            ),
        ];
        let s = from_events(&events, None, "codex").unwrap();
        assert_eq!(s.tool_calls[0].prompt_id.as_deref(), Some("t1"));
        // the stop is the first turn's, not the last prompt's
        assert_eq!(s.prompts[0].outcome, Some(Outcome::Completed));
        assert_eq!(s.prompts[1].outcome, None);
    }

    #[test]
    fn transcript_facts_supply_cost_and_subagent_usage() {
        let facts = Facts {
            version: Some("2.1.302".into()),
            cost: Some(Cost {
                total_usd: 3.5,
                source: CostSource::Recorded,
                ..Default::default()
            }),
            usage: vec![ModelUsage {
                model: "claude-opus-5-5".into(),
                requests: 4,
                ..Default::default()
            }],
            subagents: vec![
                transcript::SubagentFacts {
                    agent_id: "a1".into(),
                    description: Some("look".into()),
                    output_tokens: 9,
                    ..Default::default()
                },
                transcript::SubagentFacts {
                    agent_id: "only-in-transcript".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let s = from_events(&sample(), Some(&facts), "claude-code").unwrap();
        assert_eq!(s.cost.as_ref().unwrap().total_usd, 3.5);
        assert_eq!(s.models, ["claude-opus-5-5"]);
        assert_eq!(s.agent_version.as_deref(), Some("2.1.302"));
        assert_eq!(s.subagents.len(), 2);
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("Explore"));
        assert_eq!(s.subagents[0].description.as_deref(), Some("look"));
        assert_eq!(s.subagents[0].output_tokens, 9);
    }

    #[test]
    fn cost_survives_a_deleted_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("t/s1.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &transcript,
            json!({ "type": "assistant", "timestamp": "2026-11-13T10:00:00Z",
                    "message": { "id": "m1", "model": "claude-opus-5-5",
                                 "usage": { "output_tokens": 1_000_000 } } })
            .to_string(),
        )
        .unwrap();
        let raw = dir.path().join("raw/s1.jsonl");
        std::fs::create_dir_all(raw.parent().unwrap()).unwrap();
        let mut start = event(0, "SessionStart", json!({ "source": "startup" }));
        start["payload"]["transcript_path"] = json!(transcript);
        start["payload"]["cwd"] = json!(dir.path().join("gone"));
        std::fs::write(&raw, format!("{start}\n\u{ff}not json\n")).unwrap();
        let facts_dir = dir.path().join("facts");

        let cost_of = || {
            let built = build_from_raw(&raw, &facts_dir, "claude-code")
                .unwrap()
                .unwrap();
            assert_eq!(built.transcript_path.as_deref(), Some(transcript.as_path()));
            built.session.cost.map(|c| c.total_usd)
        };
        assert_eq!(cost_of(), Some(20.0));
        std::fs::remove_file(&transcript).unwrap();
        assert_eq!(cost_of(), Some(20.0), "kept from the saved facts");
    }

    #[test]
    fn lines_are_put_down_to_the_model_that_wrote_them() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("t/s1.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let said = |id: &str, model: &str, tool: &str| {
            json!({ "type": "assistant", "timestamp": "2026-11-13T10:00:00Z",
                    "message": { "id": id, "model": model, "usage": { "output_tokens": 10 },
                                 "content": [{ "type": "text", "text": "ok" },
                                             { "type": "tool_use", "id": tool, "name": "Edit" }] } })
        };
        let rows = [
            said("m1", "claude-opus-5-5", "t1"),
            said("m2", "claude-haiku-5-5", "t2"),
            said("m3", "claude-opus-5-5", "t4"),
        ];
        let text: Vec<String> = rows.iter().map(Value::to_string).collect();
        std::fs::write(&transcript, text.join("\n")).unwrap();

        let edit = |second: u32, id: &str, line: &str| {
            event(
                second,
                "PostToolUse",
                json!({ "tool_use_id": id, "tool_name": "Edit",
                        "tool_input": { "file_path": "/r/a.rs" },
                        "tool_response": { "structuredPatch": [{ "lines": [format!("+{line}")] }] } }),
            )
        };
        let mut start = event(0, "SessionStart", json!({ "source": "startup" }));
        start["payload"]["transcript_path"] = json!(transcript);
        let events = [
            start,
            edit(1, "t1", "one();"),
            edit(2, "t2", "two();"),
            // a call the transcript does not have: the session's main model
            edit(3, "t3", "three();"),
        ];
        let raw = dir.path().join("raw/s1.jsonl");
        std::fs::create_dir_all(raw.parent().unwrap()).unwrap();
        let text: Vec<String> = events.iter().map(Value::to_string).collect();
        std::fs::write(&raw, text.join("\n")).unwrap();

        let check = || {
            let built = build_from_raw(&raw, &dir.path().join("facts"), "claude-code")
                .unwrap()
                .unwrap();
            let models: Vec<_> = built
                .session
                .tool_calls
                .iter()
                .map(|c| c.model.as_deref())
                .collect();
            assert_eq!(
                models,
                [Some("claude-opus-5-5"), Some("claude-haiku-5-5"), None]
            );
            let hash = |line: &str| crate::rewrite::line_hash(line).unwrap();
            let mut opus = vec![hash("one();"), hash("three();")];
            opus.sort_unstable();
            assert_eq!(
                built.added_lines[0].by_model,
                [
                    (Some("claude-haiku-5-5".to_string()), vec![hash("two();")]),
                    (Some("claude-opus-5-5".to_string()), opus),
                ]
            );
        };
        check();
        // which model made a call is kept with the saved facts
        std::fs::remove_file(&transcript).unwrap();
        check();
    }

    #[test]
    fn what_a_shell_command_changed_counts_as_the_sessions() {
        // Stored with the command's end by a capture in a sandbox.
        let shell = |second: u32, hook: &str, id: &str, changes: Value| {
            let input = json!({ "command": "sed -i s/y/x/ a.rs" });
            let mut ended = tool(second, hook, id, "Bash", input, json!({}));
            ended["changes"] = changes;
            ended
        };
        let events = [
            event(
                0,
                "SessionStart",
                json!({ "source": "startup", "model": "m1" }),
            ),
            shell(
                1,
                "PostToolUse",
                "b1",
                json!([{ "path": "/work/repo/a.rs", "status": "M", "lines": ["-y();", "+x();"] },
                       { "path": "/work/repo/new.txt", "status": "A", "lines": ["+one", "+two"] }]),
            ),
            tool(
                2,
                "PostToolUse",
                "e1",
                "Edit",
                json!({ "file_path": "/work/repo/a.rs" }),
                json!({ "tool_response": { "structuredPatch": [{ "lines": ["+z();"] }] } }),
            ),
            // A command that failed after taking out a line an earlier one added.
            shell(
                3,
                "PostToolUseFailure",
                "b2",
                json!([{ "path": "/work/repo/a.rs", "status": "M", "lines": ["-x();"] }]),
            ),
            // One whose change was seen and not counted adds nothing.
            {
                let mut skipped = shell(4, "PostToolUse", "b3", Value::Null);
                skipped["changes_skipped"] = json!("the commit checked out changed");
                skipped
            },
        ];
        let s = from_events(&events, None, "claude-code").unwrap();
        let calls: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.status, c.lines_added, c.lines_removed))
            .collect();
        assert_eq!(
            calls,
            [
                ("Bash", ToolStatus::Ok, 3, 1),
                ("Edit", ToolStatus::Ok, 1, 0),
                ("Bash", ToolStatus::Failed, 0, 1),
                ("Bash", ToolStatus::Ok, 0, 0),
            ]
        );
        let files: Vec<_> = s
            .files
            .iter()
            .map(|f| {
                (
                    f.path.as_str(),
                    f.created,
                    f.writes,
                    f.lines_added,
                    f.lines_removed,
                )
            })
            .collect();
        assert_eq!(
            files,
            [
                ("/work/repo/a.rs", false, 3, 2, 2),
                ("/work/repo/new.txt", true, 1, 2, 0),
            ]
        );
        assert_eq!(
            (
                s.counts.files_changed,
                s.counts.lines_added,
                s.counts.lines_removed
            ),
            (2, 4, 2)
        );

        // The line hashes follow: x() was taken out again, y() was never its own.
        let hash = |line: &str| crate::rewrite::line_hash(line).unwrap();
        let models = HashMap::from([("b1", "m1"), ("e1", "m2")]);
        let lines = crate::rewrite::added_lines_by_model(&events, &models);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0].by_model,
            [(Some("m2".to_string()), vec![hash("z();")])]
        );
        let mut new = vec![hash("one"), hash("two")];
        new.sort_unstable();
        assert_eq!(lines[1].by_model, [(Some("m1".to_string()), new)]);
    }

    #[test]
    fn no_events_no_session() {
        assert!(from_events(&[], None, "claude-code").is_none());
        assert!(from_events(
            &[json!({ "payload": { "_unparsed": "x" } })],
            None,
            "claude-code"
        )
        .is_none());
    }
}
