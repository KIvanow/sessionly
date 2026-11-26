//! Import sessions of OpenCode from its SQLite database.
//!
//! OpenCode keeps every project in one file: `$OPENCODE_DB`, or
//! `$XDG_DATA_HOME/opencode/opencode.db`, or `~/.local/share/opencode/opencode.db`.
//! The session is the `message` and `part` rows. A plugin only tells Sessionly
//! that a session happened; it is not the record.
//!
//! The file is opened read-only. Running the `opencode` command to find it
//! would migrate the database, so the path is resolved here instead.
//!
//! Written from the database OpenCode 1.19.6 writes. A session that has rows
//! in `session_message` and none in `message` is a newer layout this importer
//! does not read: it fails that session rather than reporting it empty.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use crate::import::{patch_lines, slim_input, Builder};
use crate::paths::OPENCODE;
use crate::session::{Cost, CostSource, ModelUsage};
use crate::transcript::{Facts, SubagentFacts};

/// Agents OpenCode runs for itself. They are not sessions a person started.
const INTERNAL: &[&str] = &["title", "summary", "compaction"];

/// Open the database without writing to it. `query_only` refuses a write
/// even if the file itself were writable. A short wait covers a session that
/// is being saved as the import reads.
pub(crate) fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

fn internal(agent: Option<&str>) -> bool {
    agent.is_some_and(|agent| INTERNAL.contains(&agent))
}

