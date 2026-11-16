//! Backfill: rebuild a session's activity from the files an agent keeps about
//! it, for sessions the hooks did not capture (or captured only partly).
//!
//! Each agent's session files are turned into the same event records the
//! capture hook writes, so everything downstream (normalizing, rewrite rate,
//! ledger) works unchanged. The records are saved under `imported/<agent>/`,
//! which makes an imported session as durable as a captured one: it survives
//! the agent deleting its files. Tool results are reduced to what normalizing
//! needs, so the saved file is far smaller than the original.
//!
//! This file has the shared parts and Claude Code's transcripts; Grok,
//! Cursor and Codex are in `import_grok`, `import_cursor` and `import_codex`.
//!
//! What a Claude Code transcript cannot tell us: permission prompts that were
//! approved, and when the session ended.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{json, Value};

use crate::paths::{CLAUDE_CODE, CODEX, CURSOR, GROK};
use crate::transcript::{self, Facts};

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

/// Collects the events of one imported session.
pub(crate) struct Builder {
    source: &'static str,
    session_id: String,
    events: Vec<(String, Value)>,
}

impl Builder {
    pub(crate) fn new(source: &'static str, session_id: &str) -> Builder {
        Builder {
            source,
            session_id: session_id.to_string(),
            events: Vec::new(),
        }
    }

    /// Add an event. `at` is an RFC 3339 time, or empty if the source has none.
    pub(crate) fn push(&mut self, at: &str, hook: &str, mut payload: Value) {
        payload["session_id"] = json!(self.session_id);
        payload["hook_event_name"] = json!(hook);
        self.events.push((
            at.to_string(),
            json!({
                "v": crate::capture::RECORD_VERSION,
                "source": self.source,
                "origin": "transcript",
                "received_at": if at.is_empty() { Value::Null } else { json!(at) },
                "hook": hook,
                "session_id": self.session_id,
                "payload": payload,
            }),
        ));
    }

    /// Add `value` under `key` to the event added last, beside its payload.
    pub(crate) fn note(&mut self, key: &str, value: Value) {
        if let Some((_, event)) = self.events.last_mut() {
            event[key] = value;
        }
    }

    /// The events in time order, with the session start first among equals.
    /// The sort is stable, so events pushed in order stay in order.
    pub(crate) fn finish(mut self) -> Vec<Value> {
        self.events.sort_by(|a, b| {
            let rank = |e: &Value| u8::from(e["hook"] != "SessionStart");
            a.0.cmp(&b.0).then(rank(&a.1).cmp(&rank(&b.1)))
        });
        self.events.into_iter().map(|(_, event)| event).collect()
    }

    /// The events as they were added, for a source where only some have a time.
    pub(crate) fn in_order(self) -> Vec<Value> {
        self.events.into_iter().map(|(_, event)| event).collect()
    }
}

/// Patch lines (`+added`, `-removed`) taking `old` to `new`, comparing lines
/// as a multiset. Order is not kept; what the rest of the pipeline needs is
/// which lines appeared and which went away.
pub(crate) fn patch_lines(old: &str, new: &str) -> Vec<String> {
    let mut remaining: HashMap<&str, i64> = HashMap::new();
    for line in old.lines() {
        *remaining.entry(line).or_insert(0) += 1;
    }
    let mut patch = Vec::new();
    for line in new.lines() {
        match remaining.get_mut(line) {
            Some(n) if *n > 0 => *n -= 1,
            _ => patch.push(format!("+{line}")),
        }
    }
    for line in old.lines() {
        if let Some(n) = remaining.get_mut(line).filter(|n| **n > 0) {
            *n -= 1;
            patch.push(format!("-{line}"));
        }
    }
    patch
}

/// The result of a file edit as normalizing expects it. `created` marks a
/// file that did not exist before.
pub(crate) fn edit_result(old: &str, new: &str, created: bool) -> Value {
    let mut result = json!({
        "structuredPatch": [{ "lines": patch_lines(old, new) }],
        "_bytes": new.len(),
    });
    if created {
        result["type"] = json!("create");
    }
    result
}

