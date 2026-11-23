//! Import sessions of OpenAI's Codex from the rollout files it keeps under
//! `~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<thread>.jsonl`
//! (and `~/.codex/archived_sessions/`).
//!
//! A rollout is the thread as a stream of records, each `{timestamp, type,
//! payload}` (format is internal to Codex, read from its source at 0.169.0):
//! - `session_meta`: thread id, working directory, version, git branch. The
//!   first one is the file's own; a fork carries its parent's after it.
//! - `turn_context`: the model and working directory of a turn.
//! - `response_item`: what went to and came from the model. Tool calls
//!   (`function_call`, `custom_tool_call`) and their output are read from here.
//! - `event_msg`: turn starts and ends, prompts, and what Codex itself noted
//!   about a command or a patch.
//! - `token_usage_record`: the tokens of one model response.
//!
//! Codex writes two layouts. The older one has prompts as `user_message`
//! events, and commands and patches only as the model's tool calls. The newer
//! (`history_mode: paginated`, what 0.169.0 writes) has `item_completed`
//! events: the prompt, each command that ran with its exit code and time,
//! each patch with the diff of every file. There the items are the record of
//! what ran: the model may reach its tools through a script (a call to `exec`
//! holding JavaScript), which says little by itself. Both are read.
//!
//! Going back to an earlier turn (a revert) starts a new file for the thread,
//! `…-<thread>_<rollout>.jsonl`, whose `history_base` says how much of the
//! file before it still stands. That much is read first, then the new file.
//! A fork is a thread of its own and can point at its parent's file the same
//! way: that part is the parent's session and is not read again here.
//!
//! A subagent is a thread of its own with its own rollout, whose
//! `session_id` is the thread that started it all. Those are folded into that
//! session, as Claude Code's subagents are.
//!
//! Codex names its tools differently from Claude Code. The common ones are
//! mapped to the same names (Bash, Edit, Write, Read, Agent, WebSearch) so
//! sessions from different agents can be compared. One `apply_patch` call can
//! change several files: it becomes one Edit or Write per file.
//!
//! A rollout may be compressed (`rollout-….jsonl.zst`): it is read the same.
//!
//! Codex records tokens, not what anything cost. The cost is an estimate:
//! each response's tokens at OpenAI's API list prices (`pricing`), which is
//! not what a ChatGPT plan bills. A model with no listed price has none.
//!
//! What a rollout cannot tell us: in the older layout, the lines of a file a
//! patch deleted.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::import::{edit_result, slim_input, Builder};
use crate::paths::CODEX;
use crate::session::{Cost, ModelUsage};
use crate::transcript::{Facts, ReviewMode, ReviewerThread, SubagentFacts};

/// What is between `rollout-` and `.jsonl` (or `.jsonl.zst`) in a rollout's
/// file name.
fn stem_of(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let name = name.strip_prefix("rollout-")?;
    name.strip_suffix(".jsonl")
        .or_else(|| name.strip_suffix(".jsonl.zst"))
}

/// The thread a rollout file belongs to, from its name:
/// `rollout-2026-11-16T10-00-00-<thread>.jsonl`, or after a revert
/// `…-<thread>_<rollout>.jsonl`; either may end in `.zst`.
pub fn thread_id(path: &Path) -> Option<String> {
    let stem = stem_of(path)?;
    // 19 characters of time, then a dash
    let id = stem.get(20..)?.split('_').next()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// What a rollout's first record says of where its thread came from.
struct Origin {
    /// The thread itself.
    id: Option<String>,
    /// `session_id`: for a subagent, the thread that started it all.
    session: Option<String>,
    subagent: bool,
    /// The thread that spawned a subagent, where the record names it.
    parent: Option<String>,
}

/// The first record holds the whole system prompt as well, so it is read
/// for this only.
fn origin(path: &Path) -> Option<Origin> {
    let mut line = String::new();
    BufReader::new(crate::jsonl::open(path).ok()?.take(FIRST_RECORD_LIMIT))
        .read_line(&mut line)
        .ok()?;
    let row: Value = serde_json::from_str(&line).ok()?;
    let meta = &row["payload"];
    let text = |value: &Value| value.as_str().filter(|s| !s.is_empty()).map(String::from);
    // `source` is a word (`cli`, `exec`) or, for a subagent, says what kind.
    let spawned = &meta["source"]["subagent"]["thread_spawn"];
    Some(Origin {
        id: text(&meta["id"]),
        session: text(&meta["session_id"]),
        subagent: meta["source"].get("subagent").is_some() || meta["thread_source"] == "subagent",
        parent: text(&spawned["parent_thread_id"]).or(text(&meta["parent_thread_id"])),
    })
}

/// The thread that started the session a rollout is part of. Any thread
/// that is not a subagent is its own session, whatever `session_id` it
/// carries: a fork can have its parent's, and is not a subagent. A subagent
/// is part of the session of the thread that spawned it, and that one's if
/// it is a subagent too. That is the thread its `session_id` names, except
/// under a fork, whose subagents carry the session id the fork does: so the
/// way up is followed through the files of the same Codex folder. Where it
/// cannot be (no parent named, or its file is gone), `session_id` stands.
pub fn root_of(path: &Path) -> Option<String> {
    let first = origin(path)?;
    if !first.subagent {
        return first.id.or(first.session);
    }
    let said = first.session.clone();
    let mut seen = HashSet::new();
    let mut at = first;
    while let Some(parent) = at.parent.take() {
        // The usual case, with no other file to read.
        if said.as_deref() == Some(&*parent) {
            return said;
        }
        let file = home_of(path).and_then(|home| rollout_in(home, &parent));
        match file.and_then(|file| origin(&file)) {
            Some(above) if !above.subagent => return Some(parent),
            // spawned by a subagent: on up, unless this is going in circles
            Some(above) if seen.insert(parent.clone()) => at = above,
            _ => return said.or(Some(parent)),
        }
    }
    said.or(at.id)
}

/// The rule `root_of` goes by. What `Roots` remembers from another stands
/// only for a rollout that can no longer be read.
const ROOT_RULE: u64 = 3;

/// The most a first record is read to: it is some tens of kilobytes.
const FIRST_RECORD_LIMIT: u64 = 64 << 20;

/// The file that holds `thread` as it stands now, in a Codex folder.
fn rollout_in(home: &Path, thread: &str) -> Option<PathBuf> {
    let files: Vec<PathBuf> = files_in(home)
        .into_iter()
        .filter(|p| thread_id(p).as_deref() == Some(thread))
        .collect();
    latest_rollout(&files).cloned()
}

/// The file of a rollout that has since been moved (Codex archives old
/// ones): `path` itself if it is still there, else the thread's latest file in
/// the same Codex folder.
fn locate(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        return Some(path.to_path_buf());
    }
    rollout_in(home_of(path)?, &thread_id(path)?)
}

/// What was found out about rollouts, kept between runs. The first record of
/// a rollout never changes, and reading it means reading the whole system
/// prompt, for every file on every run; and the first record of a capture
/// that names the rollout never changes either.
pub struct Roots {
    file: PathBuf,
    /// Rollout path to the thread its session began as (`root_of`).
    roots: HashMap<String, String>,
    /// The same as an earlier rule had it. A rollout is read again by the
    /// rule of now; one that has been deleted since cannot be, and what was
    /// found out about it then is all there is.
    before: HashMap<String, String>,
    /// Capture or import file to the rollout it names.
    rollouts: HashMap<String, String>,
    /// Files that named none, and how long they were then.
    misses: HashMap<String, u64>,
    dirty: bool,
}

impl Roots {
    /// What is remembered in `dir`, which is where the imports are kept.
    pub fn load(dir: &Path) -> Roots {
        let file = dir.join("_roots.json");
        let saved: Value = fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let map = |key: &str| -> HashMap<String, String> {
            saved[key]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        };
        let mut roots = map("roots");
        let mut before = map("roots_before");
        if saved["root_rule"] != ROOT_RULE {
            before.extend(roots.drain());
        }
        Roots {
            file,
            roots,
            before,
            rollouts: map("rollouts"),
            misses: saved["misses"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(k, v)| Some((k.clone(), v.as_u64()?)))
                .collect(),
            dirty: false,
        }
    }

    /// `root_of`, read from the file only the first time. A file that is gone
    /// is looked for among the thread's others, and if the thread has none
    /// left, what an earlier rule made of it stands.
    pub fn root_of(&mut self, rollout: &Path) -> Option<String> {
        let key = rollout.to_string_lossy().into_owned();
        if let Some(root) = self.roots.get(&key) {
            return Some(root.clone());
        }
        let read = locate(rollout).and_then(|file| root_of(&file));
        let root = read.or_else(|| self.before.get(&key).cloned())?;
        self.before.remove(&key);
        self.roots.insert(key, root.clone());
        self.dirty = true;
        Some(root)
    }

    /// The rollout a hook capture or an import says it is of: the first record
    /// that names one (a capture's payloads and an import's start both do).
    pub fn rollout_of(&mut self, file: &Path) -> Option<PathBuf> {
        let key = file.to_string_lossy().into_owned();
        if let Some(rollout) = self.rollouts.get(&key) {
            return Some(PathBuf::from(rollout));
        }
        // one that named none is looked at again only once it has grown
        let len = fs::metadata(file).ok()?.len();
        if self.misses.get(&key) == Some(&len) {
            return None;
        }
        let rollout = BufReader::new(fs::File::open(file).ok()?)
            .split(b'\n')
            .map_while(std::result::Result::ok)
            .find_map(|line| {
                let record: Value = serde_json::from_slice(&line).ok()?;
                record["payload"]["transcript_path"]
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .map(String::from)
            });
        self.dirty = true;
        let Some(rollout) = rollout else {
            self.misses.insert(key, len);
            return None;
        };
        self.misses.remove(&key);
        self.rollouts.insert(key, rollout.clone());
        Some(PathBuf::from(rollout))
    }

    /// Write down what was learned.
    pub fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let write = || -> Result<()> {
            if let Some(dir) = self.file.parent() {
                crate::paths::create_private_dir(dir)?;
            }
            let tmp = self
                .file
                .with_extension(format!("json.{}.tmp", std::process::id()));
            let saved = json!({ "root_rule": ROOT_RULE, "roots": self.roots,
                "roots_before": self.before,
                "rollouts": self.rollouts, "misses": self.misses });
            fs::write(&tmp, serde_json::to_vec(&saved)?)?;
            fs::rename(&tmp, &self.file)?;
            Ok(())
        };
        // only a cache: the next run learns it again
        if write().is_ok() {
            self.dirty = false;
        }
    }
}

/// Which of a thread's files this is, from its name: the part a revert adds
/// after `_`, and for a thread's first file the thread itself.
fn rollout_id(path: &Path) -> Option<String> {
    let stem = stem_of(path)?;
    let id = stem.get(20..)?.rsplit('_').next()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// The Codex folder a rollout is kept in.
fn home_of(rollout: &Path) -> Option<&Path> {
    rollout
        .ancestors()
        .find(|dir| {
            dir.file_name()
                .is_some_and(|n| n == "sessions" || n == "archived_sessions")
        })?
        .parent()
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    paths.sort();
    paths
}

/// Every file in the day folders and among the archived ones.
pub fn files_in(home: &Path) -> Vec<PathBuf> {
    let days = entries(&home.join("sessions"))
        .into_iter()
        .flat_map(|year| entries(&year))
        .flat_map(|month| entries(&month));
    days.chain([home.join("archived_sessions")])
        .flat_map(|dir| entries(&dir))
        .collect()
}

/// The earlier file a rollout carries on from, and how many bytes of it
/// still stand: the `history_base` of its first record.
fn history_base(path: &Path) -> Option<(String, u64)> {
    let mut line = String::new();
    BufReader::new(crate::jsonl::open(path).ok()?.take(FIRST_RECORD_LIMIT))
        .read_line(&mut line)
        .ok()?;
    let row: Value = serde_json::from_str(&line).ok()?;
    let base = &row["payload"]["history_base"];
    Some((
        base["thread_id"].as_str()?.to_string(),
        base["end_byte_offset"].as_u64()?,
    ))
}

/// The file that holds a thread as it stands now, among all of its files: the
/// one no other file carries on from. A revert starts a new file whose
/// `history_base` names the one before, whichever folder either is in. Where
/// the chain leaves more than one (or none), the latest by the time in the
/// file name wins, and the last of `files` among equals.
pub fn latest_rollout(files: &[PathBuf]) -> Option<&PathBuf> {
    if files.len() < 2 {
        return files.first();
    }
    let based_on: HashSet<String> = files
        .iter()
        .filter_map(|p| history_base(p))
        .map(|(base, _)| base)
        .collect();
    let started = |p: &&PathBuf| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        name.strip_prefix("rollout-")
            .and_then(|rest| rest.get(..19))
            .unwrap_or_default()
            .to_string()
    };
    let standing: Vec<&PathBuf> = files
        .iter()
        .filter(|p| rollout_id(p).is_some_and(|id| !based_on.contains(&id)))
        .collect();
    let candidates = if standing.is_empty() {
        files.iter().collect()
    } else {
        standing
    };
    // `max_by_key` keeps the last of equal keys
    candidates.into_iter().max_by_key(started)
}