fn not_internal_sql() -> String {
    let list = INTERNAL
        .iter()
        .map(|agent| format!("'{agent}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("COALESCE(agent, '') NOT IN ({list})")
}

/// Session ids that stand on their own: no parent Sessionly imports, which
/// includes a session whose parent row is gone and one parented on an
/// internal agent.
pub(crate) fn root_ids(path: &Path) -> Result<Vec<String>> {
    let conn = open(path)?;
    let sql = format!(
        "SELECT id FROM session WHERE {keep}
           AND (
             parent_id IS NULL OR parent_id = ''
             OR NOT EXISTS (
               SELECT 1 FROM session AS parent
               WHERE parent.id = session.parent_id AND {parent_keep}
             )
           )
         ORDER BY time_created, id",
        keep = not_internal_sql(),
        parent_keep = not_internal_sql().replace("agent", "parent.agent"),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("listing OpenCode sessions")
}

/// This session and the child sessions folded into it, root first.
fn family(conn: &Connection, root: &str) -> Result<Vec<String>> {
    let mut ids = vec![root.to_string()];
    let sql = format!(
        "SELECT id FROM session
         WHERE parent_id = ?1 AND id != ?1 AND {keep}
         ORDER BY time_created, id",
        keep = not_internal_sql(),
    );
    let mut i = 0;
    while i < ids.len() {
        let mut stmt = conn.prepare(&sql)?;
        let parent = ids[i].clone();
        let kids = stmt
            .query_map(params![parent], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for kid in kids {
            if !ids.contains(&kid) {
                ids.push(kid);
            }
        }
        i += 1;
    }
    Ok(ids)
}

/// The root of the repository the session's project is: the folder git
/// writes the paths of a diff from. `None` for a project that is not one
/// (OpenCode's worktree is then `/`), or a database without projects.
fn worktree(conn: &Connection, id: &str) -> Result<Option<String>> {
    if !table_exists(conn, "project")? || !column_exists(conn, "session", "project_id")? {
        return Ok(None);
    }
    let found: Option<String> = conn
        .query_row(
            "SELECT project.worktree FROM session
             JOIN project ON project.id = session.project_id
             WHERE session.id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(found.filter(|dir| !dir.is_empty() && dir != "/"))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// Fail when a newer OpenCode has moved the conversation out of `message`.
fn guard_layout(conn: &Connection, ids: &[String]) -> Result<()> {
    if !table_exists(conn, "session_message")? {
        return Ok(());
    }
    for id in ids {
        let (moved, messages): (i64, i64) = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM session_message WHERE session_id = ?1),
               (SELECT COUNT(*) FROM message WHERE session_id = ?1)",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if moved > 0 && messages == 0 {
            bail!(
                "OpenCode session {id} is stored in session_message and not in message; \
                 this version of Sessionly reads message and part"
            );
        }
    }
    Ok(())
}

fn mix(mut hash: u64, bytes: impl AsRef<[u8]>) -> u64 {
    for byte in bytes.as_ref() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// A stamp of the session and the children folded into it: each one's update
/// time, and for its messages and parts how many there are, their latest
/// update time and the length of what they hold. OpenCode writes a turn's
/// diffs into the user message after it updates the session, so the rows
/// themselves have to be looked at. The database is one file for every
/// session, so its size cannot say which session changed. The stamp fits in
/// a signed 64-bit number, which is what the ledger keeps.
fn stamp(conn: &Connection, root: &str) -> Result<u64> {
    let present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session WHERE id = ?1",
        params![root],
        |row| row.get(0),
    )?;
    if present == 0 {
        return Ok(0);
    }
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for id in family(conn, root)? {
        let updated: i64 = conn
            .query_row(
                "SELECT COALESCE(time_updated, 0) FROM session WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        hash = mix(hash, id.as_bytes());
        hash = mix(hash, updated.to_le_bytes());
        for table in ["message", "part"] {
            for value in rows_stamp(conn, table, &id)? {
                hash = mix(hash, value.to_le_bytes());
            }
        }
    }
    let hash = hash & i64::MAX as u64;
    Ok(if hash == 0 { 1 } else { hash })
}

/// How many rows of `table` the session has, the latest time one was updated
/// and the length of their data.
fn rows_stamp(conn: &Connection, table: &str, id: &str) -> Result<[i64; 3]> {
    let updated = if column_exists(conn, table, "time_updated")? {
        "MAX(time_updated)"
    } else {
        "0"
    };
    let sql = format!(
        "SELECT COUNT(*), COALESCE({updated}, 0), COALESCE(SUM(LENGTH(data)), 0)
         FROM {table} WHERE session_id = ?1"
    );
    Ok(conn.query_row(&sql, params![id], |row| {
        Ok([row.get(0)?, row.get(1)?, row.get(2)?])
    })?)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// The stamp `import` compares so a changed session is read again.
pub(crate) fn session_bytes(path: &Path, id: &str) -> u64 {
    open(path).and_then(|conn| stamp(&conn, id)).unwrap_or(0)
}

/// True when a child session has a capture marker. The parent is then due to
/// be imported even if nothing has marked the parent itself.
pub(crate) fn descendant_captured(db: &Path, root: &str, data_dir: &Path) -> bool {
    let Ok(conn) = open(db) else {
        return false;
    };
    let Ok(ids) = family(&conn, root) else {
        return false;
    };
    ids.iter().skip(1).any(|id| {
        let stem = crate::capture::file_stem(Some(id));
        data_dir
            .join("raw")
            .join(OPENCODE)
            .join(format!("{stem}.jsonl"))
            .is_file()
    })
}

fn time_of(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn at(ms: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(ms)
}

fn number(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
        .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
        .unwrap_or(0)
}

fn model_name(provider: &str, id: &str) -> String {
    match (provider.is_empty(), id.is_empty()) {
        (false, false) => format!("{provider}/{id}"),
        (true, false) => id.to_string(),
        (false, true) => provider.to_string(),
        (true, true) => "unknown".to_string(),
    }
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(words) => words
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

struct Meta {
    directory: String,
    title: Option<String>,
    version: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    time_created: i64,
    revert: Value,
}

fn optional_text(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn load_meta(conn: &Connection, id: &str) -> Result<Meta> {
    conn.query_row(
        "SELECT directory, title, version, agent, model, time_created, revert
         FROM session WHERE id = ?1",
        params![id],
        |row| {
            let model: Option<String> = row.get(4)?;
            let parsed: Value = model
                .as_deref()
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or(Value::Null);
            let named = match (parsed["providerID"].as_str(), parsed["id"].as_str()) {
                (None, None) => None,
                (provider, id) => Some(model_name(provider.unwrap_or(""), id.unwrap_or(""))),
            };
            let revert: Option<String> = row.get(6)?;
            Ok(Meta {
                directory: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                title: optional_text(row.get(1)?),
                version: optional_text(row.get(2)?),
                agent: optional_text(row.get(3)?),
                model: named.filter(|name| name != "unknown"),
                time_created: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                revert: revert
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or(Value::Null),
            })
        },
    )
    .with_context(|| format!("reading OpenCode session {id}"))
}

struct Msg {
    id: String,
    at: i64,
    data: Value,
    parts: Vec<Part>,
}

struct Part {
    id: String,
    at: i64,
    data: Value,
}

fn parse_json(raw: &str, what: &str) -> Result<Value> {
    serde_json::from_str(raw).with_context(|| format!("{what} is not json"))
}

fn load_messages(conn: &Connection, id: &str, revert: &Value) -> Result<Vec<Msg>> {
    let mut stmt = conn.prepare(
        "SELECT id, time_created, data FROM message
         WHERE session_id = ?1 ORDER BY time_created, id",
    )?;
    let mut messages = stmt
        .query_map(params![id], |row| {
            let mid: String = row.get(0)?;
            let raw: String = row.get(2)?;
            Ok((mid, row.get::<_, i64>(1)?, raw))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, message_id, time_created, data FROM part
         WHERE session_id = ?1 ORDER BY time_created, id",
    )?;
    let part_rows = stmt
        .query_map(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut by_message: HashMap<String, Vec<Part>> = HashMap::new();
    for (pid, message_id, at, raw) in part_rows {
        let data = parse_json(&raw, &format!("part {pid}"))?;
        by_message
            .entry(message_id)
            .or_default()
            .push(Part { id: pid, at, data });
    }

    let mut loaded = Vec::new();
    for (mid, at, raw) in messages.drain(..) {
        let data = parse_json(&raw, &format!("message {mid}"))?;
        let parts = by_message.remove(&mid).unwrap_or_default();
        loaded.push(Msg {
            id: mid,
            at,
            data,
            parts,
        });
    }
    apply_revert(&mut loaded, revert);
    Ok(loaded)
}

/// Leave out what going back undid. OpenCode deletes it at the next prompt;
/// until then the rows are still there. Without a part, the message named
/// and every later one are undone. With one, the message keeps its parts
/// before that part, and the later messages are undone.
fn apply_revert(loaded: &mut Vec<Msg>, revert: &Value) {
    let text = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|key| revert[*key].as_str())
            .filter(|id| !id.is_empty())
    };
    let Some(message_id) = text(["messageID", "messageId"]) else {
        return;
    };
    let Some(index) = loaded.iter().position(|msg| msg.id == message_id) else {
        return;
    };
    match text(["partID", "partId"]) {
        Some(part_id) => {
            loaded.truncate(index + 1);
            let parts = &mut loaded[index].parts;
            if let Some(cut) = parts.iter().position(|part| part.id == part_id) {
                parts.truncate(cut);
            }
        }
        None => loaded.truncate(index),
    }
}

/// `+` and `-` lines of a unified diff. File headers (`+++`, `---`) are not
/// changes.
fn patch_body(patch: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut hunk = false;
    let mut saw_hunk = false;
    for line in patch.lines() {
        if line.starts_with("@@") {
            hunk = true;
            saw_hunk = true;
            continue;
        }
        if line.starts_with("diff ") || line.starts_with("Index:") {
            hunk = false;
            continue;
        }
        if hunk && (line.starts_with('+') || line.starts_with('-')) {
            lines.push(line.to_string());
        }
    }
    if saw_hunk {
        return lines;
    }
    patch
        .lines()
        .filter(|line| {
            (line.starts_with('+') || line.starts_with('-'))
                && !line.starts_with("+++")
                && !line.starts_with("---")
        })
        .map(str::to_string)
        .collect()
}

struct Diff {
    /// The file, absolute.
    file: String,
    /// The file as OpenCode wrote it: relative to the repository's root.
    written: String,
    lines: Vec<String>,
    created: bool,
}

fn absolute(path: &str, cwd: &str) -> String {
    let path_buf = Path::new(path);
    if path_buf.is_absolute() || cwd.is_empty() {
        path.to_string()
    } else {
        Path::new(cwd).join(path_buf).to_string_lossy().into_owned()
    }
}

fn same_file(tool_path: &str, diff_file: &str, cwd: &str) -> bool {
    absolute(tool_path, cwd) == absolute(diff_file, cwd)
}

/// The tool path ends with the diff's path as OpenCode wrote it: for a
/// database that does not say where the repository's root is.
fn ends_with_file(tool_path: &str, diff_file: &str, cwd: &str) -> bool {
    let rel = diff_file.trim_start_matches("./");
    !rel.is_empty() && absolute(tool_path, cwd).ends_with(&format!("/{rel}"))
}

/// Which diffs each call made. A path a tool was given takes one diff: the
/// one at that path, or else the one whose path it ends with, when no other
/// path left over ends with it too. A diff nothing takes is left over.
fn claim_diffs(calls: &[Call], diffs: &[Diff], cwd: &str) -> Vec<Vec<usize>> {
    let mut owned: Vec<Vec<usize>> = vec![Vec::new(); calls.len()];
    let mut paths: Vec<(usize, String)> = Vec::new();
    for (index, call) in calls.iter().enumerate() {
        if call.status != CallStatus::Ok || !is_file_tool(&call.name) {
            continue;
        }
        // The input and the metadata may name the same file twice.
        let mut seen = HashSet::new();
        for path in paths_of(call) {
            if seen.insert(absolute(&path, cwd)) {
                paths.push((index, path));
            }
        }
    }
    let mut free = vec![true; paths.len()];
    let mut claimed = vec![false; diffs.len()];
    for (diff_index, diff) in diffs.iter().enumerate() {
        if let Some(slot) =
            (0..paths.len()).find(|&slot| free[slot] && same_file(&paths[slot].1, &diff.file, cwd))
        {
            free[slot] = false;
            claimed[diff_index] = true;
            owned[paths[slot].0].push(diff_index);
        }
    }
    for (diff_index, diff) in diffs.iter().enumerate() {
        if claimed[diff_index] {
            continue;
        }
        let fits: Vec<usize> = (0..paths.len())
            .filter(|&slot| free[slot] && ends_with_file(&paths[slot].1, &diff.written, cwd))
            .collect();
        if let [slot] = fits[..] {
            free[slot] = false;
            owned[paths[slot].0].push(diff_index);
        }
    }
    for list in &mut owned {
        list.sort_unstable();
    }
    owned
}

/// The turn's diffs. Git wrote each path relative to `root`, the root of the
/// repository, which is not the session's folder when OpenCode was started
/// in one below it.
fn diffs_of(data: &Value, root: &str) -> Vec<Diff> {
    let Some(rows) = data["summary"]["diffs"].as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let written = row["file"].as_str()?.to_string();
            let file = absolute(&written, root);
            let mut lines = row["patch"].as_str().map(patch_body).unwrap_or_default();
            let before = row["before"].as_str().unwrap_or("");
            let after = row["after"].as_str().unwrap_or("");
            if lines.is_empty() && (!before.is_empty() || !after.is_empty()) {
                lines = patch_lines(before, after);
            }
            let status = row["status"].as_str().unwrap_or("");
            let created = status.eq_ignore_ascii_case("added")
                || (status.is_empty() && before.is_empty() && !after.is_empty());
            Some(Diff {
                file,
                written,
                lines,
                created,
            })
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum CallStatus {
    Ok,
    Failed,
    Open,
}

struct Call {
    id: String,
    name: String,
    input: Value,
    metadata: Value,
    status: CallStatus,
    error: Option<String>,
    start: i64,
    end: Option<i64>,
    output_bytes: u64,
}

fn calls_of(msg: &Msg) -> Vec<Call> {
    let mut calls = Vec::new();
    for part in &msg.parts {
        if part.data["type"] != "tool" {
            continue;
        }
        let state = &part.data["state"];
        let status = match state["status"].as_str() {
            Some("completed") => CallStatus::Ok,
            Some("error" | "failed") => CallStatus::Failed,
            _ => CallStatus::Open,
        };
        let id = part.data["callID"]
            .as_str()
            .filter(|id| !id.is_empty())
            .unwrap_or(part.id.as_str())
            .to_string();
        let output_bytes = match &state["output"] {
            Value::Null => 0,
            Value::String(text) => text.len() as u64,
            other => other.to_string().len() as u64,
        };
        let error = match &state["error"] {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            other => Some(other.to_string()),
        };
        calls.push(Call {
            id,
            name: part.data["tool"].as_str().unwrap_or("tool").to_string(),
            input: state["input"].clone(),
            metadata: state["metadata"].clone(),
            status,
            error,
            start: state["time"]["start"].as_i64().unwrap_or(part.at),
            end: state["time"]["end"].as_i64(),
            output_bytes,
        });
    }
    calls
}

fn is_file_tool(name: &str) -> bool {
    matches!(name, "write" | "edit" | "apply_patch" | "patch")
}

fn is_shell(name: &str) -> bool {
    matches!(name, "bash" | "shell")
}

/// The files a call wrote. `write` and `edit` are given one (`filePath`), and
/// say it again in what they return: `write` as `filepath`, `edit` in its
/// `filediff`. `apply_patch` is given the patch's text, and returns each file
/// it touched under `files`, at the path it moved to as well.
fn paths_of(call: &Call) -> Vec<String> {
    let mut paths = Vec::new();
    let mut add = |path: Option<&str>| {
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            paths.push(path.to_string());
        }
    };
    for key in ["filePath", "file_path", "path", "filepath"] {
        add(call.input[key].as_str());
    }
    add(call.metadata["filepath"].as_str());
    add(call.metadata["filediff"]["file"].as_str());
    for file in call.metadata["files"].as_array().into_iter().flatten() {
        add(file["filePath"].as_str());
        add(file["movePath"].as_str());
    }
    paths
}

/// What the person typed. OpenCode marks the text it wrote itself `synthetic`:
/// a file read for an `@` mention and its contents, the message that carries
/// on after a compaction or a command. `ignored` text is not shown to the
/// model. A command run as a subtask (`/review`) keeps only its template,
/// so its name stands for it.
fn prompt_text(parts: &[Part]) -> String {
    let mut lines = Vec::new();
    for part in parts {
        let flag = |key: &str| part.data[key].as_bool() == Some(true);
        match part.data["type"].as_str() {
            Some("text") if flag("synthetic") || flag("ignored") => {}
            Some("text") => {
                if let Some(text) = part.data["text"].as_str().filter(|t| !t.is_empty()) {
                    lines.push(text.to_string());
                }
            }
            Some("subtask") => {
                if let Some(command) = part.data["command"].as_str().filter(|c| !c.is_empty()) {
                    lines.push(format!("/{command}"));
                }
            }
            Some("file") => {
                let name = part.data["filename"].as_str().unwrap_or("attachment");
                let mime = part.data["mime"]
                    .as_str()
                    .unwrap_or("application/octet-stream");
                lines.push(format!("Attached: {name} ({mime})"));
            }
            _ => {}
        }
    }
    lines.join("\n")
}

fn field(input: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .find_map(|key| input.get(*key).filter(|v| !v.is_null()).cloned())
        .unwrap_or(Value::Null)
}

/// OpenCode's tool and its input under the names used for the other agents.
fn canonical(call: &Call, cwd: &str) -> (String, Value) {
    let input = &call.input;
    let path = |keys: &[&str]| {
        field(input, keys)
            .as_str()
            .map(|path| absolute(path, cwd))
            .map(|path| json!(path))
            .unwrap_or(Value::Null)
    };
    match call.name.as_str() {
        "read" => (
            "Read".into(),
            json!({ "file_path": path(&["filePath", "file_path", "path"]) }),
        ),
        "edit" => (
            "Edit".into(),
            slim_input(&json!({
                "file_path": path(&["filePath", "file_path"]),
                "old_string": field(input, &["oldString", "old_string"]),
                "new_string": field(input, &["newString", "new_string"]),
            })),
        ),
        "write" => (
            "Write".into(),
            slim_input(&json!({
                "file_path": path(&["filePath", "file_path"]),
                "content": field(input, &["content"]),
            })),
        ),
        "bash" | "shell" => (
            "Bash".into(),
            slim_input(&json!({
                "command": text_of(&input["command"]),
                "workdir": field(input, &["workdir"]),
            })),
        ),
        "grep" => (
            "Grep".into(),
            json!({ "pattern": field(input, &["pattern"]), "path": field(input, &["path"]) }),
        ),
        "glob" => (
            "Glob".into(),
            json!({
                "pattern": field(input, &["pattern", "query"]),
                "path": field(input, &["path"]),
            }),
        ),
        "webfetch" => ("WebFetch".into(), json!({ "url": field(input, &["url"]) })),
        "websearch" => (
            "WebSearch".into(),
            json!({ "query": field(input, &["query"]) }),
        ),
        "task" | "subagent" => (
            "Agent".into(),
            slim_input(&json!({
                "description": field(input, &["description"]),
                "prompt": field(input, &["prompt"]),
                "subagent_type": field(input, &["subagent_type", "agent_type"]),
            })),
        ),
        "todowrite" => ("TodoWrite".into(), slim_input(input)),
        "skill" => (
            "Skill".into(),
            json!({ "skill": field(input, &["name", "skill"]) }),
        ),
        other => (other.to_string(), slim_input(input)),
    }
}

fn file_tool_name(opencode: &str, created: bool) -> &'static str {
    match opencode {
        "edit" => "Edit",
        "write" => "Write",
        _ if created => "Write",
        _ => "Edit",
    }
}

struct Tokens {
    input: u64,
    output: u64,
    reasoning: u64,
    cache_read: u64,
    cache_write: u64,
    cost: f64,
}

fn tokens_of(data: &Value) -> Tokens {
    let tokens = &data["tokens"];
    Tokens {
        input: number(&tokens["input"]),
        output: number(&tokens["output"]),
        reasoning: number(&tokens["reasoning"]),
        cache_read: number(&tokens["cache"]["read"]),
        cache_write: number(&tokens["cache"]["write"]),
        cost: data["cost"].as_f64().unwrap_or(0.0),
    }
}

fn any_tokens(tokens: &Tokens) -> bool {
    tokens.input + tokens.output + tokens.reasoning + tokens.cache_read + tokens.cache_write > 0
}

/// Dollars OpenCode recorded, and dollars filled in where it recorded none.
#[derive(Default)]
struct Acc {
    recorded: u64,
    estimated: u64,
    unpriced: u64,
    recorded_usd: f64,
    estimated_usd: f64,
}

impl Acc {
    fn cost(&self) -> Option<Cost> {
        if self.recorded == 0 && self.estimated == 0 {
            return None;
        }
        if self.estimated == 0 && self.unpriced == 0 {
            return Some(Cost {
                total_usd: self.recorded_usd,
                source: CostSource::Recorded,
                transcript_estimate_usd: self.recorded_usd,
                unpriced_requests: 0,
                untracked_usd: None,
                prompts_covered: None,
                by_branch: Vec::new(),
            });
        }
        Some(Cost::estimate(
            self.recorded_usd + self.estimated_usd,
            self.unpriced,
        ))
    }
}

struct Charge {
    input: u64,
    /// Output plus reasoning: OpenCode counts reasoning apart from output.
    output: u64,
    usd: Option<f64>,
}

fn model_slot<'a>(usage: &'a mut Vec<ModelUsage>, model: &str) -> &'a mut ModelUsage {
    let index = usage
        .iter()
        .position(|entry| entry.model == model)
        .unwrap_or_else(|| {
            usage.push(ModelUsage {
                model: model.to_string(),
                ..Default::default()
            });
            usage.len() - 1
        });
    &mut usage[index]
}

fn add_dollars(entry: &mut ModelUsage, usd: f64) {
    entry.estimated_cost_usd = Some(entry.estimated_cost_usd.unwrap_or(0.0) + usd);
}

/// One assistant message. A non-zero `cost` is OpenCode's figure. Tokens with
/// a cost of 0 are priced here; a model with no price keeps the tokens only.
fn add_request(usage: &mut Vec<ModelUsage>, acc: &mut Acc, model: &str, tokens: &Tokens) -> Charge {
    let output = tokens.output + tokens.reasoning;
    let entry = model_slot(usage, model);
    entry.requests += 1;
    entry.input_tokens += tokens.input;
    entry.output_tokens += output;
    entry.thinking_tokens += tokens.reasoning;
    entry.cache_read_tokens += tokens.cache_read;
    entry.cache_write_5m_tokens += tokens.cache_write;

    let usd = if tokens.cost > 0.0 {
        acc.recorded += 1;
        acc.recorded_usd += tokens.cost;
        add_dollars(entry, tokens.cost);
        Some(tokens.cost)
    } else if any_tokens(tokens) {
        // The prompt's size, which picks a long prompt's price, counts cached
        // input too: OpenCode's `input` leaves it out.
        let prompt = tokens.input + tokens.cache_read + tokens.cache_write;
        let priced = crate::pricing::price_for(model, prompt).map(|price| {
            price.cost(&crate::pricing::Billed {
                input: tokens.input,
                output,
                cache_read: tokens.cache_read,
                cache_write_short: tokens.cache_write,
                cache_write_long: 0,
            })
        });
        match priced {
            Some(usd) => {
                acc.estimated += 1;
                acc.estimated_usd += usd;
                add_dollars(entry, usd);
                Some(usd)
            }
            None => {
                acc.unpriced += 1;
                None
            }
        }
    } else {
        None
    };
    Charge {
        input: tokens.input,
        output,
        usd,
    }
}

/// The requests one reply made to the model: one per step, each of which
/// OpenCode closes with a `step-finish` part of its tokens and cost. The
/// message's own `tokens` are its last step's only, while its `cost` is the
/// sum; a reply with no step parts is taken as one request.
fn requests_of(reply: &Msg) -> Vec<Tokens> {
    let steps: Vec<Tokens> = reply
        .parts
        .iter()
        .filter(|part| part.data["type"] == "step-finish")
        .map(|part| tokens_of(&part.data))
        .collect();
    if steps.is_empty() {
        vec![tokens_of(&reply.data)]
    } else {
        steps
    }
}

/// Add a reply's requests to the session's usage and cost, and to the
/// child session's when it is one.
fn charge_reply(
    usage: &mut Vec<ModelUsage>,
    acc: &mut Acc,
    mut child: Option<&mut SubagentFacts>,
    model: Option<&str>,
    reply: &Msg,
) {
    for tokens in requests_of(reply) {
        let charge = add_request(usage, acc, model.unwrap_or("unknown"), &tokens);
        if let Some(child) = child.as_deref_mut() {
            child.requests += 1;
            child.input_tokens += charge.input;
            child.output_tokens += charge.output;
            if let Some(usd) = charge.usd {
                child.estimated_cost_usd = Some(child.estimated_cost_usd.unwrap_or(0.0) + usd);
            }
        }
    }
}

fn assistant_model(data: &Value) -> Option<String> {
    let id = data["modelID"].as_str().unwrap_or("");
    let provider = data["providerID"].as_str().unwrap_or("");
    if id.is_empty() && provider.is_empty() {
        None
    } else {
        Some(model_name(provider, id))
    }
}

fn parent_of(data: &Value) -> String {
    data["parentID"]
        .as_str()
        .or(data["parentId"].as_str())
        .unwrap_or("")
        .to_string()
}

#[derive(Clone, Copy)]
struct Scope<'a> {
    prompt_id: &'a str,
    /// When the message the calls answer was written.
    prompt_at: i64,
    agent: Option<(&'a str, &'a str)>,
    model: Option<&'a str>,
}

struct ToolEvent {
    id: String,
    tool: String,
    input: Value,
    response: Option<Value>,
    changes: Option<Value>,
}

fn push_event(out: &mut Builder, call: &Call, event: ToolEvent, scope: &Scope) {
    let mut base = json!({
        "prompt_id": scope.prompt_id,
        "tool_use_id": event.id,
        "tool_name": event.tool,
        "tool_input": event.input,
    });
    if let Some((agent_id, agent_type)) = scope.agent {
        base["agent_id"] = json!(agent_id);
        base["agent_type"] = json!(agent_type);
    }
    if let Some(model) = scope.model {
        base["model"] = json!(model);
    }
    out.push(&time_of(call.start), "PreToolUse", base.clone());
    if call.status == CallStatus::Open {
        return;
    }
    let end = call.end.unwrap_or(call.start);
    if let Some(ms) = call.end.map(|end| (end - call.start).max(0) as u64) {
        base["duration_ms"] = json!(ms);
    }
    let hook = if call.status == CallStatus::Failed {
        base["error"] = json!(call.error.clone().unwrap_or_else(|| "failed".to_string()));
        "PostToolUseFailure"
    } else {
        base["tool_response"] = event
            .response
            .unwrap_or(json!({ "_bytes": call.output_bytes }));
        "PostToolUse"
    };
    out.push(&time_of(end), hook, base);
    if let Some(changes) = event.changes {
        out.note("changes", changes);
    }
}

fn patch_result(diff: &Diff, output_bytes: u64) -> Value {
    let bytes = if output_bytes > 0 {
        output_bytes
    } else {
        diff.lines.iter().map(String::len).sum::<usize>() as u64
    };
    let mut result = json!({
        "structuredPatch": [{ "lines": diff.lines }],
        "_bytes": bytes,
    });
    if diff.created {
        result["type"] = json!("create");
    }
    result
}

fn change_of(diff: &Diff, cwd: &str) -> Value {
    json!({
        "path": absolute(&diff.file, cwd),
        "status": if diff.created { "A" } else { "M" },
        "lines": diff.lines,
    })
}

fn emit_calls(
    out: &mut Builder,
    calls: &[Call],
    models: &[Option<String>],
    diffs: &[Diff],
    cwd: &str,
    scope: &Scope,
) {
    let owned = claim_diffs(calls, diffs, cwd);
    let mut claimed = vec![false; diffs.len()];
    for diff_index in owned.iter().flatten() {
        claimed[*diff_index] = true;
    }
    let leftovers: Vec<usize> = claimed
        .iter()
        .enumerate()
        .filter(|(_, taken)| !**taken)
        .map(|(index, _)| index)
        .collect();
    let bash_at = calls
        .iter()
        .rposition(|call| is_shell(&call.name) && call.status != CallStatus::Open);

    for (index, call) in calls.iter().enumerate() {
        let model = models.get(index).and_then(Option::as_deref);
        let scoped = Scope { model, ..*scope };
        if call.status == CallStatus::Ok && !owned[index].is_empty() {
            let many = owned[index].len() > 1;
            for (nth, diff_index) in owned[index].iter().enumerate() {
                let diff = &diffs[*diff_index];
                let id = if many {
                    format!("{}:{nth}", call.id)
                } else {
                    call.id.clone()
                };
                let id = scoped_id(&id, scope.agent);
                push_event(
                    out,
                    call,
                    ToolEvent {
                        id,
                        tool: file_tool_name(&call.name, diff.created).to_string(),
                        input: json!({ "file_path": absolute(&diff.file, cwd) }),
                        response: Some(patch_result(diff, call.output_bytes)),
                        changes: None,
                    },
                    &scoped,
                );
            }
            continue;
        }
        let (tool, input) = canonical(call, cwd);
        let changes = (Some(index) == bash_at && !leftovers.is_empty()).then(|| {
            leftovers
                .iter()
                .map(|diff_index| change_of(&diffs[*diff_index], cwd))
                .collect::<Vec<_>>()
        });
        push_event(
            out,
            call,
            ToolEvent {
                id: scoped_id(&call.id, scope.agent),
                tool,
                input,
                response: Some(json!({ "_bytes": call.output_bytes })),
                changes: changes.map(Value::Array),
            },
            &scoped,
        );
    }
    if bash_at.is_some() {
        return;
    }
    let start = calls.first().map_or(scope.prompt_at, |call| call.start);
    for (nth, diff_index) in leftovers.into_iter().enumerate() {
        let diff = &diffs[diff_index];
        let tool = if diff.created { "Write" } else { "Edit" };
        let id = scoped_id(&format!("diff:{}:{nth}", scope.prompt_id), scope.agent);
        let call = Call {
            id: id.clone(),
            name: tool.to_string(),
            input: Value::Null,
            metadata: Value::Null,
            status: CallStatus::Ok,
            error: None,
            start,
            end: Some(start),
            output_bytes: 0,
        };
        push_event(
            out,
            &call,
            ToolEvent {
                id,
                tool: tool.to_string(),
                input: json!({ "file_path": absolute(&diff.file, cwd) }),
                response: Some(patch_result(diff, 0)),
                changes: None,
            },
            scope,
        );
    }
}

fn scoped_id(id: &str, agent: Option<(&str, &str)>) -> String {
    match agent {
        Some((agent_id, _)) => format!("{agent_id}:{id}"),
        None => id.to_string(),
    }
}

struct TurnOut {
    last_ms: i64,
    model: Option<String>,
}

fn note_compactions(out: &mut Builder, messages: &[Msg]) {
    for msg in messages {
        for part in &msg.parts {
            if part.data["type"] == "compaction" {
                out.push(&time_of(part.at), "PostCompact", json!({}));
            }
        }
    }
}

fn child_descriptions(messages: &[Msg]) -> HashMap<String, String> {
    let mut found = HashMap::new();
    for msg in messages {
        for part in &msg.parts {
            if part.data["type"] != "tool" {
                continue;
            }
            let tool = part.data["tool"].as_str().unwrap_or("");
            if tool != "task" && tool != "subagent" {
                continue;
            }
            let Some(session_id) = part.data["state"]["metadata"]["sessionId"].as_str() else {
                continue;
            };
            if let Some(description) = part.data["state"]["input"]["description"].as_str() {
                found.insert(session_id.to_string(), description.to_string());
            }
        }
    }
    found
}

/// Prompts, tools and tokens of one OpenCode session. Child sessions are not
/// prompts of the parent: the caller emits them as subagents.
fn emit_session(
    out: &mut Builder,
    messages: &[Msg],
    (cwd, root): (&str, &str),
    agent: Option<(&str, &str)>,
    usage: &mut Vec<ModelUsage>,
    acc: &mut Acc,
    mut child: Option<&mut SubagentFacts>,
) -> TurnOut {
    let mut users = Vec::new();
    let mut assistants: HashMap<String, Vec<&Msg>> = HashMap::new();
    let mut last_ms = 0;
    let mut model = None;
    for msg in messages {
        last_ms = last_ms.max(msg.at);
        match msg.data["role"].as_str() {
            Some("user") => users.push(msg),
            Some("assistant") => {
                assistants
                    .entry(parent_of(&msg.data))
                    .or_default()
                    .push(msg);
            }
            _ => {}
        }
    }
    let user_ids: HashSet<String> = users.iter().map(|msg| msg.id.clone()).collect();
    for user in &users {
        let text = prompt_text(&user.parts);
        // A child's user message is the task it was given, not a prompt the
        // person typed.
        if agent.is_none() && !text.is_empty() {
            out.push(
                &time_of(user.at),
                "UserPromptSubmit",
                json!({ "prompt_id": user.id, "prompt": text }),
            );
        }
        let mut calls = Vec::new();
        let mut models = Vec::new();
        let mut stop_at = user.at;
        if let Some(replies) = assistants.get(user.id.as_str()) {
            for reply in replies {
                let reply_model = assistant_model(&reply.data);
                if model.is_none() {
                    model = reply_model.clone();
                }
                charge_reply(
                    usage,
                    acc,
                    child.as_deref_mut(),
                    reply_model.as_deref(),
                    reply,
                );
                stop_at = stop_at.max(reply.data["time"]["completed"].as_i64().unwrap_or(reply.at));
                last_ms = last_ms.max(stop_at);
                for call in calls_of(reply) {
                    models.push(reply_model.clone());
                    calls.push(call);
                }
            }
        }
        let scope = Scope {
            prompt_id: &user.id,
            prompt_at: user.at,
            agent,
            model: None,
        };
        emit_calls(
            out,
            &calls,
            &models,
            &diffs_of(&user.data, root),
            cwd,
            &scope,
        );
        if agent.is_none() && !text.is_empty() {
            out.push(&time_of(stop_at), "Stop", json!({ "prompt_id": user.id }));
        }
    }
    let mut orphans: Vec<&Msg> = assistants
        .iter()
        .filter(|(parent, _)| !user_ids.contains(*parent))
        .flat_map(|(_, replies)| replies)
        .copied()
        .collect();
    orphans.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    for reply in orphans {
        let reply_model = assistant_model(&reply.data);
        if model.is_none() {
            model = reply_model.clone();
        }
        charge_reply(
            usage,
            acc,
            child.as_deref_mut(),
            reply_model.as_deref(),
            reply,
        );
        let calls = calls_of(reply);
        let models = vec![reply_model; calls.len()];
        let prompt_id = parent_of(&reply.data);
        let prompt_id = if prompt_id.is_empty() {
            reply.id.as_str()
        } else {
            prompt_id.as_str()
        };
        let scope = Scope {
            prompt_id,
            prompt_at: reply.at,
            agent,
            model: None,
        };
        emit_calls(out, &calls, &models, &[], cwd, &scope);
    }
    TurnOut { last_ms, model }
}

/// The session's events and the tokens and cost its messages record.
/// `id` is the parent session; child sessions are folded in.
pub(crate) fn session(db: &Path, id: &str) -> Result<(Vec<Value>, Option<Facts>)> {
    let conn = open(db)?;
    let meta = load_meta(&conn, id)?;
    if internal(meta.agent.as_deref()) {
        return Ok((Vec::new(), None));
    }
    let ids = family(&conn, id)?;
    guard_layout(&conn, &ids)?;
    let messages = load_messages(&conn, id, &meta.revert)?;
    if messages.is_empty() && ids.len() == 1 {
        return Ok((Vec::new(), None));
    }
    let mut out = Builder::new(OPENCODE, id);
    let mut usage = Vec::new();
    let mut acc = Acc::default();
    let cwd = meta.directory.clone();
    let repo_root = worktree(&conn, id)?.unwrap_or_else(|| cwd.clone());
    let dirs = (cwd.as_str(), repo_root.as_str());
    note_compactions(&mut out, &messages);
    let descriptions = child_descriptions(&messages);
    let root = emit_session(&mut out, &messages, dirs, None, &mut usage, &mut acc, None);
    // Not the session's `time_updated`: going back, a permission and other
    // changes that are not work move it too.
    let mut last_ms = root.last_ms.max(meta.time_created);
    let mut session_model = meta.model.clone().or(root.model);
    let mut subagents = Vec::new();

    for child_id in ids.iter().skip(1) {
        let child = load_meta(&conn, child_id)?;
        let child_messages = load_messages(&conn, child_id, &child.revert)?;
        let agent_type = child.agent.clone().unwrap_or_default();
        let identity = json!({ "agent_id": child_id, "agent_type": agent_type });
        let started = if child.time_created > 0 {
            child.time_created
        } else {
            child_messages.first().map(|msg| msg.at).unwrap_or(0)
        };
        out.push(&time_of(started), "SubagentStart", identity.clone());
        note_compactions(&mut out, &child_messages);
        let mut facts = SubagentFacts {
            agent_id: child_id.clone(),
            agent_type: child.agent.clone(),
            description: descriptions.get(child_id).cloned().or(child.title.clone()),
            ..Default::default()
        };
        let turned = emit_session(
            &mut out,
            &child_messages,
            dirs,
            Some((child_id, &agent_type)),
            &mut usage,
            &mut acc,
            Some(&mut facts),
        );
        if session_model.is_none() {
            session_model = turned.model;
        }
        let ended = turned.last_ms.max(started);
        last_ms = last_ms.max(ended);
        out.push(&time_of(ended), "SubagentStop", identity);
        subagents.push(facts);
    }

    let start_ms = if meta.time_created > 0 {
        meta.time_created
    } else {
        messages.first().map(|msg| msg.at).unwrap_or(last_ms)
    };
    let mut start = json!({ "source": "startup" });
    if !cwd.is_empty() {
        start["cwd"] = json!(cwd);
    }
    if let Some(title) = &meta.title {
        start["session_title"] = json!(title);
    }
    if let Some(model) = &session_model {
        start["model"] = json!(model);
    }
    out.push(&time_of(start_ms), "SessionStart", start);

    usage.sort_by(|a, b| b.requests.cmp(&a.requests).then(a.model.cmp(&b.model)));
    let facts = Facts {
        first_at: at(start_ms),
        last_at: at(last_ms),
        version: meta.version,
        // OpenCode does not record whether this was the TUI, `run` or serve,
        // and it does not record the branch that was checked out.
        entrypoint: None,
        git_branch: None,
        cost: acc.cost(),
        usage,
        subagents,
        ..Default::default()
    };
    Ok((out.finish(), Some(facts)))
}

/// The raw capture marker the plugin writes. Existence is all `refresh` needs.
#[cfg(test)]
fn marker(dir: &Path, id: &str) {
    let stem = crate::capture::file_stem(Some(id));
    let folder = dir.join("raw").join(OPENCODE);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join(format!("{stem}.jsonl")), "{}\n").unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;

    const SCHEMA: &str = "
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            directory TEXT,
            title TEXT,
            version TEXT,
            agent TEXT,
            model TEXT,
            cost REAL,
            time_created INTEGER,
            time_updated INTEGER,
            revert TEXT
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            time_created INTEGER,
            data TEXT
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            session_id TEXT,
            time_created INTEGER,
            data TEXT
        );
    ";

    fn fresh() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch(SCHEMA)
            .unwrap();
        (dir, path)
    }

    fn write(path: &Path) -> Connection {
        Connection::open(path).unwrap()
    }

    fn add_session(
        conn: &Connection,
        id: &str,
        parent: Option<&str>,
        agent: &str,
        title: &str,
        at: i64,
        extra: Value,
    ) {
        conn.execute(
            "INSERT INTO session
             (id, parent_id, directory, title, version, agent, model, cost, time_created, time_updated, revert)
             VALUES (?1, ?2, '/work/repo', ?3, '1.19.6', ?4, ?5, 0, ?6, ?6, ?7)",
            params![
                id,
                parent,
                title,
                agent,
                extra.get("model").map(Value::to_string),
                at,
                extra.get("revert").map(Value::to_string),
            ],
        )
        .unwrap();
    }

    fn add_message(conn: &Connection, id: &str, session: &str, at: i64, data: Value) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            params![id, session, at, data.to_string()],
        )
        .unwrap();
    }

    fn add_part(conn: &Connection, id: &str, message: &str, session: &str, at: i64, data: Value) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, message, session, at, data.to_string()],
        )
        .unwrap();
    }

    fn assistant(parent: &str, model: &str, cost: f64, input: u64, output: u64) -> Value {
        let (provider, id) = model.split_once('/').unwrap_or(("", model));
        json!({
            "role": "assistant",
            "parentID": parent,
            "providerID": provider,
            "modelID": id,
            "cost": cost,
            "tokens": { "input": input, "output": output, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
            "time": { "created": 1, "completed": 1 },
        })
    }

    fn tool(name: &str, call: &str, input: Value, status: &str, start: i64) -> Value {
        json!({
            "type": "tool",
            "tool": name,
            "callID": call,
            "state": {
                "status": status,
                "input": input,
                "output": "ok",
                "metadata": {},
                "time": { "start": start, "end": start + 10 }
            }
        })
    }

    fn text_part(text: &str) -> Value {
        json!({ "type": "text", "text": text })
    }

    fn normalized(path: &Path, id: &str) -> crate::session::Session {
        let (events, facts) = session(path, id).unwrap();
        crate::normalize::from_events(&events, facts.as_ref(), OPENCODE).unwrap()
    }

    #[test]
    fn a_write_and_a_shell_edit_keep_their_lines() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        let t0 = 1_763_000_000_000_i64;
        add_session(&conn, "ses_main", None, "build", "say pong", t0, json!({}));
        add_message(
            &conn,
            "msg_user",
            "ses_main",
            t0 + 10,
            json!({
                "role": "user",
                "summary": { "diffs": [
                    {
                        "file": "note.txt",
                        "status": "added",
                        "additions": 1,
                        "deletions": 0,
                        "patch": "Index: note.txt\n--- note.txt\n+++ note.txt\n@@ -0,0 +1 @@\n+pong\n"
                    },
                    {
                        "file": "from-bash.txt",
                        "status": "added",
                        "additions": 1,
                        "deletions": 0,
                        "patch": "Index: from-bash.txt\n--- from-bash.txt\n+++ from-bash.txt\n@@ -0,0 +1 @@\n+from-bash\n"
                    }
                ] }
            }),
        );
        add_part(
            &conn,
            "part_text",
            "msg_user",
            "ses_main",
            t0 + 10,
            text_part("say pong"),
        );
        add_part(
            &conn,
            "part_file",
            "msg_user",
            "ses_main",
            t0 + 11,
            json!({
                "type": "file",
                "filename": "clip.png",
                "mime": "image/png",
                "url": "data:image/png;base64,AAAA"
            }),
        );
        add_message(
            &conn,
            "msg_asst",
            "ses_main",
            t0 + 20,
            json!({
                "role": "assistant",
                "parentID": "msg_user",
                "providerID": "anthropic",
                "modelID": "claude-sonnet-4-5",
                "cost": 0,
                "tokens": { "input": 1000, "output": 20, "reasoning": 4, "cache": { "read": 0, "write": 0 } },
                "time": { "created": t0 + 20, "completed": t0 + 500 }
            }),
        );
        add_part(
            &conn,
            "part_write",
            "msg_asst",
            "ses_main",
            t0 + 30,
            json!({
                "type": "tool",
                "tool": "write",
                "callID": "call_write",
                "state": {
                    "status": "completed",
                    "input": { "filePath": "note.txt", "content": "pong\n" },
                    "output": "wrote",
                    "metadata": { "filepath": "/work/repo/note.txt" },
                    "time": { "start": t0 + 30, "end": t0 + 40 }
                }
            }),
        );
        add_part(
            &conn,
            "part_shell",
            "msg_asst",
            "ses_main",
            t0 + 50,
            tool(
                "shell",
                "call_shell",
                json!({ "command": "printf 'from-bash\\n' > from-bash.txt", "workdir": "/work/repo" }),
                "completed",
                t0 + 50,
            ),
        );
        add_part(
            &conn,
            "part_compact",
            "msg_asst",
            "ses_main",
            t0 + 60,
            json!({ "type": "compaction" }),
        );
        drop(conn);

        let (events, facts) = session(&path, "ses_main").unwrap();
        let write = events
            .iter()
            .find(|event| {
                event["hook"] == "PostToolUse" && event["payload"]["tool_name"] == "Write"
            })
            .unwrap();
        assert_eq!(
            write["payload"]["tool_input"]["file_path"],
            "/work/repo/note.txt"
        );
        assert_eq!(
            write["payload"]["tool_response"]["structuredPatch"][0]["lines"][0],
            "+pong"
        );
        assert_eq!(write["payload"]["tool_response"]["type"], "create");
        let shell = events
            .iter()
            .find(|event| event["hook"] == "PostToolUse" && event["payload"]["tool_name"] == "Bash")
            .unwrap();
        assert_eq!(
            shell["payload"]["tool_input"]["command"],
            "printf 'from-bash\\n' > from-bash.txt"
        );
        assert_eq!(shell["changes"][0]["path"], "/work/repo/from-bash.txt");
        assert_eq!(shell["changes"][0]["status"], "A");
        assert_eq!(shell["changes"][0]["lines"][0], "+from-bash");
        let raw = serde_json::to_string(&events).unwrap();
        assert!(!raw.contains("base64"));

        let s = crate::normalize::from_events(&events, facts.as_ref(), OPENCODE).unwrap();
        assert_eq!(s.prompts.len(), 1);
        assert!(
            s.prompts[0].text.preview.starts_with("say pong"),
            "{}",
            s.prompts[0].text.preview
        );
        assert!(s.prompts[0]
            .text
            .preview
            .contains("Attached: clip.png (image/png)"));
        let prompt = events
            .iter()
            .find(|event| event["hook"] == "UserPromptSubmit")
            .unwrap();
        let prompt = prompt["payload"]["prompt"].as_str().unwrap();
        assert!(prompt.contains("say pong"));
        assert!(prompt.contains("Attached: clip.png (image/png)"));
        assert!(!prompt.contains("base64"));
        assert_eq!(s.counts.lines_added, 2);
        assert_eq!(s.counts.compactions, 1);
        assert_eq!(s.active_ms, 490);
        let note = s
            .files
            .iter()
            .find(|f| f.path.ends_with("note.txt"))
            .unwrap();
        let made = s
            .files
            .iter()
            .find(|f| f.path.ends_with("from-bash.txt"))
            .unwrap();
        assert!(note.created && made.created);
        assert_eq!((note.lines_added, made.lines_added), (1, 1));
        assert_eq!(
            s.tool_calls[1].input_summary.as_deref(),
            Some("printf 'from-bash\\n' > from-bash.txt")
        );
        let cost = s.cost.unwrap();
        assert_eq!(cost.source, CostSource::Estimated);
        let price = crate::pricing::price_for("anthropic/claude-sonnet-4-5", 1000).unwrap();
        let want = price.cost(&crate::pricing::Billed {
            input: 1000,
            output: 24,
            ..Default::default()
        });
        assert!((cost.total_usd - want).abs() < 1e-9);
        assert_eq!(s.usage[0].input_tokens, 1000);
        assert_eq!(s.usage[0].thinking_tokens, 4);
        assert_eq!(s.usage[0].output_tokens, 24);
        assert_eq!(s.agent_version.as_deref(), Some("1.19.6"));
        assert_eq!(s.title.as_deref(), Some("say pong"));
        assert!(s.repo.as_ref().and_then(|r| r.branch.as_ref()).is_none());
        assert_eq!(crate::rewrite::added_lines(&events).len(), 2);
    }

    #[test]
    fn a_recorded_cost_is_kept() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_cost", None, "build", "priced", 10, json!({}));
        add_message(&conn, "u", "ses_cost", 10, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_cost", 10, text_part("go"));
        add_message(
            &conn,
            "a",
            "ses_cost",
            20,
            assistant("u", "anthropic/claude-sonnet-4-5", 1.25, 1000, 20),
        );
        drop(conn);
        let s = normalized(&path, "ses_cost");
        let cost = s.cost.unwrap();
        assert_eq!(cost.source, CostSource::Recorded);
        assert!((cost.total_usd - 1.25).abs() < 1e-9);
    }

    #[test]
    fn an_unknown_model_keeps_tokens_and_no_dollars() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_local", None, "build", "local", 10, json!({}));
        add_message(&conn, "u", "ses_local", 10, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_local", 10, text_part("go"));
        add_message(
            &conn,
            "a",
            "ses_local",
            20,
            assistant("u", "ollama/qwen2.5:7b", 0.0, 100, 5),
        );
        add_message(&conn, "u2", "ses_local", 30, json!({ "role": "user" }));
        add_part(&conn, "t2", "u2", "ses_local", 30, text_part("and"));
        add_message(
            &conn,
            "a2",
            "ses_local",
            40,
            assistant("u2", "anthropic/claude-sonnet-4-5", 2.0, 10, 1),
        );
        drop(conn);
        let s = normalized(&path, "ses_local");
        let cost = s.cost.unwrap();
        assert_eq!(cost.source, CostSource::PartialEstimate);
        assert!((cost.total_usd - 2.0).abs() < 1e-9);
        assert_eq!(cost.unpriced_requests, 1);
        let local = s
            .usage
            .iter()
            .find(|u| u.model == "ollama/qwen2.5:7b")
            .unwrap();
        assert_eq!(
            (
                local.input_tokens,
                local.output_tokens,
                local.estimated_cost_usd
            ),
            (100, 5, None)
        );
    }

    #[test]
    fn a_child_session_is_folded_into_its_parent() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(
            &conn,
            "ses_parent",
            None,
            "build",
            "map it",
            1_000,
            json!({}),
        );
        add_message(&conn, "u", "ses_parent", 1_000, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_parent", 1_000, text_part("map it"));
        add_message(
            &conn,
            "a",
            "ses_parent",
            1_100,
            assistant("u", "anthropic/claude-sonnet-4-5", 0.0, 10, 5),
        );
        add_part(
            &conn,
            "task",
            "a",
            "ses_parent",
            1_100,
            json!({
                "type": "tool",
                "tool": "task",
                "callID": "call_task",
                "state": {
                    "status": "completed",
                    "input": { "description": "look around", "prompt": "map the repo", "subagent_type": "explore" },
                    "output": "done",
                    "metadata": { "sessionId": "ses_child" },
                    "time": { "start": 1_100, "end": 1_200 }
                }
            }),
        );
        add_session(
            &conn,
            "ses_child",
            Some("ses_parent"),
            "explore",
            "map the repo (@explore subagent)",
            1_150,
            json!({}),
        );
        add_message(&conn, "cu", "ses_child", 1_160, json!({ "role": "user" }));
        add_part(
            &conn,
            "ct",
            "cu",
            "ses_child",
            1_160,
            text_part("map the repo"),
        );
        add_message(
            &conn,
            "ca",
            "ses_child",
            1_180,
            assistant("cu", "anthropic/claude-sonnet-4-5", 0.0, 7, 3),
        );
        add_part(
            &conn,
            "cr",
            "ca",
            "ses_child",
            1_180,
            tool(
                "read",
                "call_read",
                json!({ "filePath": "/work/repo/a.rs" }),
                "completed",
                1_180,
            ),
        );
        drop(conn);

        let (events, facts) = session(&path, "ses_parent").unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), OPENCODE).unwrap();
        assert_eq!(s.prompts.len(), 1);
        assert_eq!(s.prompts[0].text.preview, "map it");
        assert!(events.iter().any(|event| event["hook"] == "SubagentStart"));
        assert_eq!(s.subagents.len(), 1);
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("explore"));
        assert_eq!(s.subagents[0].description.as_deref(), Some("look around"));
        assert_eq!(
            (
                s.subagents[0].input_tokens,
                s.subagents[0].output_tokens,
                s.subagents[0].requests
            ),
            (7, 3, 1)
        );
        let tools: Vec<_> = s.tool_calls.iter().map(|c| c.tool.as_str()).collect();
        assert_eq!(tools, ["Agent", "Read"]);
        assert_eq!(s.tool_calls[1].agent_id.as_deref(), Some("ses_child"));
        assert_eq!(
            s.tool_calls[1].file_path.as_deref(),
            Some("/work/repo/a.rs")
        );
        assert_eq!(s.usage.iter().map(|u| u.input_tokens).sum::<u64>(), 17);
        let roots = root_ids(&path).unwrap();
        assert_eq!(roots, ["ses_parent"]);
    }

    #[test]
    fn a_session_stored_only_in_session_message_fails() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        conn.execute_batch("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT)")
            .unwrap();
        add_session(&conn, "ses_new", None, "build", "moved", 10, json!({}));
        conn.execute(
            "INSERT INTO session_message (id, session_id) VALUES ('m1', 'ses_new')",
            [],
        )
        .unwrap();
        add_session(&conn, "ses_old", None, "build", "kept", 20, json!({}));
        conn.execute(
            "INSERT INTO session_message (id, session_id) VALUES ('m2', 'ses_old')",
            [],
        )
        .unwrap();
        add_message(&conn, "u", "ses_old", 20, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_old", 20, text_part("still here"));
        drop(conn);
        let err = session(&path, "ses_new").unwrap_err().to_string();
        assert!(err.contains("session_message"), "{err}");
        assert!(session(&path, "ses_old").is_ok());
    }

    /// A session of two turns, the second of which writes a file; `revert`
    /// is what going back left on the session.
    fn two_turns(path: &Path, revert: Value) {
        let conn = write(path);
        add_session(
            &conn,
            "ses_back",
            None,
            "build",
            "back",
            10,
            json!({ "revert": revert }),
        );
        add_message(&conn, "keep", "ses_back", 10, json!({ "role": "user" }));
        add_part(&conn, "t1", "keep", "ses_back", 10, text_part("keep this"));
        add_message(&conn, "undone", "ses_back", 30, json!({ "role": "user" }));
        add_part(
            &conn,
            "t2",
            "undone",
            "ses_back",
            30,
            text_part("undo this"),
        );
        add_message(
            &conn,
            "later",
            "ses_back",
            40,
            assistant("undone", "anthropic/claude-sonnet-4-5", 0.0, 4, 1),
        );
        add_part(
            &conn,
            "r",
            "later",
            "ses_back",
            40,
            tool(
                "read",
                "call_r",
                json!({ "filePath": "kept.txt" }),
                "completed",
                40,
            ),
        );
        add_part(
            &conn,
            "w",
            "later",
            "ses_back",
            50,
            tool(
                "write",
                "call_w",
                json!({ "filePath": "gone.txt", "content": "x" }),
                "completed",
                50,
            ),
        );
    }

    #[test]
    fn a_revert_drops_the_message_it_names_and_what_came_after() {
        let (_dir, path) = fresh();
        two_turns(&path, json!({ "messageID": "undone" }));
        let s = normalized(&path, "ses_back");
        assert_eq!(s.prompts.len(), 1);
        assert_eq!(s.prompts[0].text.preview, "keep this");
        assert!(s.tool_calls.is_empty());
        assert_eq!(s.usage.iter().map(|u| u.requests).sum::<u64>(), 0);
    }

    #[test]
    fn a_revert_to_a_part_keeps_what_came_before_it() {
        let (_dir, path) = fresh();
        two_turns(&path, json!({ "messageID": "later", "partID": "w" }));
        let s = normalized(&path, "ses_back");
        assert_eq!(s.prompts.len(), 2);
        let tools: Vec<_> = s.tool_calls.iter().map(|c| c.tool.as_str()).collect();
        assert_eq!(tools, ["Read"]);
    }

    #[test]
    fn a_diff_with_no_tool_is_still_counted() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_diff", None, "build", "orphan", 10, json!({}));
        add_message(
            &conn,
            "u",
            "ses_diff",
            10,
            json!({
                "role": "user",
                "summary": { "diffs": [{
                    "file": "orphan.txt",
                    "before": "",
                    "after": "hello\n",
                    "additions": 1,
                    "deletions": 0
                }] }
            }),
        );
        add_part(&conn, "t", "u", "ses_diff", 10, text_part("add it"));
        drop(conn);
        let s = normalized(&path, "ses_diff");
        assert_eq!(s.tool_calls.len(), 1);
        assert_eq!(s.tool_calls[0].tool, "Write");
        assert_eq!(s.counts.lines_added, 1);
        assert!(s.files[0].created);
        assert_eq!(s.files[0].path, "/work/repo/orphan.txt");
    }

    #[test]
    fn text_opencode_wrote_is_no_prompt_and_a_subtask_command_is_its_name() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_said", None, "build", "said", 10, json!({}));
        add_message(&conn, "u1", "ses_said", 10, json!({ "role": "user" }));
        add_part(
            &conn,
            "t1",
            "u1",
            "ses_said",
            10,
            text_part("look at @a.rs"),
        );
        let mut read = text_part("Called the Read tool with the following input: {}");
        read["synthetic"] = json!(true);
        add_part(&conn, "t2", "u1", "ses_said", 11, read);
        let mut contents = text_part("fn secret() {}");
        contents["synthetic"] = json!(true);
        add_part(&conn, "t3", "u1", "ses_said", 12, contents);
        let mut hidden = text_part("for the client only");
        hidden["ignored"] = json!(true);
        add_part(&conn, "t4", "u1", "ses_said", 13, hidden);
        add_message(&conn, "u2", "ses_said", 20, json!({ "role": "user" }));
        let mut carry_on = text_part("Continue if you have next steps");
        carry_on["synthetic"] = json!(true);
        add_part(&conn, "t5", "u2", "ses_said", 20, carry_on);
        add_message(&conn, "u3", "ses_said", 30, json!({ "role": "user" }));
        add_part(
            &conn,
            "t6",
            "u3",
            "ses_said",
            30,
            json!({
                "type": "subtask",
                "agent": "build",
                "command": "review",
                "description": "review changes",
                "prompt": "You are a code reviewer. Review the uncommitted changes."
            }),
        );
        drop(conn);
        let (events, facts) = session(&path, "ses_said").unwrap();
        let raw = serde_json::to_string(&events).unwrap();
        assert!(!raw.contains("secret") && !raw.contains("Continue if"));
        assert!(!raw.contains("client only") && !raw.contains("code reviewer"));
        let s = crate::normalize::from_events(&events, facts.as_ref(), OPENCODE).unwrap();
        let said: Vec<_> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(said, ["look at @a.rs", "/review"]);
        assert_eq!(s.counts.reviews, Some(1));
    }

    #[test]
    fn diffs_are_read_from_the_root_of_the_repository() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        conn.execute_batch(
            "ALTER TABLE session ADD COLUMN project_id TEXT;
             CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
             INSERT INTO project (id, worktree) VALUES ('prj', '/work');",
        )
        .unwrap();
        add_session(&conn, "ses_sub", None, "build", "sub", 10, json!({}));
        conn.execute("UPDATE session SET project_id = 'prj'", [])
            .unwrap();
        add_message(
            &conn,
            "u",
            "ses_sub",
            10,
            json!({
                "role": "user",
                "summary": { "diffs": [
                    { "file": "repo/src/x.ts", "status": "modified", "patch": "@@ -1 +1 @@\n-a\n+b\n" },
                    { "file": "other/y.txt", "status": "added", "patch": "@@ -0,0 +1 @@\n+y\n" }
                ] }
            }),
        );
        add_part(&conn, "t", "u", "ses_sub", 10, text_part("edit"));
        add_message(
            &conn,
            "a",
            "ses_sub",
            20,
            assistant("u", "ollama/qwen2.5:7b", 0.0, 0, 0),
        );
        add_part(
            &conn,
            "e",
            "a",
            "ses_sub",
            20,
            tool(
                "edit",
                "call_edit",
                json!({ "filePath": "src/x.ts" }),
                "completed",
                20,
            ),
        );
        drop(conn);
        let s = normalized(&path, "ses_sub");
        let mut files: Vec<_> = s.files.iter().map(|f| f.path.as_str()).collect();
        files.sort_unstable();
        assert_eq!(files, ["/work/other/y.txt", "/work/repo/src/x.ts"]);
        assert_eq!(s.tool_calls[0].tool, "Edit");
        assert_eq!(s.counts.lines_added, 2);
    }

    #[test]
    fn each_step_is_a_request_and_a_long_prompt_counts_its_cache() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_steps", None, "build", "steps", 10, json!({}));
        add_message(&conn, "u", "ses_steps", 10, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_steps", 10, text_part("go"));
        let step = |input: u64, cache_read: u64, output: u64| {
            json!({
                "type": "step-finish",
                "reason": "tool-calls",
                "cost": 0,
                "tokens": { "input": input, "output": output, "reasoning": 0,
                            "cache": { "read": cache_read, "write": 0 } }
            })
        };
        let mut reply = assistant("u", "openai/gpt-6.1-sol", 0.0, 0, 0);
        // The message keeps its last step's tokens only.
        reply["tokens"] = step(2_000, 300_000, 20)["tokens"].clone();
        add_message(&conn, "a", "ses_steps", 20, reply);
        add_part(&conn, "s1", "a", "ses_steps", 21, step(1_000, 0, 10));
        add_part(&conn, "s2", "a", "ses_steps", 22, step(2_000, 300_000, 20));
        drop(conn);
        let s = normalized(&path, "ses_steps");
        let used = &s.usage[0];
        assert_eq!(
            (
                used.requests,
                used.input_tokens,
                used.output_tokens,
                used.cache_read_tokens
            ),
            (2, 3_000, 30, 300_000)
        );
        let billed = |input, cache_read, output, prompt| {
            crate::pricing::price_for("openai/gpt-6.1-sol", prompt)
                .unwrap()
                .cost(&crate::pricing::Billed {
                    input,
                    output,
                    cache_read,
                    ..Default::default()
                })
        };
        let want = billed(1_000, 0, 10, 1_000) + billed(2_000, 300_000, 20, 302_000);
        assert!((s.cost.unwrap().total_usd - want).abs() < 1e-9);
        assert!(want > billed(1_000, 0, 10, 1_000) + billed(2_000, 300_000, 20, 2_000));
    }

    #[test]
    fn a_later_change_to_the_session_is_not_more_time_in_it() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        let t0 = 1_763_000_000_000_i64;
        add_session(&conn, "ses_old", None, "build", "old", t0, json!({}));
        add_message(&conn, "u", "ses_old", t0, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_old", t0, text_part("go"));
        let mut reply = assistant("u", "ollama/qwen2.5:7b", 0.0, 1, 1);
        reply["time"] = json!({ "created": t0 + 10, "completed": t0 + 1_000 });
        add_message(&conn, "a", "ses_old", t0 + 10, reply);
        let week = 7 * 24 * 3_600 * 1_000;
        conn.execute("UPDATE session SET time_updated = ?1", params![t0 + week])
            .unwrap();
        drop(conn);
        let s = normalized(&path, "ses_old");
        assert_eq!(s.duration_ms, Some(1_000));
    }

    #[test]
    fn a_diff_with_no_tool_is_at_the_time_of_its_prompt() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        let t0 = 1_763_000_000_000_i64;
        add_session(&conn, "ses_when", None, "build", "when", t0, json!({}));
        add_message(
            &conn,
            "u",
            "ses_when",
            t0 + 10,
            json!({
                "role": "user",
                "summary": { "diffs": [{ "file": "x.txt", "status": "added", "patch": "@@ -0,0 +1 @@\n+x\n" }] }
            }),
        );
        add_part(&conn, "t", "u", "ses_when", t0 + 10, text_part("make x"));
        drop(conn);
        let (events, _) = session(&path, "ses_when").unwrap();
        let write = events
            .iter()
            .find(|event| event["hook"] == "PostToolUse")
            .unwrap();
        assert_eq!(write["received_at"], time_of(t0 + 10));
        assert_eq!(events[0]["hook"], "SessionStart");
    }

    #[test]
    fn an_edit_takes_only_its_own_file() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_same", None, "build", "same", 10, json!({}));
        add_message(
            &conn,
            "u",
            "ses_same",
            10,
            json!({
                "role": "user",
                "summary": { "diffs": [
                    { "file": "src/lib.rs", "status": "modified", "patch": "@@ -1 +1 @@\n-a\n+b\n" },
                    { "file": "lib.rs", "status": "added", "patch": "@@ -0,0 +1 @@\n+c\n" },
                    { "file": "a/mod.rs", "status": "added", "patch": "@@ -0,0 +1 @@\n+d\n" }
                ] }
            }),
        );
        add_part(&conn, "t", "u", "ses_same", 10, text_part("edit"));
        add_message(
            &conn,
            "a",
            "ses_same",
            20,
            assistant("u", "ollama/qwen2.5:7b", 0.0, 0, 0),
        );
        add_part(
            &conn,
            "e",
            "a",
            "ses_same",
            20,
            tool(
                "edit",
                "call_edit",
                json!({ "filePath": "/work/repo/src/lib.rs" }),
                "completed",
                20,
            ),
        );
        add_part(
            &conn,
            "m",
            "a",
            "ses_same",
            30,
            tool(
                "edit",
                "call_mod",
                json!({ "filePath": "/work/repo/b/mod.rs" }),
                "completed",
                30,
            ),
        );
        add_part(
            &conn,
            "s",
            "a",
            "ses_same",
            40,
            tool(
                "bash",
                "call_sh",
                json!({ "command": "make" }),
                "completed",
                40,
            ),
        );
        drop(conn);
        let (events, _) = session(&path, "ses_same").unwrap();
        let edits: Vec<_> = events
            .iter()
            .filter(|event| {
                event["hook"] == "PostToolUse" && event["payload"]["tool_name"] == "Edit"
            })
            .map(|event| {
                let payload = &event["payload"];
                let lines = &payload["tool_response"]["structuredPatch"][0]["lines"];
                (
                    payload["tool_input"]["file_path"].as_str().unwrap(),
                    lines.clone(),
                )
            })
            .collect();
        assert_eq!(
            edits,
            [
                ("/work/repo/src/lib.rs", json!(["-a", "+b"])),
                ("/work/repo/b/mod.rs", Value::Null),
            ]
        );
        let shell = events
            .iter()
            .find(|event| event["hook"] == "PostToolUse" && event["payload"]["tool_name"] == "Bash")
            .unwrap();
        let changed: Vec<_> = shell["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|change| change["path"].as_str().unwrap())
            .collect();
        assert_eq!(changed, ["/work/repo/lib.rs", "/work/repo/a/mod.rs"]);
    }

    #[test]
    fn a_row_changed_in_place_changes_the_stamp() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_late", None, "build", "late", 10, json!({}));
        add_message(&conn, "u", "ses_late", 10, json!({ "role": "user" }));
        let before = stamp(&conn, "ses_late").unwrap();
        conn.execute(
            "UPDATE message SET data = ?1 WHERE id = 'u'",
            params![json!({
                "role": "user",
                "summary": { "diffs": [{ "file": "x", "patch": "@@ -0,0 +1 @@\n+x\n" }] }
            })
            .to_string()],
        )
        .unwrap();
        assert_ne!(stamp(&conn, "ses_late").unwrap(), before);
        assert!(stamp(&conn, "ses_late").unwrap() <= i64::MAX as u64);
    }

    #[test]
    fn another_session_in_the_database_leaves_this_one_unchanged() {
        let (dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_one", None, "build", "one", 10, json!({}));
        add_message(&conn, "u", "ses_one", 10, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_one", 10, text_part("hello"));
        drop(conn);
        let homes = crate::import::AgentHomes {
            opencode_db: Some(path.clone()),
            ..Default::default()
        };
        let data = dir.path().join("data");
        marker(&data, "ses_one");
        assert_eq!(
            crate::import::import_all(&homes, &data, &[], &[]).imported,
            1
        );
        let mut ledger = crate::ledger::Ledger::open(&data.join("ledger.db")).unwrap();
        let dirs = || vec![crate::sync::SourceDirs::in_data_dir(&data, OPENCODE)];
        assert_eq!(
            crate::sync::run(&dirs(), &mut ledger, "machine", false)
                .unwrap()
                .synced,
            1
        );

        let size = fs::metadata(&path).unwrap().len();
        let conn = write(&path);
        add_session(&conn, "ses_two", None, "build", "two", 20, json!({}));
        add_message(&conn, "u2", "ses_two", 20, json!({ "role": "user" }));
        add_part(
            &conn,
            "t2",
            "u2",
            "ses_two",
            20,
            text_part(&"x".repeat(20_000)),
        );
        drop(conn);
        assert_ne!(fs::metadata(&path).unwrap().len(), size);
        crate::import::import_all(&homes, &data, &[], &[]);
        let report = crate::sync::run(&dirs(), &mut ledger, "machine", false).unwrap();
        assert_eq!((report.synced, report.unchanged), (1, 1));
        assert!(ledger
            .session_ids()
            .unwrap()
            .contains(&"ses_two".to_string()));
    }

    #[test]
    fn a_patch_with_two_files_is_two_edits() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_patch", None, "build", "patch", 10, json!({}));
        add_message(
            &conn,
            "u",
            "ses_patch",
            10,
            json!({
                "role": "user",
                "summary": { "diffs": [
                    { "file": "a.txt", "status": "added", "patch": "@@ -0,0 +1 @@\n+a\n" },
                    { "file": "b.txt", "status": "modified", "patch": "@@ -1 +1 @@\n-old\n+new\n" }
                ] }
            }),
        );
        add_part(&conn, "t", "u", "ses_patch", 10, text_part("patch"));
        add_message(
            &conn,
            "a",
            "ses_patch",
            20,
            assistant("u", "ollama/qwen2.5:7b", 0.0, 0, 0),
        );
        add_part(
            &conn,
            "p",
            "a",
            "ses_patch",
            20,
            json!({
                "type": "tool",
                "tool": "apply_patch",
                "callID": "call_patch",
                "state": {
                    "status": "completed",
                    "input": { "patchText": "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch" },
                    "output": "ok",
                    "metadata": { "files": [
                        { "filePath": "/work/repo/a.txt", "relativePath": "a.txt", "type": "add" },
                        { "filePath": "/work/repo/b.txt", "relativePath": "b.txt", "type": "update" }
                    ] },
                    "time": { "start": 20, "end": 30 }
                }
            }),
        );
        drop(conn);
        let s = normalized(&path, "ses_patch");
        let tools: Vec<_> = s.tool_calls.iter().map(|c| c.tool.as_str()).collect();
        assert_eq!(tools, ["Write", "Edit"]);
        assert_eq!(s.counts.lines_added, 2);
        assert_eq!(s.counts.lines_removed, 1);
    }

    #[test]
    fn internal_sessions_are_skipped_and_an_orphan_child_stands_alone() {
        let (_dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_title", None, "title", "title", 1, json!({}));
        add_session(&conn, "ses_parent", None, "build", "parent", 2, json!({}));
        add_session(
            &conn,
            "ses_child",
            Some("ses_parent"),
            "explore",
            "child",
            3,
            json!({}),
        );
        add_session(
            &conn,
            "ses_orphan",
            Some("ses_missing"),
            "build",
            "orphan",
            4,
            json!({}),
        );
        drop(conn);
        assert_eq!(root_ids(&path).unwrap(), ["ses_parent", "ses_orphan"]);
        let (events, facts) = session(&path, "ses_title").unwrap();
        assert!(events.is_empty() && facts.is_none());
    }

    #[test]
    fn import_follows_the_database_and_a_child_marker_wakes_the_parent() {
        let (dir, path) = fresh();
        let conn = write(&path);
        add_session(&conn, "ses_parent", None, "build", "parent", 10, json!({}));
        add_message(&conn, "u", "ses_parent", 10, json!({ "role": "user" }));
        add_part(&conn, "t", "u", "ses_parent", 10, text_part("hello"));
        add_message(
            &conn,
            "a",
            "ses_parent",
            20,
            assistant("u", "anthropic/claude-sonnet-4-5", 0.5, 8, 2),
        );
        add_session(
            &conn,
            "ses_child",
            Some("ses_parent"),
            "explore",
            "child",
            30,
            json!({}),
        );
        add_message(&conn, "cu", "ses_child", 30, json!({ "role": "user" }));
        add_part(&conn, "ct", "cu", "ses_child", 30, text_part("task"));
        add_message(
            &conn,
            "ca",
            "ses_child",
            40,
            assistant("cu", "anthropic/claude-sonnet-4-5", 0.0, 3, 1),
        );
        drop(conn);

        let homes = crate::import::AgentHomes {
            opencode_db: Some(path.clone()),
            ..Default::default()
        };
        let data = dir.path().join("data");
        assert_eq!(crate::import::refresh(&homes, &data).imported, 0);
        marker(&data, "ses_child");
        assert!(descendant_captured(&path, "ses_parent", &data));
        let woken = crate::import::refresh(&homes, &data);
        assert_eq!((woken.imported, woken.failed.len()), (1, 0));
        assert!(data.join("imported/opencode/ses_parent.jsonl").is_file());
        assert!(!data.join("imported/opencode/ses_child.jsonl").is_file());

        let again = crate::import::import_all(&homes, &data, &[], &[]);
        assert_eq!(again.up_to_date, 1);

        let conn = write(&path);
        add_part(&conn, "extra", "cu", "ses_child", 41, text_part("more"));
        drop(conn);
        let third = crate::import::import_all(&homes, &data, &[], &[]);
        assert_eq!((third.imported, third.failed.len()), (1, 0));

        let saved = fs::read_to_string(data.join("imported/opencode/ses_parent.jsonl")).unwrap();
        assert!(saved.contains("SubagentStart"));
        let mut ledger = crate::ledger::Ledger::open(&data.join("ledger.db")).unwrap();
        let dirs = crate::sync::SourceDirs::in_data_dir(&data, OPENCODE);
        // A leftover import of the child, as if it once stood alone. A real
        // prompt, so a missing fold would put the child in the ledger too.
        let child_line = json!({
            "v": 1,
            "source": "opencode",
            "origin": "transcript",
            "hook": "UserPromptSubmit",
            "session_id": "ses_child",
            "payload": {
                "session_id": "ses_child",
                "hook_event_name": "UserPromptSubmit",
                "prompt": "task"
            }
        });
        fs::write(
            data.join("imported/opencode/ses_child.jsonl"),
            format!("{child_line}\n"),
        )
        .unwrap();
        crate::sync::run(&[dirs], &mut ledger, "machine", true).unwrap();
        let mut ids = ledger.session_ids().unwrap();
        ids.sort();
        assert_eq!(ids, ["ses_parent"]);
    }
}