/// Long strings in a tool's input, cut down: the import keeps what was asked
/// for, not whole files.
pub(crate) fn slim_input(input: &Value) -> Value {
    const KEEP: usize = 500;
    match input {
        Value::String(text) if text.len() > KEEP => {
            let end = (0..=KEEP)
                .rev()
                .find(|i| text.is_char_boundary(*i))
                .unwrap_or(0);
            json!(format!("{}…", &text[..end]))
        }
        Value::Array(items) => items.iter().map(slim_input).collect(),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| (k.clone(), slim_input(v)))
            .collect::<serde_json::Map<_, _>>()
            .into(),
        other => other.clone(),
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
    let mut out = Builder::new(CLAUDE_CODE, &session_id);
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

    Ok(out.finish())
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub imported: u64,
    pub up_to_date: u64,
    /// Sessions with nothing to import.
    pub empty: u64,
    pub failed: Vec<(PathBuf, String)>,
    /// How many sessions were imported, per agent.
    pub by_source: BTreeMap<String, u64>,
}

/// Where each agent keeps its session files. `None` means not installed.
#[derive(Debug, Default, Clone)]
pub struct AgentHomes {
    /// `~/.claude/projects`
    pub claude_projects: Option<PathBuf>,
    /// `~/.grok/sessions`
    pub grok_sessions: Option<PathBuf>,
    /// `~/.cursor/projects`
    pub cursor_projects: Option<PathBuf>,
    /// `~/.codex`, which has `sessions` and `archived_sessions`
    pub codex_home: Option<PathBuf>,
}

impl AgentHomes {
    pub fn detect() -> AgentHomes {
        let home = crate::paths::home_dir();
        let existing = |path: Option<PathBuf>| path.filter(|p| p.is_dir());
        AgentHomes {
            claude_projects: existing(transcript::claude_config_dir().map(|d| d.join("projects"))),
            grok_sessions: existing(
                std::env::var_os("GROK_HOME")
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
                    .or(home.as_ref().map(|h| h.join(".grok")))
                    .map(|d| d.join("sessions")),
            ),
            cursor_projects: existing(home.as_ref().map(|h| h.join(".cursor").join("projects"))),
            codex_home: existing(crate::paths::codex_home()),
        }
    }
}

/// Raised when an importer reads more, or differently, from the same files,
/// so that sessions imported by an older binary are imported again.
const IMPORT_VERSION: u64 = 5;