/// The files a thread's history is in, oldest first, each with how far into
/// it the history goes (`None`: all of it). Only the thread's own files: what
/// a fork has from its parent is the parent's.
fn history(path: &Path, thread: &str) -> Vec<(PathBuf, Option<u64>)> {
    let mut files = vec![(path.to_path_buf(), None)];
    let mut others: Option<Vec<PathBuf>> = None;
    while let Some((base, end)) = history_base(&files[0].0) {
        let others = others.get_or_insert_with(|| home_of(path).map(files_in).unwrap_or_default());
        let earlier = others.iter().find(|p| {
            thread_id(p).as_deref() == Some(thread) && rollout_id(p).as_deref() == Some(&*base)
        });
        match earlier {
            Some(p) if files.iter().all(|(seen, _)| seen != p) => {
                files.insert(0, (p.clone(), Some(end)));
            }
            _ => break,
        }
    }
    files
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// A tool call and, once it has arrived, its output.
struct Call {
    id: String,
    name: String,
    /// The arguments: parsed JSON, or the text of a freeform tool.
    input: Value,
    at: String,
    turn: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    /// When the output arrived, and its text.
    output: Option<(String, String)>,
}

/// What Codex itself recorded about how a call went.
#[derive(Default)]
struct Seen {
    failed: Option<bool>,
    /// The person said no when asked.
    declined: bool,
    exit_code: Option<i64>,
    duration_ms: Option<u64>,
}

/// A tool call ready to be written down: one Codex kept as an item, a call
/// the model made, or one file of a patch.
struct Part {
    id: String,
    tool: String,
    input: Value,
    /// What a success answers with.
    result: Value,
    at: String,
    turn: Option<String>,
    model: Option<String>,
    /// When it ended, how, and how long it took.
    done: Option<(String, Outcome, Option<u64>)>,
}

/// One file of an `apply_patch` call.
struct FileEdit {
    path: String,
    created: bool,
    /// `+added` and `-removed` lines.
    lines: Vec<String>,
}

/// Tokens of one model response, or of several added up.
#[derive(Default, Clone, Copy, PartialEq)]
struct Tokens {
    input: u64,
    cached: u64,
    cache_write: u64,
    output: u64,
    reasoning: u64,
    /// How long the prompt was, which picks the price tier: that of the one
    /// response these are of, or 0 where that is not known (several added
    /// up), which takes the shorter one.
    prompt: u64,
}

impl Tokens {
    fn of(usage: &Value) -> Tokens {
        let n = |key: &str| usage[key].as_u64().unwrap_or(0);
        Tokens {
            input: n("input_tokens"),
            cached: n("cached_input_tokens"),
            cache_write: n("cache_write_input_tokens"),
            output: n("output_tokens"),
            reasoning: n("reasoning_output_tokens"),
            prompt: n("input_tokens"),
        }
    }

    /// Input read neither from the cache nor written to it: Codex's input
    /// count includes both.
    fn uncached(&self) -> u64 {
        self.input.saturating_sub(self.cached + self.cache_write)
    }

    /// What was used since `earlier`, or `None` if a count went down.
    fn since(&self, earlier: &Tokens) -> Option<Tokens> {
        Some(Tokens {
            input: self.input.checked_sub(earlier.input)?,
            cached: self.cached.checked_sub(earlier.cached)?,
            cache_write: self.cache_write.checked_sub(earlier.cache_write)?,
            output: self.output.checked_sub(earlier.output)?,
            reasoning: self.reasoning.checked_sub(earlier.reasoning)?,
            prompt: 0,
        })
    }
}

/// Everything read from one rollout file.
#[derive(Default)]
struct Thread {
    meta: Value,
    first_at: Option<String>,
    last_at: Option<String>,
    /// When, in which turn, and what was asked.
    prompts: Vec<(String, Option<String>, String)>,
    /// When a turn ended, and which.
    stops: Vec<(String, Option<String>)>,
    calls: Vec<Call>,
    /// Calls Codex kept as items, complete as they are.
    parts: Vec<Part>,
    seen: HashMap<String, Seen>,
    compactions: Vec<String>,
    /// Model responses: the model (where known) and the tokens.
    responses: Vec<(Option<String>, Tokens)>,
    model: Option<String>,
    /// Times `/review` ran: Codex's review mode, entered and left.
    reviews: Vec<Review>,
}

/// One run of `/review`: an `EnteredReviewMode` item, and the
/// `ExitedReviewMode` that ends it with what the reviewer found.
struct Review {
    id: String,
    at: String,
    /// What was reviewed: `baseBranch`, `uncommittedChanges`, `commit`, `custom`.
    target: Option<String>,
    ended: Option<String>,
    findings: Option<u64>,
    /// Left with nothing returned, as Codex leaves one that was interrupted.
    interrupted: bool,
}

impl Review {
    /// Review mode was left at `at`, with what `output` says was found.
    fn left(&mut self, at: &str, output: &Value) {
        self.ended = Some(at.to_string());
        self.interrupted = output.is_null();
        let found = output["findings"].as_array();
        self.findings = found.map(|list| list.len() as u64);
    }
}

fn text_of(output: &Value) -> String {
    match output {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `{secs, nanos}` as milliseconds.
fn duration_ms(duration: &Value) -> Option<u64> {
    let secs = duration["secs"].as_u64()?;
    Some(secs * 1000 + duration["nanos"].as_u64().unwrap_or(0) / 1_000_000)
}

/// What the person typed. The editor extension puts the open files and the
/// selection in front of it.
fn typed(message: &str) -> &str {
    const MARKER: &str = "## My request for Codex:";
    match message.find(MARKER) {
        Some(i) => message[i + MARKER.len()..].trim_start(),
        None => message,
    }
}

/// Milliseconds since 1970 as a time written like a rollout's own.
fn time_of(ms: &Value) -> Option<String> {
    let time = DateTime::from_timestamp_millis(ms.as_i64()?)?;
    Some(time.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// The response to a successful edit that put in and took out `lines`.
fn edited(lines: &[String], created: bool) -> Value {
    let mut result = edit_result("", "", created);
    result["_bytes"] = json!(lines.iter().map(|l| l.len()).sum::<usize>());
    result["structuredPatch"] = json!([{ "lines": lines }]);
    result
}

/// The id of the `n`th file (from 0) of a call that changed several.
fn part_id(id: &str, n: usize) -> String {
    match n {
        0 => id.to_string(),
        n => format!("{id}#{}", n + 1),
    }
}

/// The files of a patch as Codex wrote them down once it was applied: a map
/// from path to `{type: add, content}`, `{type: delete, content}` or
/// `{type: update, unified_diff, move_path}`. Each becomes an edit of its own.
fn file_parts(id: &str, changes: &Value, cwd: Option<&str>, like: &Part) -> Vec<Part> {
    let prefixed = |sign: char, content: &Value| -> Vec<String> {
        let content = content.as_str().unwrap_or_default();
        content.lines().map(|l| format!("{sign}{l}")).collect()
    };
    let files = changes.as_object().into_iter().flatten().enumerate();
    files
        .map(|(n, (path, change))| {
            let kind = change["type"].as_str().unwrap_or_default();
            let lines = match kind {
                "add" => prefixed('+', &change["content"]),
                "delete" => prefixed('-', &change["content"]),
                // The diff has no file header: every `+` or `-` line is a change.
                _ => change["unified_diff"]
                    .as_str()
                    .unwrap_or_default()
                    .lines()
                    .filter(|l| l.starts_with(['+', '-']))
                    .map(String::from)
                    .collect(),
            };
            let path = change["move_path"].as_str().unwrap_or(path);
            Part {
                id: part_id(id, n),
                tool: if kind == "add" { "Write" } else { "Edit" }.to_string(),
                input: json!({ "file_path": resolve(path, cwd) }),
                result: edited(&lines, kind == "add"),
                at: like.at.clone(),
                turn: like.turn.clone(),
                model: like.model.clone(),
                done: like.done.clone(),
            }
        })
        .collect()
}

/// The tool calls in an item Codex kept of something that ran. `like` has
/// the time, turn and model; `ended` is when the item was written.
fn item_parts(item: &Value, cwd: Option<&str>, ended: &str, mut like: Part) -> Vec<Part> {
    let status = item["status"].as_str().unwrap_or_default();
    let id = item["id"].as_str().unwrap_or_default();
    let elapsed = || Some((parse_time(ended)? - parse_time(&like.at)?).num_milliseconds());
    let ms = duration_ms(&item["duration"]).or(elapsed().map(|ms| ms.max(0) as u64));
    let end = |how: Outcome| Some((ended.to_string(), how, ms));
    let finished = |error: &str| match status {
        "declined" => end(Outcome::Rejected),
        "failed" => end(Outcome::Failed(error.to_string())),
        // camel case in an MCP call
        "in_progress" | "inProgress" => None,
        _ => end(Outcome::Ok),
    };
    like.id = id.to_string();
    match item["type"].as_str().unwrap_or_default() {
        // Looking in on a command that is still running is not a command.
        "CommandExecution" if item["source"] != "unified_exec_interaction" => {
            let output = item["aggregated_output"].as_str().unwrap_or_default();
            let code = item["exit_code"].as_i64();
            let trimmed = output.trim();
            let tail = trimmed
                .char_indices()
                .rev()
                .nth(199)
                .map(|(start, _)| &trimmed[start..])
                .unwrap_or(trimmed);
            let failed = match (tail, code) {
                ("", Some(code)) => format!("Exit code {code}"),
                ("", None) => "failed".to_string(),
                (said, _) => said.to_string(),
            };
            like.done = match code {
                Some(code) if code != 0 && status != "declined" => end(Outcome::Failed(failed)),
                _ => finished(&failed),
            };
            let dir = item["cwd"]
                .as_str()
                .map(|d| d.trim_start_matches("file://"));
            like.tool = "Bash".into();
            like.input = json!({ "command": command_line(&item["command"]), "workdir": dir });
            like.result = json!({ "_bytes": output.len() });
            vec![like]
        }
        "FileChange" => {
            like.done = finished(item["stderr"].as_str().unwrap_or("failed"));
            file_parts(id, &item["changes"], cwd, &like)
        }
        "McpToolCall" => {
            like.done = finished(item["error"]["message"].as_str().unwrap_or("failed"));
            let name = |key: &str| item[key].as_str().unwrap_or_default();
            like.tool = format!("mcp__{}__{}", name("server"), name("tool"));
            like.input = slim_input(&item["arguments"]);
            like.result = json!({ "_bytes": item["result"].to_string().len() });
            vec![like]
        }
        "WebSearch" => {
            like.done = end(Outcome::Ok);
            like.tool = "WebSearch".into();
            like.input = json!({ "query": item["query"] });
            vec![like]
        }
        "CollabAgentToolCall" if item["tool"] == "spawn_agent" => {
            like.done = finished("failed");
            like.tool = "Agent".into();
            like.input = slim_input(&json!({ "description": item["prompt"] }));
            vec![like]
        }
        _ => Vec::new(),
    }
}

/// True for a tool whose calls the newer layout also keeps as items, and for
/// the script tools the model reaches those through: there the items are read.
fn kept_as_items(name: &str, call: &Value) -> bool {
    matches!(
        name,
        "exec" | "wait" | "exec_command" | "write_stdin" | "apply_patch" | "spawn_agent"
    ) || name.starts_with("mcp__")
        || call["namespace"]
            .as_str()
            .is_some_and(|n| n.starts_with("mcp"))
}

fn read(path: &Path, thread: &str) -> Result<Thread> {
    let mut t = Thread::default();
    // A subagent's file starts with the context it inherited.
    let mut own_from: Option<u64> = None;
    let mut paginated = false;
    let mut turn: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut model: Option<String> = None;
    let mut model_of_turn: HashMap<String, String> = HashMap::new();
    let mut call_ix: HashMap<String, usize> = HashMap::new();
    // (turn, tokens) of each response Codex kept a record of.
    // (turn, model in use when it was written, tokens)
    let mut records: Vec<(Option<String>, Option<String>, Tokens)> = Vec::new();
    let mut responses_seen: HashSet<String> = HashSet::new();
    // Without those records: what the running total grew by, each time it grew.
    let mut total = Tokens::default();
    let mut growth: Vec<(Option<String>, Tokens)> = Vec::new();
    let mut searches = 0;

    let mut record = |row: Value| {
        let kind = row["type"].as_str().unwrap_or_default();
        let p = &row["payload"];
        if kind == "session_meta" {
            if t.meta.is_null() {
                paginated = p["history_mode"] == "paginated";
                own_from = p["subagent_history_start_ordinal"].as_u64();
                cwd = p["cwd"].as_str().map(String::from);
                t.meta = p.clone();
            }
            return;
        }
        if let (Some(from), Some(ordinal)) = (own_from, row["ordinal"].as_u64()) {
            if ordinal < from {
                return;
            }
        }
        let Some(at) = row["timestamp"].as_str() else {
            return;
        };
        if t.first_at.is_none() {
            t.first_at = Some(at.to_string());
        }
        t.last_at = Some(at.to_string());
        let other_thread = |id: &Value| id.as_str().is_some_and(|id| id != thread);
        match kind {
            "turn_context" => {
                if let Some(now) = p["model"].as_str() {
                    model = Some(now.to_string());
                    if let Some(id) = p["turn_id"].as_str() {
                        model_of_turn.insert(id.to_string(), now.to_string());
                    }
                    if t.model.is_none() {
                        t.model = model.clone();
                    }
                }
                if let Some(now) = p["cwd"].as_str() {
                    cwd = Some(now.to_string());
                }
            }
            "compacted" => t.compactions.push(at.to_string()),
            "token_usage_record" => {
                let fresh = p["response_id"]
                    .as_str()
                    .is_none_or(|id| responses_seen.insert(id.to_string()));
                if fresh && !other_thread(&p["thread_id"]) {
                    let turn = p["turn_id"].as_str().map(String::from);
                    records.push((turn, model.clone(), Tokens::of(&p["usage"])));
                }
            }
            "response_item" => {
                let mut call = |id: &str, name: &str, input: Value| {
                    call_ix.insert(id.to_string(), t.calls.len());
                    t.calls.push(Call {
                        id: id.to_string(),
                        name: name.to_string(),
                        input,
                        at: at.to_string(),
                        turn: turn.clone(),
                        cwd: cwd.clone(),
                        model: model.clone(),
                        output: None,
                    });
                };
                match p["type"].as_str().unwrap_or_default() {
                    "function_call" => {
                        let (Some(id), Some(name)) = (p["call_id"].as_str(), p["name"].as_str())
                        else {
                            return;
                        };
                        if paginated && kept_as_items(name, p) {
                            return;
                        }
                        let arguments = p["arguments"].as_str().unwrap_or_default();
                        let input = serde_json::from_str(arguments)
                            .unwrap_or_else(|_| Value::String(arguments.to_string()));
                        call(id, name, input);
                    }
                    "custom_tool_call" => {
                        let (Some(id), Some(name)) = (p["call_id"].as_str(), p["name"].as_str())
                        else {
                            return;
                        };
                        if paginated && kept_as_items(name, p) {
                            return;
                        }
                        call(id, name, p["input"].clone());
                    }
                    "local_shell_call" => {
                        if let Some(id) = p["call_id"].as_str().or(p["id"].as_str()) {
                            call(id, "local_shell", p["action"].clone());
                        }
                    }
                    "web_search_call" if !paginated => {
                        searches += 1;
                        let id = format!("search-{searches}");
                        call(&id, "web_search", p["action"].clone());
                        // A search runs on OpenAI's side: no output comes back here.
                        if let Some(call) = t.calls.last_mut() {
                            call.output = Some((at.to_string(), String::new()));
                        }
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        let index = p["call_id"].as_str().and_then(|id| call_ix.get(id));
                        if let Some(call) = index.and_then(|i| t.calls.get_mut(*i)) {
                            call.output = Some((at.to_string(), text_of(&p["output"])));
                        }
                    }
                    _ => {}
                }
            }
            "event_msg" => match p["type"].as_str().unwrap_or_default() {
                // The older layout has review mode as events of its own, and
                // no item for it; the paginated one has the items below.
                "entered_review_mode" if !paginated && !other_thread(&p["thread_id"]) => {
                    let nth = t.reviews.len();
                    t.reviews.push(Review {
                        id: format!("{thread}-review-{nth}"),
                        at: at.to_string(),
                        target: p["target"]["type"].as_str().map(String::from),
                        ended: None,
                        findings: None,
                        interrupted: false,
                    });
                }
                "exited_review_mode" if !paginated && !other_thread(&p["thread_id"]) => {
                    if let Some(review) = t.reviews.iter_mut().rfind(|r| r.ended.is_none()) {
                        review.left(at, &p["review_output"]);
                    }
                }
                "task_started" | "turn_started" => {
                    turn = p["turn_id"].as_str().map(String::from);
                    // A prompt written down before its turn began.
                    for prompt in t.prompts.iter_mut().rev() {
                        if prompt.1.is_some() {
                            break;
                        }
                        prompt.1 = turn.clone();
                    }
                }
                "task_complete" | "turn_complete" => {
                    let id = p["turn_id"].as_str().map(String::from).or(turn.take());
                    t.stops.push((at.to_string(), id));
                    turn = None;
                }
                "turn_aborted" => turn = None,
                "thread_settings_applied" => {
                    if let Some(now) = p["thread_settings"]["model"].as_str() {
                        model = Some(now.to_string());
                    }
                }
                "user_message" => {
                    let message = typed(p["message"].as_str().unwrap_or_default());
                    if !message.is_empty() {
                        t.prompts
                            .push((at.to_string(), turn.clone(), message.to_string()));
                    }
                }
                "item_completed" if !other_thread(&p["thread_id"]) => {
                    // An item with no id still needs one of its own: parts are
                    // told apart by it.
                    let mut item = p["item"].clone();
                    if item["id"].as_str().is_none_or(str::is_empty) {
                        // Reviews are counted too: one adds no part.
                        let nth = t.parts.len() + t.reviews.len();
                        item["id"] = json!(format!("{thread}-item-{nth}"));
                    }
                    let item = &item;
                    let id = item["id"].as_str().unwrap_or_default().to_string();
                    match item["type"].as_str().unwrap_or_default() {
                        "UserMessage" => {
                            let parts: Vec<&str> = item["content"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|part| part["type"] == "text")
                                .filter_map(|part| part["text"].as_str())
                                .collect();
                            let message = parts.join("\n");
                            let message = typed(&message);
                            if !message.is_empty() {
                                let id = p["turn_id"].as_str().map(String::from);
                                t.prompts.push((
                                    at.to_string(),
                                    id.or(turn.clone()),
                                    message.into(),
                                ));
                            }
                        }
                        "EnteredReviewMode" => t.reviews.push(Review {
                            id: id.clone(),
                            at: time_of(&p["started_at_ms"]).unwrap_or(at.to_string()),
                            target: item["target"]["type"].as_str().map(String::from),
                            ended: None,
                            findings: None,
                            interrupted: false,
                        }),
                        "ExitedReviewMode" => {
                            if let Some(review) = t.reviews.iter_mut().rfind(|r| r.ended.is_none())
                            {
                                review.left(at, &item["review_output"]);
                            }
                        }
                        _ => {
                            let like = Part {
                                id: id.clone(),
                                tool: String::new(),
                                input: Value::Null,
                                result: json!({ "_bytes": 0 }),
                                at: time_of(&p["started_at_ms"]).unwrap_or(at.to_string()),
                                turn: p["turn_id"].as_str().map(String::from).or(turn.clone()),
                                model: model.clone(),
                                done: None,
                            };
                            t.parts.extend(item_parts(item, cwd.as_deref(), at, like));
                        }
                    }
                }
                // Rollouts written by older versions.
                "exec_command_end" | "patch_apply_end" | "mcp_tool_call_end" => {
                    let Some(id) = p["call_id"].as_str() else {
                        return;
                    };
                    let status = p["status"].as_str().unwrap_or_default();
                    // A patch applied from inside a script: no call of the
                    // model's has its id, and this is all there is of it.
                    if p["changes"].is_object() && !call_ix.contains_key(id) {
                        let how = match (status, p["success"].as_bool()) {
                            ("declined", _) => Outcome::Rejected,
                            ("failed", _) | (_, Some(false)) => {
                                Outcome::Failed(p["stderr"].as_str().unwrap_or("failed").into())
                            }
                            _ => Outcome::Ok,
                        };
                        let like = Part {
                            id: id.to_string(),
                            tool: String::new(),
                            input: Value::Null,
                            result: Value::Null,
                            at: at.to_string(),
                            turn: turn.clone(),
                            model: model.clone(),
                            done: Some((at.to_string(), how, None)),
                        };
                        t.parts
                            .extend(file_parts(id, &p["changes"], cwd.as_deref(), &like));
                        return;
                    }
                    let mcp_failed = p["result"].get("Err").is_some()
                        || ["is_error", "isError"]
                            .iter()
                            .any(|key| p["result"]["Ok"][*key].as_bool() == Some(true));
                    let failed = p["success"]
                        .as_bool()
                        .map(|ok| !ok)
                        .or(p["exit_code"].as_i64().map(|code| code != 0))
                        .or(p.get("result").map(|_| mcp_failed));
                    t.seen.insert(
                        id.to_string(),
                        Seen {
                            failed,
                            declined: status == "declined",
                            exit_code: p["exit_code"].as_i64(),
                            duration_ms: duration_ms(&p["duration"]),
                        },
                    );
                }
                "token_count" => {
                    let now = &p["info"]["total_token_usage"];
                    if now.is_object() {
                        let now = Tokens::of(now);
                        // A total that went down has started again.
                        let mut used = now.since(&total).unwrap_or(Tokens { prompt: 0, ..now });
                        // What it grew by is one response's only when it is the last response's.
                        let last = Tokens::of(&p["info"]["last_token_usage"]);
                        if (Tokens { prompt: 0, ..last }) == used {
                            used.prompt = last.prompt;
                        }
                        if used != Tokens::default() {
                            growth.push((model.clone(), used));
                        }
                        total = now;
                    }
                }
                _ => {}
            },
            _ => {}
        }
    };
    for (file, end) in history(path, thread) {
        crate::jsonl::for_each_within(&file, end, &mut record)?;
    }

    t.responses = if records.is_empty() {
        growth
    } else {
        let latest = model.clone();
        records
            .into_iter()
            .map(|(turn, then, tokens)| {
                // the turn's own model, else the one in use at the time
                let model = turn.and_then(|id| model_of_turn.get(&id).cloned());
                (model.or(then).or(latest.clone()), tokens)
            })
            .collect()
    };
    if paginated {
        drop_shell_calls_kept_as_items(&mut t);
    }
    Ok(t)
}

/// In the paginated layout what ran is kept as an item, so a shell call of
/// the model's for the same command in the same turn is that command seen
/// twice. Each item stands for one call.
fn drop_shell_calls_kept_as_items(t: &mut Thread) {
    let mut ran: HashMap<(Option<String>, String), usize> = HashMap::new();
    for part in t.parts.iter().filter(|p| p.tool == "Bash") {
        let command = part.input["command"].as_str().unwrap_or_default();
        *ran.entry((part.turn.clone(), command.to_string()))
            .or_default() += 1;
    }
    t.calls.retain(|call| {
        if !matches!(
            call.name.as_str(),
            "shell" | "shell_command" | "local_shell" | "container.exec"
        ) {
            return true;
        }
        let (_, input) = canonical(call);
        let command = input["command"].as_str().unwrap_or_default().to_string();
        match ran.get_mut(&(call.turn.clone(), command)) {
            Some(left) if *left > 0 => {
                *left -= 1;
                false
            }
            _ => true,
        }
    });
}

/// A path in a patch or a tool's input, made absolute.
fn resolve(path: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(cwd) if !Path::new(path).is_absolute() => {
            Path::new(cwd).join(path).to_string_lossy().into_owned()
        }
        _ => path.to_string(),
    }
}

/// The files an `apply_patch` patch changes, each with the lines it adds
/// and removes. A deleted file has none: the patch does not hold its content.
fn patch_edits(patch: &str, cwd: Option<&str>) -> Vec<FileEdit> {
    let mut edits: Vec<FileEdit> = Vec::new();
    for line in patch.lines() {
        if line.starts_with("***") {
            let line = line.trim_end();
            let file = |path: &str, created| FileEdit {
                path: resolve(path.trim(), cwd),
                created,
                lines: Vec::new(),
            };
            if let Some(path) = line.strip_prefix("*** Add File: ") {
                edits.push(file(path, true));
            } else if let Some(path) = line
                .strip_prefix("*** Update File: ")
                .or(line.strip_prefix("*** Delete File: "))
            {
                edits.push(file(path, false));
            } else if let Some(path) = line.strip_prefix("*** Move to: ") {
                if let Some(edit) = edits.last_mut() {
                    edit.path = resolve(path.trim(), cwd);
                }
            }
        } else if line.starts_with(['+', '-']) {
            if let Some(edit) = edits.last_mut() {
                edit.lines.push(line.to_string());
            }
        }
    }
    edits
}

fn is_shell(word: &str) -> bool {
    matches!(
        word.rsplit('/').next().unwrap_or(word),
        "bash" | "sh" | "zsh"
    )
}

/// The script of `<shell> -lc <script>` or `-c`, with the quotes a line of
/// text puts around it taken off.
fn script_of<'a>(shell: &str, flag: &str, script: &'a str) -> Option<&'a str> {
    if !is_shell(shell) || !matches!(flag, "-lc" | "-c") {
        return None;
    }
    let script = script.trim();
    for quote in ['\'', '"'] {
        if let Some(inner) = script
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            // one quoted word only: `'a' && 'b'` is not
            if !inner.contains(quote) {
                return Some(inner);
            }
        }
    }
    Some(script)
}

fn command_line(command: &Value) -> Option<String> {
    match command {
        Value::String(line) => {
            let mut words = line.trim().splitn(3, ' ');
            let script = match (words.next(), words.next(), words.next()) {
                (Some(shell), Some(flag), Some(script)) => script_of(shell, flag, script),
                _ => None,
            };
            Some(script.map_or_else(|| line.clone(), String::from))
        }
        Value::Array(words) => {
            let words: Vec<&str> = words.iter().filter_map(Value::as_str).collect();
            match words.as_slice() {
                [shell, flag, script] if script_of(shell, flag, script).is_some() => {
                    Some(script.to_string())
                }
                [] => None,
                words => Some(words.join(" ")),
            }
        }
        _ => None,
    }
}

/// The patch of a call, if it is one: `apply_patch` as a tool of its own, or
/// (older versions) as a shell command.
fn patch_of(call: &Call) -> Option<&str> {
    match call.name.as_str() {
        "apply_patch" => call
            .input
            .as_str()
            .or(call.input["input"].as_str())
            .or(call.input["patch"].as_str()),
        "shell" | "local_shell" | "container.exec" => match call.input["command"].as_array() {
            Some(words) if words.len() == 2 && words[0] == "apply_patch" => words[1].as_str(),
            _ => None,
        },
        _ => None,
    }
}

/// Codex's tool and its input under the names used for Claude Code's tools.
fn canonical(call: &Call) -> (String, Value) {
    let input = &call.input;
    match call.name.as_str() {
        "exec_command" => (
            "Bash".into(),
            json!({ "command": input["cmd"], "workdir": input["workdir"] }),
        ),
        "shell" | "shell_command" | "local_shell" | "container.exec" => (
            "Bash".into(),
            json!({ "command": command_line(&input["command"]), "workdir": input["workdir"] }),
        ),
        "view_image" => {
            let path = input["path"].as_str().unwrap_or_default();
            (
                "Read".into(),
                json!({ "file_path": resolve(path, call.cwd.as_deref()) }),
            )
        }
        "spawn_agent" => {
            let description = input["task_name"].as_str().or(input["message"].as_str());
            (
                "Agent".into(),
                slim_input(
                    &json!({ "description": description, "agent_type": input["agent_type"] }),
                ),
            )
        }
        "web_search" => {
            let query = input["query"].as_str().or(input["queries"][0].as_str());
            (
                "WebSearch".into(),
                json!({ "query": query.or(input["url"].as_str()) }),
            )
        }
        "update_plan" => ("TodoWrite".into(), slim_input(input)),
        name => (name.to_string(), slim_input(input)),
    }
}

/// How a call went, as far as the rollout says.
#[derive(Clone)]
enum Outcome {
    Ok,
    Failed(String),
    Interrupted,
    Rejected,
}

/// Exit code and wall time as a command's output states them, and whether it
/// says the call was cut short. The output starts with a few header lines
/// (`Process exited with code 1`, `Wall time: 0.5 seconds`) and then `Output:`.
fn stated(output: &str) -> (Option<i64>, Option<u64>, bool, &str) {
    let (mut code, mut ms, mut aborted) = (None, None, false);
    let mut body = output;
    for line in output.lines().take(8) {
        if line == "Output:" {
            let at = line.as_ptr() as usize - output.as_ptr() as usize + line.len();
            body = output[at..].trim_start_matches(['\r', '\n']);
            break;
        }
        let exit = line
            .strip_prefix("Process exited with code ")
            .or(line.strip_prefix("Exit code: "));
        if let Some(exit) = exit {
            code = exit.trim().parse().ok();
        } else if let Some(time) = line.strip_prefix("Wall time: ") {
            let seconds: Option<f64> = time.split(' ').next().and_then(|s| s.parse().ok());
            ms = seconds.map(|s| (s * 1000.0) as u64);
        } else if line.starts_with("aborted by user") || line == "aborted before dispatch" {
            aborted = true;
        }
    }
    (code, ms, aborted, body)
}

/// Outcome and duration of a call that has its output.
fn outcome(
    call: &Call,
    seen: Option<&Seen>,
    output: &str,
    is_patch: bool,
) -> (Outcome, Option<u64>) {
    // Older versions gave a command's output as JSON.
    let old: Value = serde_json::from_str(output)
        .ok()
        .filter(|v: &Value| v["metadata"].is_object())
        .unwrap_or(Value::Null);
    let (mut code, mut ms, aborted, mut body) = stated(output);
    if !old.is_null() {
        code = old["metadata"]["exit_code"].as_i64();
        ms = old["metadata"]["duration_seconds"]
            .as_f64()
            .map(|s| (s * 1000.0) as u64);
        body = old["output"].as_str().unwrap_or_default();
    }
    let code = seen.and_then(|s| s.exit_code).or(code);
    let ms = seen.and_then(|s| s.duration_ms).or(ms);
    let failed = seen.and_then(|s| s.failed).unwrap_or(match code {
        Some(code) => code != 0,
        // A patch says so when it went in; nothing else says how it went.
        None => is_patch && !body.trim_start().starts_with("Success"),
    });
    let how = if seen.is_some_and(|s| s.declined) {
        Outcome::Rejected
    } else if aborted {
        Outcome::Interrupted
    } else if failed {
        let said = body.trim();
        Outcome::Failed(match (said.is_empty(), code) {
            (false, _) => said.to_string(),
            (true, Some(code)) => format!("Exit code {code}"),
            (true, None) => format!("{} failed", call.name),
        })
    } else {
        Outcome::Ok
    };
    (how, ms)
}

/// The model's own call as what is written down: one part, or one per file
/// of a patch.
fn call_parts(call: &Call, seen: Option<&Seen>) -> Vec<Part> {
    let patch = patch_of(call);
    let done = match &call.output {
        Some((at, text)) => {
            let (how, ms) = outcome(call, seen, text, patch.is_some());
            let elapsed = || Some((parse_time(at)? - parse_time(&call.at)?).num_milliseconds());
            Some((at.clone(), how, ms.or(elapsed().map(|ms| ms.max(0) as u64))))
        }
        // Asked and said no to, before anything ran.
        None if seen.is_some_and(|s| s.declined) => {
            Some((call.at.clone(), Outcome::Rejected, None))
        }
        None => None,
    };
    let part = |id: String, tool: String, input: Value, result: Value| Part {
        id,
        tool,
        input,
        result,
        at: call.at.clone(),
        turn: call.turn.clone(),
        model: call.model.clone(),
        done: done.clone(),
    };
    let edits = patch
        .map(|patch| patch_edits(patch, call.cwd.as_deref()))
        .unwrap_or_default();
    if edits.is_empty() {
        let (tool, input) = canonical(call);
        let bytes = call.output.as_ref().map_or(0, |(_, text)| text.len());
        return vec![part(
            call.id.clone(),
            tool,
            input,
            json!({ "_bytes": bytes }),
        )];
    }
    let edits = edits.into_iter().enumerate();
    edits
        .map(|(n, edit)| {
            let tool = if edit.created { "Write" } else { "Edit" };
            part(
                part_id(&call.id, n),
                tool.to_string(),
                json!({ "file_path": edit.path }),
                edited(&edit.lines, edit.created),
            )
        })
        .collect()
}

/// Add a thread's tool calls to `out`. `agent` is the subagent whose thread
/// this is. `models` gets the model behind each call, by tool use id.
fn push_calls(
    t: &Thread,
    agent: Option<(&str, &str)>,
    out: &mut Builder,
    models: &mut HashMap<String, String>,
) {
    let calls = t.calls.iter();
    let own: Vec<Part> = calls
        .flat_map(|call| call_parts(call, t.seen.get(&call.id)))
        .collect();
    for part in own.iter().chain(&t.parts) {
        if let Some(model) = &part.model {
            models.insert(part.id.clone(), model.clone());
        }
        let mut base = json!({
            "prompt_id": part.turn,
            "tool_use_id": part.id,
            "tool_name": part.tool,
            "tool_input": part.input,
        });
        if let Some((agent_id, agent_type)) = agent {
            base["agent_id"] = json!(agent_id);
            base["agent_type"] = json!(agent_type);
        }
        out.push(&part.at, "PreToolUse", base.clone());
        let Some((at, how, ms)) = &part.done else {
            continue;
        };
        let mut payload = base;
        if let Some(ms) = ms {
            payload["duration_ms"] = json!(ms);
        }
        let hook = match how {
            Outcome::Ok => {
                payload["tool_response"] = part.result.clone();
                "PostToolUse"
            }
            Outcome::Failed(error) => {
                payload["error"] = json!(error);
                "PostToolUseFailure"
            }
            Outcome::Interrupted => {
                payload["error"] = json!("aborted by user");
                payload["is_interrupt"] = json!(true);
                "PostToolUseFailure"
            }
            Outcome::Rejected => "ToolRejected",
        };
        out.push(at, hook, payload);
    }
}

/// What one response cost at OpenAI's API list prices, or `None` for a model
/// with no known price. Codex's input count includes what was read from and
/// written to the cache, and its output count the reasoning: each is billed
/// once, at its own price.
fn priced(model: Option<&str>, tokens: &Tokens) -> Option<f64> {
    if *tokens == Tokens::default() {
        return Some(0.0);
    }
    let price = crate::pricing::price_for(model?, tokens.prompt)?;
    Some(price.cost(&crate::pricing::Billed {
        input: tokens.uncached(),
        output: tokens.output,
        cache_read: tokens.cached,
        // Codex does not say which lifetime: the shorter one is the default.
        cache_write_short: tokens.cache_write,
        cache_write_long: 0,
    }))
}

/// What the responses of a session cost, as they are added up.
#[derive(Default)]
struct Spent {
    usd: f64,
    /// Responses added up.
    counted: u64,
    unpriced: u64,
}

impl Spent {
    fn add(&mut self, cost: Option<f64>) {
        self.counted += 1;
        match cost {
            Some(usd) => self.usd += usd,
            None => self.unpriced += 1,
        }
    }

    /// An estimate, partial if some responses are on a model with no known
    /// price, and none when there is no response it can price.
    fn cost(&self) -> Option<Cost> {
        (self.counted > self.unpriced).then(|| Cost::estimate(self.usd, self.unpriced))
    }
}

/// Add `tokens` used on `model` to `usage`, and to `spent` what they cost.
/// Returns that cost.
fn add_usage(
    usage: &mut Vec<ModelUsage>,
    model: Option<&str>,
    tokens: &Tokens,
    spent: &mut Spent,
) -> Option<f64> {
    let cost = priced(model, tokens);
    spent.add(cost);
    let model = model.unwrap_or("unknown");
    let i = usage
        .iter()
        .position(|u| u.model == model)
        .unwrap_or_else(|| {
            usage.push(ModelUsage {
                model: model.to_string(),
                ..Default::default()
            });
            usage.len() - 1
        });
    let entry = &mut usage[i];
    entry.requests += 1;
    entry.input_tokens += tokens.uncached();
    entry.output_tokens += tokens.output;
    entry.thinking_tokens += tokens.reasoning;
    entry.cache_read_tokens += tokens.cached;
    entry.cache_write_5m_tokens += tokens.cache_write;
    if let Some(cost) = cost {
        entry.estimated_cost_usd = Some(entry.estimated_cost_usd.unwrap_or(0.0) + cost);
    }
    cost
}

/// The names threads were given, from the list Codex keeps beside its
/// session folders. The newest entry for a thread is the one that counts.
pub fn thread_names(home: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    // No list: no thread has been named.
    let _ = crate::jsonl::for_each(&home.join("session_index.jsonl"), |row| {
        let Some(id) = row["id"].as_str() else {
            return;
        };
        match row["thread_name"].as_str() {
            Some(name) if !name.is_empty() => names.insert(id.to_string(), name.to_string()),
            _ => names.remove(id),
        };
    });
    names
}

/// The combined size of the files a session is imported from.
pub fn session_bytes(rollout: &Path, subagents: &[PathBuf]) -> u64 {
    std::iter::once(rollout)
        .chain(subagents.iter().map(PathBuf::as_path))
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// A stamp of what the thread is called, which changes without any of the
/// files changing: FNV-1a. 0 for a thread with no name.
pub fn name_hash(name: Option<&str>) -> u64 {
    name.map_or(0, |name| {
        name.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    })
}

/// The session's events and what its rollout says about tokens. `rollout` is
/// the file of the thread the session began as; `subagents` are the files of
/// the threads it spawned, `name` what the thread was called.
pub fn session(
    rollout: &Path,
    subagents: &[PathBuf],
    name: Option<&str>,
) -> Result<(Vec<Value>, Option<Facts>)> {
    let session_id = thread_id(rollout).unwrap_or_default();
    let main = read(rollout, &session_id)?;
    let session_id = match main.meta["id"].as_str() {
        Some(id) if session_id.is_empty() => id.to_string(),
        _ => session_id,
    };
    let Some(first) = main.first_at.clone() else {
        return Ok((Vec::new(), None));
    };
    let mut out = Builder::new(CODEX, &session_id);
    let mut tool_models = HashMap::new();
    let mut usage: Vec<ModelUsage> = Vec::new();

    for (at, turn, text) in &main.prompts {
        out.push(
            at,
            "UserPromptSubmit",
            json!({ "prompt_id": turn, "prompt": text }),
        );
    }
    for (at, turn) in &main.stops {
        out.push(at, "Stop", json!({ "prompt_id": turn }));
    }
    for at in &main.compactions {
        out.push(at, "PostCompact", json!({}));
    }
    push_calls(&main, None, &mut out, &mut tool_models);
    let mut spent = Spent::default();
    for (model, tokens) in &main.responses {
        add_usage(&mut usage, model.as_deref(), tokens, &mut spent);
    }

    let mut subagent_facts = Vec::new();
    // The threads `/review` ran in, and when each began.
    let mut reviewers: Vec<(String, String)> = Vec::new();
    for file in subagents {
        let Some(agent_id) = thread_id(file) else {
            continue;
        };
        // One that cannot be read (moved or half written) is left out: the
        // session still stands without it, and its size changing imports again.
        let Ok(thread) = read(file, &agent_id) else {
            continue;
        };
        let (Some(first), Some(last)) = (&thread.first_at, &thread.last_at) else {
            continue;
        };
        // The reviewer of `/review` has no role of its own: `source` says what it is.
        let reviewer = thread.meta["source"]["subagent"] == "review";
        if reviewer {
            reviewers.push((agent_id.clone(), first.clone()));
        }
        let role = match thread.meta["agent_role"].as_str().unwrap_or_default() {
            "" if reviewer => "review",
            role => role,
        };
        let identity = json!({ "agent_id": agent_id, "agent_type": role });
        out.push(first, "SubagentStart", identity.clone());
        out.push(last, "SubagentStop", identity);
        push_calls(&thread, Some((&agent_id, role)), &mut out, &mut tool_models);
        let mut facts = SubagentFacts {
            agent_id,
            agent_type: Some(role.to_string()).filter(|r| !r.is_empty()),
            description: thread.meta["agent_nickname"].as_str().map(String::from),
            ..Default::default()
        };
        let mut own = Spent::default();
        for (model, tokens) in &thread.responses {
            own.add(add_usage(&mut usage, model.as_deref(), tokens, &mut spent));
            facts.requests += 1;
            facts.input_tokens += tokens.uncached();
            facts.output_tokens += tokens.output;
        }
        facts.estimated_cost_usd = own.cost().map(|c| c.total_usd);
        subagent_facts.push(facts);
    }

    // Each `/review` as the rollout has it, and the threads reviewers ran in:
    // which review each is of is told where the runs are built.
    let review_modes = main
        .reviews
        .iter()
        .map(|review| ReviewMode {
            id: review.id.clone(),
            at: parse_time(&review.at),
            target: review.target.clone(),
            ended_at: review.ended.as_deref().and_then(parse_time),
            findings: review.findings,
            interrupted: review.interrupted,
        })
        .collect();
    let reviewer_threads = reviewers
        .into_iter()
        .map(|(agent_id, began)| ReviewerThread {
            agent_id,
            began: parse_time(&began),
        })
        .collect();

    let mut start = json!({ "source": "startup" });
    if let Some(cwd) = main.meta["cwd"].as_str() {
        start["cwd"] = json!(cwd);
    }
    if let Some(model) = &main.model {
        start["model"] = json!(model);
    }
    if let Some(title) = name {
        start["session_title"] = json!(title);
    }
    out.push(&first, "SessionStart", start);

    usage.sort_by(|a, b| b.requests.cmp(&a.requests).then(a.model.cmp(&b.model)));
    // Where it was started from: `cli`, `exec`, `vscode`; else the client's name.
    let entrypoint = main.meta["source"]
        .as_str()
        .or(main.meta["originator"].as_str());
    let facts = Facts {
        first_at: parse_time(&first),
        last_at: main.last_at.as_deref().and_then(parse_time),
        git_branch: main.meta["git"]["branch"].as_str().map(String::from),
        version: main.meta["cli_version"].as_str().map(String::from),
        entrypoint: entrypoint.map(String::from),
        // Codex records tokens, not money: this is what they would cost at
        // API list prices, not what a ChatGPT plan bills.
        cost: spent.cost(),
        usage,
        subagents: subagent_facts,
        tool_models,
        review_modes,
        review_modes_read: true,
        reviewer_threads,
        ..Default::default()
    };
    Ok((out.finish(), Some(facts)))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::session::CostSource;
    use std::io::Write;

    pub(crate) const MAIN: &str = "019a8f00-0000-7000-8000-000000000001";
    const CHILD: &str = "019a8f00-0000-7000-8000-000000000002";

    fn ts(second: u32) -> String {
        format!("2026-11-16T10:00:{second:02}.000Z")
    }

    fn row(second: u32, kind: &str, payload: Value) -> Value {
        json!({ "timestamp": ts(second), "type": kind, "payload": payload })
    }

    fn event(second: u32, kind: &str, mut payload: Value) -> Value {
        payload["type"] = json!(kind);
        row(second, "event_msg", payload)
    }

    fn item(second: u32, kind: &str, mut payload: Value) -> Value {
        payload["type"] = json!(kind);
        row(second, "response_item", payload)
    }

    fn function(second: u32, id: &str, name: &str, arguments: Value) -> Value {
        item(
            second,
            "function_call",
            json!({ "name": name, "arguments": arguments.to_string(), "call_id": id }),
        )
    }

    fn output(second: u32, id: &str, text: &str) -> Value {
        item(
            second,
            "function_call_output",
            json!({ "call_id": id, "output": text }),
        )
    }

    fn tokens(second: u32, turn: &str, response: &str, thread: &str, input: u64) -> Value {
        row(
            second,
            "token_usage_record",
            json!({ "thread_id": thread, "turn_id": turn, "response_id": response,
                    "usage": { "input_tokens": input, "cached_input_tokens": 400, "output_tokens": 50,
                               "reasoning_output_tokens": 20, "total_tokens": input + 50 } }),
        )
    }

    fn meta(thread: &str, extra: Value) -> Value {
        let mut payload = json!({ "session_id": MAIN, "id": thread, "timestamp": ts(0),
            "cwd": "/work/repo", "originator": "codex-tui", "cli_version": "0.169.0",
            "source": "cli", "base_instructions": { "text": "x".repeat(6000) },
            "git": { "branch": "feat", "commit_hash": "abc" } });
        for (k, v) in extra.as_object().unwrap() {
            payload[k] = v.clone();
        }
        row(0, "session_meta", payload)
    }

    fn write(path: &Path, rows: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        for row in rows {
            writeln!(f, "{row}").unwrap();
        }
    }

    const PATCH: &str = "*** Begin Patch\n*** Add File: b.rs\n+fn b() {}\n+// new\n\
        *** Update File: src/a.rs\n@@ fn a\n keep\n-old();\n+new_one();\n+new_two();\n\
        *** Delete File: gone.rs\n*** End Patch\n";

    /// A session in the older layout: prompts as `user_message` events.
    pub(crate) fn sample(home: &Path) -> PathBuf {
        let path = home.join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let turn = |id: &str, model: &str| {
            row(
                1,
                "turn_context",
                json!({ "turn_id": id, "cwd": "/work/repo", "model": model, "approval_policy": "on-request" }),
            )
        };
        write(
            &path,
            &[
                meta(MAIN, json!({})),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                item(
                    1,
                    "message",
                    json!({ "role": "user", "content": [{ "type": "input_text", "text": "<environment_context>…" }] }),
                ),
                event(1, "user_message", json!({ "message": "add a feature" })),
                turn("t1", "gpt-6-sol"),
                function(2, "c1", "exec_command", json!({ "cmd": "cargo test", "workdir": "/work/repo" })),
                output(
                    4,
                    "c1",
                    "Chunk ID: 1\nWall time: 1.5000 seconds\nProcess exited with code 0\nOutput:\nok\n",
                ),
                tokens(4, "t1", "r1", MAIN, 1000),
                item(
                    5,
                    "custom_tool_call",
                    json!({ "call_id": "c2", "name": "apply_patch", "input": PATCH }),
                ),
                item(
                    6,
                    "custom_tool_call_output",
                    json!({ "call_id": "c2", "output": "Success. Updated the following files:\nA b.rs\nM src/a.rs\nD gone.rs\n" }),
                ),
                function(7, "c3", "exec_command", json!({ "cmd": "false" })),
                output(
                    7,
                    "c3",
                    "Wall time: 0.0100 seconds\nProcess exited with code 1\nOutput:\nboom\n",
                ),
                function(8, "c4", "spawn_agent", json!({ "message": "look around", "task_name": "scout" })),
                output(8, "c4", "{\"task_name\":\"scout\"}"),
                tokens(9, "t1", "r2", MAIN, 2000),
                tokens(9, "t1", "r2", MAIN, 2000), // written twice: counted once
                row(10, "compacted", json!({ "message": "summary" })),
                event(12, "task_complete", json!({ "turn_id": "t1", "duration_ms": 11000 })),
                event(20, "task_started", json!({ "turn_id": "t2" })),
                event(20, "user_message", json!({ "message": "# Context\n## My request for Codex:\nthanks" })),
                turn("t2", "gpt-6-luna"),
                function(21, "c5", "update_plan", json!({ "plan": [] })), // never answered
                tokens(22, "t2", "r3", MAIN, 500),
                event(23, "turn_aborted", json!({ "turn_id": "t2", "reason": "interrupted" })),
            ],
        );
        fs::write(
            home.join("session_index.jsonl"),
            format!(
                "{}\n{}\n",
                json!({ "id": MAIN, "thread_name": "Old name" }),
                json!({ "id": MAIN, "thread_name": "Add a feature" })
            ),
        )
        .unwrap();
        path
    }

    /// The thread `sample` spawned.
    pub(crate) fn subagent(home: &Path) -> PathBuf {
        let path = home.join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-08-{CHILD}.jsonl"
        ));
        write(
            &path,
            &[
                meta(
                    CHILD,
                    json!({ "parent_thread_id": MAIN, "agent_role": "explorer", "agent_nickname": "Scout",
                            "source": { "subagent": { "thread_spawn": { "parent_thread_id": MAIN, "depth": 1 } } } }),
                ),
                event(8, "task_started", json!({ "turn_id": "s1" })),
                event(8, "user_message", json!({ "message": "look around" })),
                row(
                    8,
                    "turn_context",
                    json!({ "turn_id": "s1", "model": "gpt-6-luna" }),
                ),
                function(
                    9,
                    "k1",
                    "shell",
                    json!({ "command": ["bash", "-lc", "rg TODO"] }),
                ),
                output(
                    9,
                    "k1",
                    r#"{"output":"a.rs: TODO\n","metadata":{"exit_code":0,"duration_seconds":0.25}}"#,
                ),
                tokens(9, "s1", "r9", CHILD, 800),
                event(10, "task_complete", json!({ "turn_id": "s1" })),
            ],
        );
        path
    }

    #[test]
    fn a_review_that_was_never_left_does_not_take_the_next_ones_reviewer() {
        let dir = tempfile::tempdir().unwrap();
        let file = |thread: &str| {
            dir.path().join(format!(
                "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{thread}.jsonl"
            ))
        };
        let mode = |second: u32, id: &str, kind: &str| {
            let item =
                json!({ "type": kind, "id": id, "target": { "type": "uncommittedChanges" } });
            event(
                second,
                "item_completed",
                json!({ "turn_id": "t1", "item": item }),
            )
        };
        let main = file(MAIN);
        write(
            &main,
            &[
                meta(MAIN, json!({ "history_mode": "paginated" })),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                // never left
                mode(1, "r1", "EnteredReviewMode"),
                mode(30, "r2", "EnteredReviewMode"),
                mode(39, "r2x", "ExitedReviewMode"),
            ],
        );
        let reviewer = file(CHILD);
        write(
            &reviewer,
            &[
                meta(
                    CHILD,
                    json!({ "parent_thread_id": MAIN, "thread_source": "subagent",
                            "source": { "subagent": "review" } }),
                ),
                event(31, "task_started", json!({ "turn_id": "s1" })),
                row(
                    31,
                    "turn_context",
                    json!({ "turn_id": "s1", "model": "gpt-6-luna" }),
                ),
                tokens(32, "s1", "r9", CHILD, 800),
                event(38, "task_complete", json!({ "turn_id": "s1" })),
            ],
        );
        let (events, facts) = session(&main, &[reviewer], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.subagents, r.duration_ms))
            .collect();
        assert_eq!(runs, [(0, None), (1, Some(9000))]);
    }

    #[test]
    fn the_older_layout_has_review_mode_as_events_and_one_left_with_nothing_was_interrupted() {
        use crate::session::ToolStatus;
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let found = json!({ "findings": [{ "title": "x" }, { "title": "y" }] });
        write(
            &main,
            &[
                // no `history_mode`: the older layout
                meta(MAIN, json!({})),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                event(
                    1,
                    "entered_review_mode",
                    json!({ "target": { "type": "uncommittedChanges" } }),
                ),
                event(9, "exited_review_mode", json!({ "review_output": found })),
                event(
                    20,
                    "entered_review_mode",
                    json!({ "target": { "type": "custom" } }),
                ),
                // interrupted: left with nothing returned
                event(25, "exited_review_mode", json!({ "review_output": null })),
            ],
        );
        let (events, facts) = session(&main, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.target.as_deref(), r.status, r.findings, r.duration_ms))
            .collect();
        assert_eq!(
            runs,
            [
                (
                    Some("uncommitted_changes"),
                    ToolStatus::Ok,
                    Some(2),
                    Some(8000)
                ),
                (Some("custom"), ToolStatus::Interrupted, None, Some(5000)),
            ]
        );
        assert_eq!(s.counts.reviews, Some(2));
    }

    #[test]
    fn review_events_of_another_thread_or_beside_the_items_are_not_more_reviews() {
        let dir = tempfile::tempdir().unwrap();
        let file = |name: &str| {
            dir.path().join(format!(
                "sessions/2026/11/16/rollout-2026-11-16T12-00-0{name}-{MAIN}.jsonl"
            ))
        };
        let entered = |second: u32, more: Value| event(second, "entered_review_mode", more);
        let count = |path: &Path| {
            let (events, facts) = session(path, &[], None).unwrap();
            let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
            s.counts.reviews
        };
        // The paginated layout has an item for each review: an event beside
        // it is the same review.
        let item = json!({ "type": "EnteredReviewMode", "id": "r1" });
        let paginated = file("1");
        write(
            &paginated,
            &[
                meta(MAIN, json!({ "history_mode": "paginated" })),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                entered(1, json!({})),
                event(
                    1,
                    "item_completed",
                    json!({ "turn_id": "t1", "item": item }),
                ),
            ],
        );
        assert_eq!(count(&paginated), Some(1));
        // The older layout: an event of another thread is that thread's review.
        let older = file("2");
        write(
            &older,
            &[
                meta(MAIN, json!({})),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                entered(1, json!({})),
                entered(5, json!({ "thread_id": CHILD })),
                event(
                    6,
                    "exited_review_mode",
                    json!({ "thread_id": CHILD, "review_output": null }),
                ),
            ],
        );
        let (events, facts) = session(&older, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        assert_eq!(s.counts.reviews, Some(1));
        // Still running: the other thread's leaving did not end it.
        assert_eq!(s.reviews[0].duration_ms, None);
    }

    #[test]
    fn two_reviews_whose_items_have_no_id_are_two_runs() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let mode = |second: u32, kind: &str| {
            event(
                second,
                "item_completed",
                json!({ "turn_id": "t1", "item": { "type": kind } }),
            )
        };
        write(
            &main,
            &[
                meta(MAIN, json!({ "history_mode": "paginated" })),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                mode(1, "EnteredReviewMode"),
                mode(9, "ExitedReviewMode"),
                mode(20, "EnteredReviewMode"),
                mode(29, "ExitedReviewMode"),
            ],
        );
        let (events, facts) = session(&main, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        assert_eq!(s.counts.reviews, Some(2));
    }

    #[test]
    fn review_mode_is_a_review_run_with_its_reviewer_and_findings() {
        use crate::session::{ReviewVia, ToolStatus};
        let dir = tempfile::tempdir().unwrap();
        let file = |thread: &str| {
            dir.path().join(format!(
                "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{thread}.jsonl"
            ))
        };
        let mode = |second: u32, id: &str, kind: &str, more: Value| {
            let mut item = json!({ "type": kind, "id": id });
            for (k, v) in more.as_object().unwrap() {
                item[k] = v.clone();
            }
            event(
                second,
                "item_completed",
                json!({ "turn_id": "t1", "item": item }),
            )
        };
        let found =
            |n: usize| json!({ "review_output": { "findings": vec![json!({ "title": "x" }); n] } });
        let main = file(MAIN);
        write(
            &main,
            &[
                meta(MAIN, json!({ "history_mode": "paginated" })),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                mode(
                    1,
                    "r1",
                    "EnteredReviewMode",
                    json!({ "target": { "type": "baseBranch", "branch": "main" } }),
                ),
                mode(9, "r1x", "ExitedReviewMode", found(3)),
                event(9, "task_complete", json!({ "turn_id": "t1" })),
                // left running when the session stopped
                mode(
                    20,
                    "r2",
                    "EnteredReviewMode",
                    json!({ "target": { "type": "uncommittedChanges" } }),
                ),
            ],
        );
        let reviewer = file(CHILD);
        write(
            &reviewer,
            &[
                meta(
                    CHILD,
                    json!({ "parent_thread_id": MAIN, "thread_source": "subagent",
                            "source": { "subagent": "review" } }),
                ),
                event(2, "task_started", json!({ "turn_id": "s1" })),
                row(
                    2,
                    "turn_context",
                    json!({ "turn_id": "s1", "model": "gpt-6-luna" }),
                ),
                tokens(3, "s1", "r9", CHILD, 800),
                event(8, "task_complete", json!({ "turn_id": "s1" })),
            ],
        );
        let (events, facts) = session(&main, &[reviewer], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        assert_eq!(s.counts.reviews, Some(2));
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| {
                (
                    r.command.as_str(),
                    r.via,
                    r.target.as_deref(),
                    r.status,
                    r.duration_ms,
                    r.subagents,
                    r.findings,
                )
            })
            .collect();
        assert_eq!(
            runs,
            [
                (
                    "review",
                    ReviewVia::CodexReview,
                    Some("base_branch"),
                    ToolStatus::Ok,
                    Some(8000),
                    1,
                    Some(3)
                ),
                (
                    "review",
                    ReviewVia::CodexReview,
                    Some("uncommitted_changes"),
                    ToolStatus::NoResult,
                    None,
                    0,
                    None
                ),
            ]
        );
        // what the reviewer's tokens cost, and it is named for what it is
        assert!(s.reviews[0].estimated_cost_usd.is_some());
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("review"));
    }

    #[test]
    fn rebuilds_a_codex_session() {
        let dir = tempfile::tempdir().unwrap();
        let (main, child) = (sample(dir.path()), subagent(dir.path()));
        assert_eq!(thread_id(&main).as_deref(), Some(MAIN));
        assert_eq!(root_of(&child).as_deref(), Some(MAIN));

        let names = thread_names(dir.path());
        let name = names.get(MAIN).map(String::as_str);
        assert_ne!(name_hash(name), name_hash(Some("Another")));
        assert_ne!(name_hash(Some("")), name_hash(None));
        assert_eq!(
            session_bytes(&main, &[]),
            fs::metadata(&main).unwrap().len()
        );
        let (events, facts) = session(&main, &[child], name).unwrap();
        let facts = facts.unwrap();
        assert!(events
            .iter()
            .all(|e| e["source"] == "codex" && e["origin"] == "transcript"));
        assert_eq!(events[0]["hook"], "SessionStart");

        let s = crate::normalize::from_events(&events, Some(&facts), CODEX).unwrap();
        assert_eq!(s.session_id, MAIN);
        assert_eq!(s.title.as_deref(), Some("Add a feature"));
        assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(s.agent_version.as_deref(), Some("0.169.0"));
        assert_eq!(s.entrypoint.as_deref(), Some("cli"));
        assert_eq!(facts.git_branch.as_deref(), Some("feat"));
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["add a feature", "thanks"]);
        assert_eq!(
            s.prompts[0].outcome,
            Some(crate::session::Outcome::Completed)
        );
        assert_eq!(s.prompts[1].outcome, None);
        assert_eq!(s.active_ms, 11_000);
        assert_eq!(s.counts.compactions, 1);

        use crate::session::ToolStatus::*;
        let calls: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.status))
            .collect();
        assert_eq!(
            calls,
            [
                ("Bash", Ok),
                ("Write", Ok),
                ("Edit", Ok),
                ("Edit", Ok),
                ("Bash", Failed),
                ("Agent", Ok),
                ("Bash", Ok),
                ("TodoWrite", NoResult)
            ]
        );
        assert_eq!(s.tool_calls[0].input_summary.as_deref(), Some("cargo test"));
        assert_eq!(s.tool_calls[0].duration_ms, Some(1500));
        assert_eq!(s.tool_calls[0].model.as_deref(), Some("gpt-6-sol"));
        assert_eq!(s.tool_calls[4].error.as_deref(), Some("boom"));
        assert_eq!(s.tool_calls[5].input_summary.as_deref(), Some("scout"));
        // the subagent's command, in the older output format
        assert_eq!(s.tool_calls[6].agent_id.as_deref(), Some(CHILD));
        assert_eq!(s.tool_calls[6].input_summary.as_deref(), Some("rg TODO"));
        assert_eq!(s.tool_calls[6].duration_ms, Some(250));

        // one patch, three files, with paths taken from the turn's directory
        let file = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        assert!(file("/work/repo/b.rs").created);
        assert_eq!(file("/work/repo/b.rs").lines_added, 2);
        let a = file("/work/repo/src/a.rs");
        assert_eq!((a.lines_added, a.lines_removed), (2, 1));
        assert_eq!(file("/work/repo/gone.rs").writes, 1);
        assert_eq!(crate::rewrite::added_lines(&events).len(), 2);

        assert_eq!(s.subagents.len(), 1);
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("explorer"));
        assert_eq!(s.subagents[0].tool_calls, 1);
        assert_eq!(s.subagents[0].requests, 1);

        // tokens per model, each response once
        assert_eq!(s.models, ["gpt-6-luna", "gpt-6-sol"]);
        let luna = &s.usage[0];
        assert_eq!((luna.requests, luna.input_tokens), (2, 100 + 400));
        let sol = &s.usage[1];
        assert_eq!(
            (
                sol.requests,
                sol.input_tokens,
                sol.cache_read_tokens,
                sol.output_tokens,
                sol.thinking_tokens
            ),
            (2, 600 + 1600, 800, 100, 40)
        );

        // and what they would cost at API list prices, as an estimate: the
        // cached input once at its own price, the reasoning within output
        let close = |a: Option<f64>, b: f64| (a.unwrap() - b).abs() < 1e-12;
        // 2200 x $2 + 800 x $0.20 + 100 x $10
        assert!(close(sol.estimated_cost_usd, 5560e-6));
        // 500 x $0.10 + 800 x $0.01 + 100 x $0.50, the subagent's half of it
        assert!(close(luna.estimated_cost_usd, 108e-6));
        assert!(close(s.subagents[0].estimated_cost_usd, 69e-6));
        let cost = s.cost.unwrap();
        assert_eq!(cost.source, CostSource::Estimated);
        assert!(close(Some(cost.total_usd), 5668e-6));
        assert_eq!(cost.unpriced_requests, 0);
    }

    #[test]
    fn a_model_with_no_known_price_stays_unpriced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let turn = |id: &str, model: &str| {
            row(1, "turn_context", json!({ "turn_id": id, "model": model }))
        };
        let mut rows = vec![
            meta(MAIN, json!({})),
            event(1, "task_started", json!({ "turn_id": "t1" })),
            event(1, "user_message", json!({ "message": "hi" })),
            turn("t1", "gpt-9-nova"),
            tokens(2, "t1", "r1", MAIN, 1000),
        ];
        write(&path, &rows);
        let (events, facts) = session(&path, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        assert_eq!(s.cost, None);
        assert_eq!(s.usage[0].estimated_cost_usd, None);
        assert_eq!(s.usage[0].input_tokens, 600);

        // next to a priced one: an estimate that says it leaves one out
        rows.extend([
            event(3, "task_started", json!({ "turn_id": "t2" })),
            turn("t2", "openai/gpt-6.1-sol-2026-09-30"),
            tokens(4, "t2", "r2", MAIN, 1000),
        ]);
        write(&path, &rows);
        let (events, facts) = session(&path, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        let cost = s.cost.unwrap();
        assert_eq!(cost.source, CostSource::PartialEstimate);
        assert_eq!(cost.unpriced_requests, 1);
        // 600 x $2 + 400 x $0.10 + 50 x $10
        assert!((cost.total_usd - 1740e-6).abs() < 1e-12);
    }

    #[test]
    fn a_long_prompt_is_priced_as_one() {
        let long = Tokens {
            input: 300_000,
            cached: 200_000,
            output: 1_000,
            prompt: 300_000,
            ..Default::default()
        };
        // 100K x $4 + 200K x $0.20 + 1K x $15
        let cost = priced(Some("gpt-6.1-sol"), &long).unwrap();
        assert!((cost - 0.455).abs() < 1e-12);
        // as much over several responses, none of which is known to be that long: the shorter tier
        let several = Tokens { prompt: 0, ..long };
        // 100K x $2 + 200K x $0.10 + 1K x $10
        assert!((priced(Some("gpt-6.1-sol"), &several).unwrap() - 0.23).abs() < 1e-12);
        let written = Tokens {
            input: 1_000,
            cache_write: 1_000,
            ..Default::default()
        };
        // all of it written to the cache, at the 30-minute price
        assert!((priced(Some("gpt-6.1-sol"), &written).unwrap() - 0.0025).abs() < 1e-12);
        // no write price listed: at the input price
        assert!((priced(Some("gpt-5.4"), &written).unwrap() - 0.0025).abs() < 1e-12);
    }

    #[test]
    fn a_compressed_rollout_reads_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let plain = sample(dir.path());
        let child = subagent(dir.path());
        let (events, facts) =
            session(&plain, std::slice::from_ref(&child), Some("Add a feature")).unwrap();

        let packed = dir.path().join("packed");
        let zst = |from: &Path| {
            let name = format!("{}.zst", from.file_name().unwrap().to_string_lossy());
            let to = packed.join("sessions/2026/11/16").join(name);
            fs::create_dir_all(to.parent().unwrap()).unwrap();
            let bytes = zstd::encode_all(fs::File::open(from).unwrap(), 1).unwrap();
            fs::write(&to, bytes).unwrap();
            to
        };
        let (main_zst, child_zst) = (zst(&plain), zst(&child));
        assert_eq!(thread_id(&main_zst).as_deref(), Some(MAIN));
        assert_eq!(rollout_id(&main_zst).as_deref(), Some(MAIN));
        assert_eq!(root_of(&child_zst).as_deref(), Some(MAIN));
        assert_eq!(files_in(&packed).len(), 2);

        let (packed_events, packed_facts) =
            session(&main_zst, &[child_zst], Some("Add a feature")).unwrap();
        assert_eq!(packed_events, events);
        assert_eq!(packed_facts, facts);
    }

    #[test]
    fn a_reverted_thread_keeps_what_came_before_the_revert() {
        const LATER: &str = "019a8f00-0000-7000-8000-000000000003";
        const FORK: &str = "019a8f00-0000-7000-8000-000000000004";
        let dir = tempfile::tempdir().unwrap();
        let turn = |second: u32, id: &str, prompt: &str, thread: &str| {
            [
                event(second, "task_started", json!({ "turn_id": id })),
                event(second, "user_message", json!({ "message": prompt })),
                tokens(second + 1, id, &format!("r-{id}"), thread, 1000),
                event(second + 2, "task_complete", json!({ "turn_id": id })),
            ]
        };
        let mut before = vec![meta(MAIN, json!({}))];
        before.extend(turn(1, "t1", "first", MAIN));
        // what stands: everything up to the second turn
        let kept: usize = before.iter().map(|row| row.to_string().len() + 1).sum();
        before.extend(turn(10, "t2", "taken back", MAIN));
        write(
            &dir.path().join(format!(
                "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
            )),
            &before,
        );
        let base = json!({ "history_base":
            { "thread_id": MAIN, "end_ordinal_exclusive": 5, "end_byte_offset": kept } });

        let mut after = vec![meta(MAIN, base.clone())];
        after.extend(turn(20, "t3", "instead", MAIN));
        let reverted = dir.path().join(format!(
            "sessions/2026/11/17/rollout-2026-11-17T09-00-00-{MAIN}_{LATER}.jsonl"
        ));
        write(&reverted, &after);
        assert_eq!(thread_id(&reverted).as_deref(), Some(MAIN));

        let (events, facts) = session(&reverted, &[], None).unwrap();
        let facts = facts.unwrap();
        let s = crate::normalize::from_events(&events, Some(&facts), CODEX).unwrap();
        assert_eq!(s.session_id, MAIN);
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["first", "instead"]);
        assert_eq!(facts.usage[0].requests, 2);

        // a fork has its own thread: what it has from its parent stays there
        let mut forked = vec![meta(FORK, base)];
        forked.extend(turn(30, "f1", "another way", FORK));
        let fork = dir.path().join(format!(
            "sessions/2026/11/17/rollout-2026-11-17T10-00-00-{FORK}.jsonl"
        ));
        write(&fork, &forked);
        // it carries its parent's session id, and is still no subagent of it
        assert_eq!(root_of(&fork).as_deref(), Some(FORK));
        let (events, facts) = session(&fork, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["another way"]);
    }

    #[test]
    fn the_newest_file_of_a_reverted_thread_is_the_one_nothing_continues() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join(format!(
            "archived_sessions/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        write(&first, &[meta(MAIN, json!({}))]);
        let base = json!({ "history_base":
            { "thread_id": MAIN, "end_ordinal_exclusive": 1, "end_byte_offset": 1 } });
        let second = dir.path().join(format!(
            "sessions/2026/11/17/rollout-2026-11-17T09-00-00-{MAIN}_0192-later.jsonl"
        ));
        write(&second, &[meta(MAIN, base)]);
        // the second file is found first, the archived one last
        let files = vec![second.clone(), first.clone()];
        assert_eq!(latest_rollout(&files), Some(&second));
        assert_eq!(latest_rollout(&files[1..]), Some(&first));

        // with no chain to go by, the later file name wins, not the folder order
        let (a, b) = (dir.path().join("sessions/a"), dir.path().join("archived/b"));
        let early = a.join(format!("rollout-2026-11-16T12-00-00-{MAIN}.jsonl"));
        let late = b.join(format!("rollout-2026-11-18T12-00-00-{MAIN}_x.jsonl"));
        write(&early, &[json!({})]);
        write(&late, &[json!({})]);
        assert_eq!(latest_rollout(&[late.clone(), early]), Some(&late));
    }

    #[test]
    fn finds_the_root_session_whatever_comes_before_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join(format!("rollout-2026-11-16T12-00-00-{CHILD}.jsonl"));
        let mut payload = json!({ "source": { "subagent": { "session_id": "someone-else" } },
            "base_instructions": { "text": "x".repeat(6000) } });
        payload["session_id"] = json!(MAIN);
        write(&path, &[row(0, "session_meta", payload)]);
        assert_eq!(root_of(&path).as_deref(), Some(MAIN));
    }

    #[test]
    fn roots_are_remembered_and_found_after_the_rollout_moves() {
        let dir = tempfile::tempdir().unwrap();
        let child = subagent(dir.path());
        let cache = dir.path().join("imported");

        let mut roots = Roots::load(&cache);
        assert_eq!(roots.root_of(&child).as_deref(), Some(MAIN));
        roots.save();

        // archived: the old path is gone
        let archived = dir
            .path()
            .join("archived_sessions")
            .join(child.file_name().unwrap());
        fs::create_dir_all(archived.parent().unwrap()).unwrap();
        fs::rename(&child, &archived).unwrap();
        // from memory, with no file to read
        assert_eq!(Roots::load(&cache).root_of(&child).as_deref(), Some(MAIN));
        // from the thread's file in its new place, with nothing remembered
        let mut fresh = Roots::load(&dir.path().join("elsewhere"));
        assert_eq!(fresh.root_of(&child).as_deref(), Some(MAIN));
        // a capture that names no rollout is looked at again only once it grows
        let capture = dir.path().join("capture.jsonl");
        fs::write(&capture, "{\"payload\":{\"transcript_path\":null}}\n").unwrap();
        let mut learning = Roots::load(&cache);
        assert_eq!(learning.rollout_of(&capture), None);
        fs::write(&capture, format!("{{\"payload\":{{\"transcript_path\":null}}}}\n{{\"payload\":{{\"transcript_path\":\"{}\"}}}}\n", child.display())).unwrap();
        assert_eq!(learning.rollout_of(&capture), Some(child.clone()));
        // a rollout that is nowhere has no root
        let nowhere = dir.path().join(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-09-019a8f00-0000-7000-8000-0000000000ff.jsonl",
        );
        assert_eq!(fresh.root_of(&nowhere), None);
    }

    #[test]
    fn a_subagent_belongs_to_the_thread_that_spawned_it_fork_or_not() {
        const FORK: &str = "019a8f00-0000-7000-8000-0000000000f0";
        const DEEPER: &str = "019a8f00-0000-7000-8000-0000000000f1";
        let dir = tempfile::tempdir().unwrap();
        let file = |thread: &str| {
            dir.path().join(format!(
                "sessions/2026/11/17/rollout-2026-11-17T10-00-00-{thread}.jsonl"
            ))
        };
        let spawned_by = |parent: &str| json!({ "source": { "subagent": { "thread_spawn": { "parent_thread_id": parent } } } });
        // a fork carries its parent's session id, and so does what it spawns
        write(&file(FORK), &[meta(FORK, json!({}))]);
        write(&file(CHILD), &[meta(CHILD, spawned_by(FORK))]);
        assert_eq!(root_of(&file(CHILD)).as_deref(), Some(FORK));
        // a subagent's own subagent is part of the same session
        write(&file(DEEPER), &[meta(DEEPER, spawned_by(CHILD))]);
        assert_eq!(root_of(&file(DEEPER)).as_deref(), Some(FORK));

        // with the fork's file gone, the session id is all there is to go by
        fs::remove_file(file(FORK)).unwrap();
        assert_eq!(root_of(&file(CHILD)).as_deref(), Some(MAIN));
        // and with no session id, the thread that is named
        let mut bare = spawned_by(FORK);
        bare["id"] = json!(CHILD);
        write(&file(CHILD), &[row(0, "session_meta", bare)]);
        assert_eq!(root_of(&file(CHILD)).as_deref(), Some(FORK));
    }

    #[test]
    fn what_an_earlier_rule_remembered_stands_only_for_a_rollout_that_is_gone() {
        const FORK: &str = "019a8f00-0000-7000-8000-0000000000f0";
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("imported");
        let fork = dir.path().join(format!(
            "sessions/2026/11/17/rollout-2026-11-17T10-00-00-{FORK}.jsonl"
        ));
        write(&fork, &[meta(FORK, json!({}))]);
        // a subagent whose rollout was deleted after its root was found out
        let gone = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-08-{CHILD}.jsonl"
        ));
        fs::create_dir_all(&cache).unwrap();
        // as it was written before there was a rule to name
        let (fork_key, gone_key) = (fork.to_string_lossy(), gone.to_string_lossy());
        let remembered = json!({ "roots": { &*fork_key: MAIN, &*gone_key: MAIN } });
        fs::write(cache.join("_roots.json"), remembered.to_string()).unwrap();

        // someone who asks about neither leaves both as they are
        let mut roots = Roots::load(&cache);
        assert_eq!(roots.root_of(&sample(dir.path())).as_deref(), Some(MAIN));
        roots.save();

        let mut roots = Roots::load(&cache);
        // read again: a fork is its own session by the rule of now
        assert_eq!(roots.root_of(&fork).as_deref(), Some(FORK));
        // nothing to read: what was remembered is kept
        assert_eq!(roots.root_of(&gone).as_deref(), Some(MAIN));
        roots.save();
        // and is not looked for again
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(cache.join("_roots.json")).unwrap()).unwrap();
        assert_eq!(saved["roots"][&*gone_key], MAIN);
        assert_eq!(saved["roots_before"], json!({}));
        assert_eq!(Roots::load(&cache).root_of(&gone).as_deref(), Some(MAIN));
    }

    fn tool_names(events: &[Value], hook: &str) -> Vec<String> {
        events
            .iter()
            .filter(|e| e["hook"] == hook)
            .map(|e| {
                e["payload"]["tool_name"]
                    .as_str()
                    .unwrap_or_default()
                    .into()
            })
            .collect()
    }

    #[test]
    fn a_paginated_shell_call_and_its_item_are_one_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let done = |second: u32, id: &str, command: &str| {
            event(
                second,
                "item_completed",
                json!({ "thread_id": MAIN, "turn_id": "t1", "item": { "type": "CommandExecution",
                        "id": id, "command": ["/bin/bash", "-lc", command], "status": "completed",
                        "aggregated_output": "", "exit_code": 0 } }),
            )
        };
        write(
            &path,
            &[
                meta(MAIN, json!({ "history_mode": "paginated" })),
                event(1, "task_started", json!({ "turn_id": "t1" })),
                row(
                    1,
                    "turn_context",
                    json!({ "turn_id": "t1", "cwd": "/work/repo", "model": "gpt-6-sol" }),
                ),
                // `make` is run twice and kept twice; `ls` once, and not as an item
                function(2, "c1", "shell_command", json!({ "command": "make" })),
                done(3, "i1", "make"),
                function(4, "c2", "shell_command", json!({ "command": "make" })),
                done(5, "i2", "make"),
                function(6, "c3", "shell_command", json!({ "command": "ls" })),
                // an item that has the command as one line, a call that has its words
                function(
                    6,
                    "c4",
                    "shell",
                    json!({ "command": ["bash", "-lc", "rg TODO"] }),
                ),
                event(
                    6,
                    "item_completed",
                    json!({ "thread_id": MAIN, "turn_id": "t1", "item": { "type": "CommandExecution",
                            "id": "i9", "command": "bash -lc 'rg TODO'", "status": "completed",
                            "aggregated_output": "", "exit_code": 0 } }),
                ),
                // an item that has no id of its own
                event(
                    7,
                    "item_completed",
                    json!({ "thread_id": MAIN, "turn_id": "t1", "item": { "type": "CommandExecution",
                            "command": ["echo"], "status": "completed", "exit_code": 0 } }),
                ),
                event(
                    7,
                    "item_completed",
                    json!({ "thread_id": MAIN, "turn_id": "t1", "item": { "type": "CommandExecution",
                            "id": "", "command": ["pwd"], "status": "completed", "exit_code": 0 } }),
                ),
            ],
        );
        let (events, _) = session(&path, &[], None).unwrap();
        assert_eq!(tool_names(&events, "PreToolUse"), ["Bash"; 6]);
        let mut ids: Vec<&str> = events
            .iter()
            .filter(|e| e["hook"] == "PreToolUse")
            .filter_map(|e| e["payload"]["tool_use_id"].as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 6, "{ids:?}");
        assert!(ids.iter().all(|id| !id.is_empty()));
    }

    #[test]
    fn a_command_reads_the_same_whether_it_is_words_or_a_line() {
        let words = command_line(&json!(["/bin/bash", "-lc", "rg TODO"]));
        assert_eq!(words.as_deref(), Some("rg TODO"));
        for line in [
            "bash -lc 'rg TODO'",
            "/bin/bash -lc \"rg TODO\"",
            "sh -c rg TODO",
        ] {
            assert_eq!(command_line(&json!(line)), words, "{line}");
        }
        assert_eq!(command_line(&json!("ls -la")).as_deref(), Some("ls -la"));
        // quotes that do not enclose the whole script are the script's own
        assert_eq!(
            command_line(&json!("bash -lc 'echo a' && 'echo b'")).as_deref(),
            Some("'echo a' && 'echo b'")
        );
        // only a shell's script is unwrapped
        assert_eq!(
            command_line(&json!(["python", "-c", "print(1)"])).as_deref(),
            Some("python -c print(1)")
        );
    }

    #[test]
    fn tokens_with_no_turn_of_their_own_belong_to_the_model_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let context = |second: u32, turn: &str, model: &str| {
            row(
                second,
                "turn_context",
                json!({ "turn_id": turn, "cwd": "/w", "model": model }),
            )
        };
        let record = |second: u32, response: &str| {
            row(
                second,
                "token_usage_record",
                json!({ "thread_id": MAIN, "response_id": response,
                        "usage": { "input_tokens": 100, "output_tokens": 10, "total_tokens": 110 } }),
            )
        };
        write(
            &path,
            &[
                meta(MAIN, json!({})),
                event(1, "user_message", json!({ "message": "go" })),
                context(1, "t1", "model-a"),
                record(2, "r1"),
                context(3, "t2", "model-b"),
                record(4, "r2"),
            ],
        );
        let (_, facts) = session(&path, &[], None).unwrap();
        let usage = facts.unwrap().usage;
        let requests = |model: &str| usage.iter().find(|u| u.model == model).map(|u| u.requests);
        assert_eq!(
            (requests("model-a"), requests("model-b")),
            (Some(1), Some(1))
        );
    }

    #[test]
    fn a_running_total_is_priced_long_only_for_one_long_response() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!(
            "sessions/2026/11/16/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let count = |second: u32, total: u64, last: Option<u64>| {
            let mut info = json!({ "total_token_usage": { "input_tokens": total } });
            if let Some(last) = last {
                info["last_token_usage"] = json!({ "input_tokens": last });
            }
            event(second, "token_count", json!({ "info": info }))
        };
        let cost = |counts: Vec<Value>| {
            let mut rows = vec![
                meta(MAIN, json!({})),
                event(1, "user_message", json!({ "message": "go" })),
                row(
                    1,
                    "turn_context",
                    json!({ "turn_id": "t1", "cwd": "/w", "model": "gpt-6.1-sol" }),
                ),
            ];
            rows.extend(counts);
            write(&path, &rows);
            let (events, facts) = session(&path, &[], None).unwrap();
            let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
            s.cost.unwrap().total_usd
        };
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        // one response of 300K: the long tier, at $4
        assert!(close(cost(vec![count(2, 300_000, Some(300_000))]), 1.2));
        // two of 150K reported as one step: neither is long, so $2
        assert!(close(cost(vec![count(2, 300_000, Some(150_000))]), 0.6));
        // nor is one with no last response to tell it by
        assert!(close(cost(vec![count(2, 300_000, None)]), 0.6));
        // after the total starts again, what it holds is not one response's
        let again = vec![
            count(2, 100_000, Some(100_000)),
            count(3, 300_000, Some(200_000)),
            count(4, 290_000, Some(150_000)),
        ];
        // 100K + 200K + 290K, each at $2
        assert!(close(cost(again), 1.18));
    }

    #[test]
    fn a_subagent_that_cannot_be_read_leaves_the_session_standing() {
        let dir = tempfile::tempdir().unwrap();
        let (main, child) = (sample(dir.path()), subagent(dir.path()));
        fs::remove_file(&child).unwrap();
        let (events, facts) = session(&main, &[child], None).unwrap();
        assert!(facts.is_some());
        assert!(events.iter().all(|e| e["hook"] != "SubagentStart"));
    }

    #[test]
    fn reads_the_paginated_layout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!(
            "archived_sessions/rollout-2026-11-16T12-00-00-{MAIN}.jsonl"
        ));
        let done = |second: u32, turn: &str, item: Value| {
            event(
                second,
                "item_completed",
                json!({ "thread_id": MAIN, "turn_id": turn, "item": item }),
            )
        };
        let mut rows = vec![
            meta(
                MAIN,
                json!({ "history_mode": "paginated", "subagent_history_start_ordinal": 3 }),
            ),
            // inherited from the thread this one came from
            event(0, "user_message", json!({ "message": "not mine" })),
            tokens(0, "t0", "r0", MAIN, 9000),
            done(
                1,
                "t1",
                json!({ "type": "UserMessage", "id": "u1", "content": [
                    { "type": "text", "text": "fix it" }, { "type": "local_image", "path": "/tmp/a.png" }] }),
            ),
            event(1, "task_started", json!({ "turn_id": "t1" })),
            row(
                1,
                "turn_context",
                json!({ "turn_id": "t1", "cwd": "/work/repo", "model": "gpt-6-sol" }),
            ),
            // The model's tools are reached through a script; what ran is in the items.
            item(
                2,
                "custom_tool_call",
                json!({ "call_id": "call_1", "name": "exec",
                        "input": "const r = await tools.exec_command({cmd:\"make\"});\ntext(r.output);\n" }),
            ),
            done(
                5,
                "t1",
                json!({ "type": "CommandExecution", "id": "exec-1", "command": ["/bin/bash", "-lc", "make"],
                        "cwd": "file:///work/repo", "source": "unified_exec_startup", "status": "completed",
                        "aggregated_output": format!("{}useful tail\n", "x".repeat(250)), "exit_code": 2,
                        "duration": { "secs": 2, "nanos": 500_000_000 } }),
            ),
            item(
                5,
                "custom_tool_call_output",
                json!({ "call_id": "call_1", "output": [{ "type": "input_text", "text": "Script completed\nWall time 3.0 seconds\nOutput:\n" }] }),
            ),
            done(
                6,
                "t1",
                json!({ "type": "CommandExecution", "id": "exec-2", "command": ["rm", "-rf", "/"], "status": "declined" }),
            ),
            done(
                6,
                "t1",
                json!({ "type": "CommandExecution", "id": "exec-3", "command": ["make"],
                        "source": "unified_exec_interaction", "status": "completed", "exit_code": 0 }),
            ),
            done(
                7,
                "t1",
                json!({ "type": "FileChange", "id": "exec-4", "status": "completed", "stdout": "Success.", "stderr": "",
                        "changes": {
                            "/work/repo/src/a.rs": { "type": "update", "move_path": null,
                                "unified_diff": "@@ -1,2 +1,3 @@\n keep\n-old();\n+new_one();\n+new_two();\n" },
                            "/work/repo/b.rs": { "type": "add", "content": "fn b() {}\n" },
                            "/work/repo/gone.rs": { "type": "delete", "content": "one\ntwo\n" } } }),
            ),
            done(
                7,
                "t1",
                json!({ "type": "WebSearch", "id": "ws-1", "query": "rust lark", "action": { "type": "search" } }),
            ),
            function(7, "c9", "update_plan", json!({ "plan": [] })),
            output(7, "c9", "Plan updated"),
            event(
                8,
                "token_count",
                json!({ "info": { "total_token_usage": { "input_tokens": 700, "cached_input_tokens": 200, "output_tokens": 30 } } }),
            ),
            event(
                9,
                "token_count",
                json!({ "info": { "total_token_usage": { "input_tokens": 700, "cached_input_tokens": 200, "output_tokens": 30 } } }),
            ),
            event(
                9,
                "token_count",
                json!({ "info": { "total_token_usage": { "input_tokens": 1000, "cached_input_tokens": 300, "output_tokens": 50 } } }),
            ),
            event(10, "task_complete", json!({ "turn_id": "t1" })),
        ];
        for (ordinal, row) in rows.iter_mut().enumerate() {
            row["ordinal"] = json!(ordinal);
        }
        write(&path, &rows);

        let (events, facts) = session(&path, &[], None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CODEX).unwrap();
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(prompts, ["fix it"]);
        assert_eq!(s.active_ms, 9_000);
        use crate::session::ToolStatus::*;
        let calls: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.status))
            .collect();
        assert_eq!(
            calls,
            [
                ("Bash", Failed),
                ("Bash", Rejected),
                ("TodoWrite", Ok),
                ("Edit", Ok),
                ("Write", Ok),
                ("Edit", Ok),
                ("WebSearch", Ok)
            ]
        );
        assert_eq!(s.tool_calls[0].input_summary.as_deref(), Some("make"));
        assert_eq!(s.tool_calls[0].duration_ms, Some(2500));
        let error = s.tool_calls[0].error.as_deref().unwrap();
        assert_eq!(error.chars().count(), 200);
        assert!(error.ends_with("useful tail"), "{error:?}");
        assert_eq!(s.tool_calls[0].model.as_deref(), Some("gpt-6-sol"));
        assert_eq!(s.tool_calls[6].input_summary.as_deref(), Some("rust lark"));
        let file = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        let a = file("/work/repo/src/a.rs");
        assert_eq!((a.lines_added, a.lines_removed), (2, 1));
        assert!(file("/work/repo/b.rs").created);
        // here a deleted file's lines are known
        assert_eq!(file("/work/repo/gone.rs").lines_removed, 2);
        // no record per response here: what the running total grew by
        assert_eq!(s.usage.len(), 1);
        assert_eq!(
            (
                s.usage[0].requests,
                s.usage[0].input_tokens,
                s.usage[0].cache_read_tokens,
                s.usage[0].output_tokens
            ),
            (2, 700, 300, 50)
        );
    }

    #[test]
    fn older_ways_of_calling_tools_are_understood() {
        assert_eq!(
            command_line(&json!(["git", "status"])).as_deref(),
            Some("git status")
        );
        let call = |name: &str, input: Value| Call {
            id: "c".into(),
            name: name.into(),
            input,
            at: ts(0),
            turn: None,
            cwd: Some("/w".into()),
            model: None,
            output: None,
        };
        let as_shell = call("shell", json!({ "command": ["apply_patch", PATCH] }));
        assert_eq!(patch_of(&as_shell), Some(PATCH));
        let as_function = call("apply_patch", json!({ "input": PATCH }));
        let edits = patch_edits(patch_of(&as_function).unwrap(), Some("/w"));
        let paths: Vec<&str> = edits.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["/w/b.rs", "/w/src/a.rs", "/w/gone.rs"]);
        let moved = patch_edits(
            "*** Update File: /abs/a.rs\n*** Move to: b.rs\n@@\n-x\n+y\n",
            Some("/w"),
        );
        assert_eq!(moved[0].path, "/w/b.rs");
        assert_eq!(moved[0].lines, ["-x", "+y"]);

        let patch = call("apply_patch", json!(PATCH));
        assert!(matches!(
            outcome(&patch, None, "patch does not apply", true).0,
            Outcome::Failed(_)
        ));
        let shell = call("exec_command", json!({ "cmd": "sleep 9" }));
        let cut = "Wall time: 2.0 seconds\naborted by user";
        assert!(matches!(
            outcome(&shell, None, cut, false),
            (Outcome::Interrupted, Some(2000))
        ));
        // still running when the call returned: not a failure
        let running = "Wall time: 1.0 seconds\nProcess running with session ID 4\nOutput:\n";
        assert!(matches!(
            outcome(&shell, None, running, false).0,
            Outcome::Ok
        ));
    }

    #[test]
    fn an_empty_rollout_imports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join(format!("rollout-2026-11-16T12-00-00-{MAIN}.jsonl"));
        write(&path, &[meta(MAIN, json!({}))]);
        let (events, facts) = session(&path, &[], None).unwrap();
        assert!(events.is_empty() && facts.is_none());
        assert_eq!(thread_id(Path::new("notes.jsonl")), None);
        assert_eq!(
            thread_id(Path::new("rollout-2026-11-16T12-00-00-abc_def.jsonl")).as_deref(),
            Some("abc")
        );
    }
}