/// The source file, its size and the importer's version recorded in an
/// import file's first record.
fn imported_from(import_file: &Path) -> Option<(PathBuf, u64, u64)> {
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
        payload["import_version"].as_u64().unwrap_or(1),
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

/// One session an agent has files for.
struct Found {
    source: &'static str,
    session_id: String,
    /// The main file of the session: what an import records as its origin.
    path: PathBuf,
    /// A Cursor session with no transcript yet: `path` is its hook capture.
    hooks_only: bool,
    /// A Codex session's subagents: each is a thread with a file of its own.
    subagents: Vec<PathBuf>,
}

/// The raw hook capture of a session, which a Cursor import also reads.
fn capture_of(found: &Found, data_dir: &Path) -> PathBuf {
    let stem = crate::capture::file_stem(Some(&found.session_id));
    data_dir
        .join("raw")
        .join(found.source)
        .join(format!("{stem}.jsonl"))
}

/// Combined size of the files a session is imported from. An import is redone
/// when this changes.
fn source_bytes(found: &Found, data_dir: &Path) -> u64 {
    let size = |path: &Path| fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    match found.source {
        GROK => crate::import_grok::session_bytes(&found.path),
        CODEX => crate::import_codex::session_bytes(&found.path, &found.subagents),
        CURSOR if found.hooks_only => size(&found.path),
        CURSOR => {
            crate::import_cursor::session_bytes(&found.path) + size(&capture_of(found, data_dir))
        }
        _ => transcript::tree_size(&found.path),
    }
}

/// Import one session into `data_dir` unless its import is already current.
fn import_one(found: &Found, data_dir: &Path, report: &mut Report) {
    let stem = crate::capture::file_stem(Some(&found.session_id));
    let target = data_dir
        .join("imported")
        .join(found.source)
        .join(format!("{stem}.jsonl"));
    let bytes = source_bytes(found, data_dir);
    if imported_from(&target) == Some((found.path.clone(), bytes, IMPORT_VERSION)) {
        report.up_to_date += 1;
        return;
    }
    let built: Result<(Vec<Value>, Option<Facts>)> = match found.source {
        GROK => crate::import_grok::session(&found.path),
        CODEX => crate::import_codex::session(&found.path, &found.subagents),
        CURSOR if found.hooks_only => crate::import_cursor::session_from_hooks(&found.path),
        CURSOR => {
            let capture = capture_of(found, data_dir);
            crate::import_cursor::session(&found.path, capture.exists().then_some(&*capture))
        }
        _ => events_from_transcript(&found.path).map(|events| (events, None)),
    };
    let result = built.and_then(|(mut events, facts)| {
        let Some(start) = events.iter_mut().find(|e| e["hook"] == "SessionStart") else {
            return Ok(false);
        };
        // Recorded so a later run can tell whether the source has changed.
        start["payload"]["transcript_path"] = json!(found.path);
        start["payload"]["transcript_bytes"] = json!(bytes);
        start["payload"]["import_version"] = json!(IMPORT_VERSION);
        if let Some(facts) = facts {
            let facts_path = data_dir
                .join("transcript-facts")
                .join(found.source)
                .join(format!("{stem}.json"));
            facts.save(&facts_path)?;
        }
        write_import(&target, &events)?;
        Ok(true)
    });
    match result {
        Ok(true) => {
            report.imported += 1;
            *report
                .by_source
                .entry(found.source.to_string())
                .or_insert(0) += 1;
        }
        Ok(false) => report.empty += 1,
        Err(err) => report.failed.push((found.path.clone(), format!("{err:#}"))),
    }
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Every session the installed agents have files for, and every Cursor
/// session the hooks have captured that Cursor has no transcript for yet.
fn find_sessions(homes: &AgentHomes, data_dir: &Path) -> Vec<Found> {
    let mut found = Vec::new();
    // Claude Code: <projects>/<project>/<session>.jsonl
    for project in homes.claude_projects.iter().flat_map(|d| subdirs(d)) {
        let mut files: Vec<PathBuf> = fs::read_dir(&project)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect();
        files.sort();
        for path in files {
            let session_id = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            found.push(Found {
                source: CLAUDE_CODE,
                session_id,
                path,
                hooks_only: false,
                subagents: Vec::new(),
            });
        }
    }
    // Grok: <sessions>/<encoded cwd>/<session>/updates.jsonl
    for project in homes.grok_sessions.iter().flat_map(|d| subdirs(d)) {
        for session in subdirs(&project) {
            let path = session.join("updates.jsonl");
            if path.is_file() {
                found.push(Found {
                    source: GROK,
                    session_id: name_of(&session),
                    path,
                    hooks_only: false,
                    subagents: Vec::new(),
                });
            }
        }
    }
    // Cursor: <projects>/<project>/agent-transcripts/<session>/<session>.jsonl
    for project in homes.cursor_projects.iter().flat_map(|d| subdirs(d)) {
        for session in subdirs(&project.join("agent-transcripts")) {
            let session_id = name_of(&session);
            let path = session.join(format!("{session_id}.jsonl"));
            if path.is_file() {
                found.push(Found {
                    source: CURSOR,
                    session_id,
                    path,
                    hooks_only: false,
                    subagents: Vec::new(),
                });
            }
        }
    }
    // Codex: <home>/sessions/<year>/<month>/<day>/rollout-<time>-<thread>.jsonl,
    // and archived ones side by side in <home>/archived_sessions.
    let mut rollouts: BTreeMap<String, PathBuf> = BTreeMap::new();
    if let Some(home) = &homes.codex_home {
        let days = subdirs(&home.join("sessions"))
            .into_iter()
            .flat_map(|year| subdirs(&year))
            .flat_map(|month| subdirs(&month));
        for dir in days.chain([home.join("archived_sessions")]) {
            let mut files: Vec<PathBuf> = fs::read_dir(&dir)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .collect();
            files.sort();
            for path in files {
                // A thread that was reverted has a second file: the later one counts.
                if let Some(thread) = crate::import_codex::thread_id(&path) {
                    rollouts.insert(thread, path);
                }
            }
        }
    }
    // A subagent's thread belongs to the session of the thread that began it.
    // One whose session's file is gone stands on its own.
    let threads: Vec<String> = rollouts.keys().cloned().collect();
    let mut subagents: HashMap<String, Vec<PathBuf>> = HashMap::new();
    rollouts.retain(|thread, path| {
        let root = crate::import_codex::root_of(path);
        match root.filter(|root| root != thread && threads.contains(root)) {
            Some(root) => {
                subagents.entry(root).or_default().push(path.clone());
                false
            }
            None => true,
        }
    });
    for (session_id, path) in rollouts {
        found.push(Found {
            source: CODEX,
            subagents: subagents.remove(&session_id).unwrap_or_default(),
            session_id,
            path,
            hooks_only: false,
        });
    }
    // Cursor writes a transcript when a turn ends. A session the hooks have
    // captured and that has none yet is read from its capture alone.
    let captures = fs::read_dir(data_dir.join("raw").join(CURSOR));
    let mut captures: Vec<PathBuf> = captures
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    captures.sort();
    for path in captures {
        let session_id = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let has_transcript = found.iter().any(|f| {
            f.source == CURSOR && crate::capture::file_stem(Some(&f.session_id)) == session_id
        });
        if !has_transcript {
            found.push(Found {
                source: CURSOR,
                session_id,
                path,
                hooks_only: true,
                subagents: Vec::new(),
            });
        }
    }
    found
}

/// Import sessions from every installed agent: all of them, or only those of
/// the agents in `agents` and whose id starts with one of `only`.
pub fn import_all(
    homes: &AgentHomes,
    data_dir: &Path,
    agents: &[String],
    only: &[String],
) -> Report {
    let mut report = Report::default();
    for found in find_sessions(homes, data_dir) {
        let wanted_agent = agents.is_empty() || agents.iter().any(|a| a == found.source);
        let wanted_id = only.is_empty()
            || only
                .iter()
                .any(|p| found.session_id.starts_with(p.as_str()));
        if wanted_agent && wanted_id {
            import_one(&found, data_dir, &mut report);
        }
    }
    report
}

/// Keep imports current without importing anything new by surprise: redo the
/// import of a session that was imported before, or that the hooks have
/// captured, when its files have changed.
pub fn refresh(homes: &AgentHomes, data_dir: &Path) -> Report {
    let mut report = Report::default();
    for found in find_sessions(homes, data_dir) {
        let file = format!(
            "{}.jsonl",
            crate::capture::file_stem(Some(&found.session_id))
        );
        let imported = data_dir.join("imported").join(found.source).join(&file);
        let captured = data_dir.join("raw").join(found.source).join(&file);
        // A Claude Code session captured from its start needs no import. In
        // a sandbox nobody will run `import` for one whose capture began
        // partway (it moved in from a sandbox that is gone), so it is done here.
        let wanted = imported.exists()
            || (captured.exists() && (found.source != CLAUDE_CODE || crate::runtime::in_cloud()));
        if wanted {
            import_one(&found, data_dir, &mut report);
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

        let s = crate::normalize::from_events(&events, None, "claude-code").unwrap();
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

    fn claude_only(projects: &Path) -> AgentHomes {
        AgentHomes {
            claude_projects: Some(projects.to_path_buf()),
            ..Default::default()
        }
    }

    #[test]
    fn saved_import_is_small_and_refreshes_when_the_transcript_grows() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = sample(dir.path());
        let data = dir.path().join("data");
        let homes = claude_only(dir.path());

        let first = import_all(&homes, &data, &[], &[]);
        assert_eq!(
            (first.imported, first.up_to_date, first.failed.len()),
            (1, 0, 0)
        );
        assert_eq!(first.by_source["claude-code"], 1);
        let file = data.join("imported/claude-code/sess-1.jsonl");
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
        let s = crate::normalize::from_events(&events, None, "claude-code").unwrap();
        assert!(s.tool_calls[0].output_bytes.unwrap() > 5000);

        assert_eq!(import_all(&homes, &data, &[], &[]).up_to_date, 1);
        assert_eq!(refresh(&homes, &data).up_to_date, 1);

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
        assert_eq!(refresh(&homes, &data).imported, 1);
        assert!(fs::read_to_string(&file).unwrap().contains("third"));

        // only the named sessions and tools; an unknown prefix matches nothing
        assert_eq!(
            import_all(&homes, &data, &[], &["zzz".to_string()]),
            Report::default()
        );
        assert_eq!(
            import_all(&homes, &data, &["grok".to_string()], &[]),
            Report::default()
        );
        // the transcript goes away: the import stays as it is
        fs::remove_dir_all(dir.path().join("proj")).unwrap();
        assert_eq!(refresh(&homes, &data), Report::default());
        assert!(file.exists());
    }

    #[test]
    fn refresh_never_imports_a_claude_session_for_the_first_time() {
        let dir = tempfile::tempdir().unwrap();
        sample(dir.path());
        let data = dir.path().join("data");
        assert_eq!(refresh(&claude_only(dir.path()), &data), Report::default());
        assert!(!data.join("imported").exists());
    }

    #[test]
    fn a_cursor_session_is_read_from_its_capture_until_it_has_a_transcript() {
        use crate::cursor_hooks::tests::{event, write};
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let homes = AgentHomes {
            cursor_projects: Some(dir.path().join("projects")),
            ..Default::default()
        };
        write(
            &data.join("raw/cursor/k5.jsonl"),
            &[
                event(1, "beforeSubmitPrompt", "g1", json!({ "prompt": "first" })),
                event(
                    2,
                    "preToolUse",
                    "g1",
                    json!({ "tool_use_id": "c1", "tool_name": "Shell", "tool_input": { "command": "ls" } }),
                ),
            ],
        );
        // the blank chat Cursor announces before anyone types
        write(
            &data.join("raw/cursor/empty-state-draft.jsonl"),
            &[event(1, "sessionStart", "", json!({}))],
        );
        let report = refresh(&homes, &data);
        assert_eq!((report.imported, report.empty), (1, 1));
        let imported = data.join("imported/cursor/k5.jsonl");
        let prompts = |path: &Path| {
            fs::read_to_string(path)
                .unwrap()
                .matches("UserPromptSubmit")
                .count()
        };
        assert_eq!(prompts(&imported), 2); // the hook's name appears twice per event
        assert_eq!(refresh(&homes, &data).up_to_date, 1);

        // the turn ends and Cursor writes the transcript: it takes over
        let transcript = dir.path().join("projects/p/agent-transcripts/k5/k5.jsonl");
        write_rows(
            &transcript,
            &[
                json!({ "role": "user", "message": { "content": [{ "type": "text", "text": "first" }] } }),
                json!({ "role": "user", "message": { "content": [{ "type": "text", "text": "second" }] } }),
            ],
        );
        assert_eq!(refresh(&homes, &data).imported, 1);
        assert_eq!(prompts(&imported), 4);
        assert_eq!(imported_from(&imported).unwrap().0, transcript);
    }

    #[test]
    fn a_codex_session_takes_its_subagents_threads_with_it() {
        use crate::import_codex::tests::{sample, subagent, MAIN};
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        let (rollout, child) = (sample(&home), subagent(&home));
        fs::write(home.join("sessions/2026/11/16/notes.jsonl"), "{}\n").unwrap();
        let data = dir.path().join("data");
        let homes = AgentHomes {
            codex_home: Some(home),
            ..Default::default()
        };
        // nothing is imported for the first time by a sync
        assert_eq!(refresh(&homes, &data), Report::default());

        let report = import_all(&homes, &data, &["codex".to_string()], &[]);
        assert_eq!((report.imported, report.failed.len()), (1, 0));
        assert_eq!(report.by_source["codex"], 1);
        let imported = data.join(format!("imported/codex/{MAIN}.jsonl"));
        let saved = fs::read_to_string(&imported).unwrap();
        assert!(saved.contains("SubagentStart") && saved.contains("rg TODO"));
        assert!(data
            .join(format!("transcript-facts/codex/{MAIN}.json"))
            .exists());
        assert_eq!(imported_from(&imported).unwrap().0, rollout);
        assert_eq!(refresh(&homes, &data).up_to_date, 1);

        // the subagent goes on: its session is imported again
        let mut f = fs::OpenOptions::new().append(true).open(&child).unwrap();
        writeln!(f, "{{}}").unwrap();
        assert_eq!(refresh(&homes, &data).imported, 1);

        // a session the hooks have seen is imported without being asked for
        let data = dir.path().join("fresh");
        write_rows(
            &data.join(format!("raw/codex/{MAIN}.jsonl")),
            &[json!({ "hook": "Stop", "payload": { "session_id": MAIN } })],
        );
        assert_eq!(refresh(&homes, &data).imported, 1);
    }

    #[test]
    fn patches_compare_lines_as_a_multiset() {
        assert_eq!(patch_lines("a\nb\nb\n", "b\nc\nb\na\n"), ["+c"]);
        assert_eq!(patch_lines("a\nb\n", "a\n"), ["-b"]);
        assert_eq!(patch_lines("x\n", "x\nx\n"), ["+x"]);
        assert_eq!(patch_lines("", "one\ntwo"), ["+one", "+two"]);
        assert!(patch_lines("same", "same").is_empty());
        let created = edit_result("", "a\nb\n", true);
        assert_eq!(created["type"], "create");
        assert_eq!(created["structuredPatch"][0]["lines"], json!(["+a", "+b"]));
        assert!(edit_result("a", "b", false).get("type").is_none());
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
        let s = crate::normalize::from_events(&events, None, "claude-code").unwrap();
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
        let report = import_all(&claude_only(dir.path()), &dir.path().join("data"), &[], &[]);
        assert_eq!(report.empty, 1);
    }
}
