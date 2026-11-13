//! Import Cursor's agent transcripts from
//! `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`.
//!
//! A transcript has the prompts (most with the minute they were sent) and
//! every tool call with its input, and for some turns a row when the turn
//! ends. It has no tool results, no other times, no tokens, no cost and no
//! model. So from the transcript alone:
//! - tool calls are taken as having succeeded;
//! - the only times are each prompt's minute and the file's own (when it was
//!   created and last written), so there is no active time;
//! - cost and models are unknown.
//!
//! Turns that ran while the hooks were installed have all of that in the
//! hook capture (see `cursor_hooks`). Those turns are paired with the
//! transcript's prompts and get their exact times, tool durations and
//! failures, model and tokens. The transcript stays the record of what
//! happened; the hooks add to the turns they saw.
//!
//! Cursor's tools are mapped to the names used for Claude Code's (Read, Edit,
//! Write, Bash, Grep, Glob) so sessions from different agents can be compared.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{DateTime, FixedOffset, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};

use crate::cursor_hooks::{self, Turn};
use crate::import::{edit_result, slim_input, Builder};
use crate::paths::CURSOR;
use crate::transcript::Facts;

fn subagent_files(transcript: &Path) -> Vec<PathBuf> {
    let dir = transcript.parent().map(|d| d.join("subagents"));
    let mut files: Vec<PathBuf> = dir
        .and_then(|d| fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    files
}

/// Combined size of the files a session is imported from.
pub fn session_bytes(transcript: &Path) -> u64 {
    std::iter::once(transcript.to_path_buf())
        .chain(subagent_files(transcript))
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// What the person typed. Cursor wraps it in `<user_query>` and puts attached
/// files and diffs around it, which are not part of the prompt.
fn user_query(text: &str) -> &str {
    match (text.find("<user_query>"), text.rfind("</user_query>")) {
        (Some(start), Some(end)) if start < end => text[start + "<user_query>".len()..end].trim(),
        _ => text.trim(),
    }
}

/// Text Cursor adds to the conversation itself (the subagents on offer, the
/// git status) arrives as a user message that is one tagged block and has no
/// `<user_query>`.
fn is_injected_context(text: &str) -> bool {
    let text = text.trim();
    !text.contains("<user_query>")
        && text.starts_with('<')
        && text[1..].split_once('>').is_some_and(|(tag, _)| {
            !tag.is_empty() && tag.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        })
}

/// When a prompt was sent, from the `<timestamp>` Cursor puts beside it:
/// `Thursday, Nov 5, 2026, 10:43 AM (UTC+2)`. Minute precision.
fn prompt_time(text: &str) -> Option<DateTime<Utc>> {
    let start = text.find("<timestamp>")? + "<timestamp>".len();
    let stamp = &text[start..start + text[start..].find("</timestamp>")?];
    // drop the weekday
    let (_, stamp) = stamp.trim().split_once(", ")?;
    let (local, zone) = match stamp.split_once(" (UTC") {
        Some((local, zone)) => (local, zone.trim_end_matches(')')),
        None => (stamp, ""),
    };
    let local = NaiveDateTime::parse_from_str(local.trim(), "%b %d, %Y, %I:%M %p").ok()?;
    let seconds = if zone.is_empty() {
        0
    } else {
        let (hours, minutes) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
        let amount = hours.parse::<i32>().ok()? * 3600 + minutes.parse::<i32>().ok()? * 60;
        if zone.starts_with('-') {
            -amount
        } else {
            amount
        }
    };
    let local = FixedOffset::east_opt(seconds)?
        .from_local_datetime(&local)
        .single()?;
    Some(local.with_timezone(&Utc))
}

fn stamp(time: Option<DateTime<Utc>>) -> String {
    time.map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// A time the hooks recorded, kept to the millisecond.
fn exact(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The turn the hooks saw for a prompt in the transcript: the same text, sent
/// in the minute the transcript gives. Without that minute the text alone
/// decides, and the earliest turn not yet paired is taken.
fn find_turn(turns: &[Turn], prompt: &str, minute: Option<DateTime<Utc>>) -> Option<usize> {
    turns.iter().position(|turn| {
        !turn.matched
            && turn.prompt.trim() == prompt
            && minute.is_none_or(|m| (-60..180).contains(&(turn.at - m).num_seconds()))
    })
}

/// The end of a turn as the hooks saw it.
fn end_turn(out: &mut Builder, turn: &Turn, prompt_id: String) {
    let Some(ended) = turn.ended_at else { return };
    match &turn.error {
        Some(error) => out.push(
            &exact(ended),
            "StopFailure",
            json!({ "prompt_id": prompt_id, "error": error }),
        ),
        None => out.push(&exact(ended), "Stop", json!({ "prompt_id": prompt_id })),
    }
}

/// Cursor's tool and its input under the names used for Claude Code's tools,
/// with the result an edit implies.
fn canonical(name: &str, input: &Value) -> (String, Value, Value) {
    let field = |key: &str| input.get(key).cloned().unwrap_or(Value::Null);
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    let none = json!({});
    match name {
        "Read" => ("Read".into(), json!({ "file_path": field("path") }), none),
        "StrReplace" => (
            "Edit".into(),
            json!({ "file_path": field("path") }),
            edit_result(text("old_string"), text("new_string"), false),
        ),
        // Whether the file existed is not recorded: every line counts as added.
        "Write" => (
            "Write".into(),
            json!({ "file_path": field("path") }),
            edit_result("", text("contents"), true),
        ),
        "Shell" => (
            "Bash".into(),
            json!({ "command": field("command"), "description": field("description") }),
            none,
        ),
        "Grep" => (
            "Grep".into(),
            json!({ "pattern": field("pattern"), "path": field("path"), "glob": field("glob") }),
            none,
        ),
        "Glob" => (
            "Glob".into(),
            json!({ "pattern": field("glob_pattern") }),
            none,
        ),
        _ => (name.to_string(), slim_input(input), none),
    }
}

/// Read one transcript file into events, taking times and outcomes from the
/// turns the hooks saw (`hooked`; none for a subagent's file). Returns how
/// many tool calls and prompts it had.
fn read_file(
    path: &Path,
    agent_id: Option<&str>,
    hooked: &mut [Turn],
    out: &mut Builder,
) -> Result<(u64, u64)> {
    let mut prompts = 0u64;
    let mut calls = 0u64;
    // The hooked turn of the prompt being read, the next of its tool calls to
    // pair, and whether its end is still to be written.
    let mut current: Option<usize> = None;
    let mut next_tool = 0usize;
    let mut open: Option<usize> = None;
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    crate::jsonl::for_each(path, |row| {
        let blocks = row["message"]["content"].as_array();
        match (row["role"].as_str(), row["type"].as_str()) {
            (Some("user"), _) if agent_id.is_none() => {
                let text: Vec<&str> = blocks
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b["text"].as_str())
                    .collect();
                let text = text.join("\n");
                let prompt = user_query(&text).to_string();
                if !prompt.is_empty() && !is_injected_context(&text) {
                    // The transcript has no row for the end of every turn.
                    if let Some(i) = open.take() {
                        end_turn(out, &hooked[i], format!("p{prompts}"));
                    }
                    prompts += 1;
                    let minute = prompt_time(&text);
                    current = find_turn(hooked, &prompt, minute);
                    next_tool = 0;
                    let at = match current {
                        Some(i) => {
                            hooked[i].matched = true;
                            open = Some(i);
                            exact(hooked[i].at)
                        }
                        None => stamp(minute),
                    };
                    out.push(
                        &at,
                        "UserPromptSubmit",
                        json!({ "prompt_id": format!("p{prompts}"), "prompt": prompt }),
                    );
                }
            }
            (Some("assistant"), _) => {
                for block in blocks
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "tool_use")
                {
                    calls += 1;
                    let id = block["id"]
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| format!("{stem}-{calls}"));
                    let name = block["name"].as_str().unwrap_or("?");
                    let (tool, input, result) = canonical(name, &block["input"]);
                    let mut payload = json!({
                        "prompt_id": format!("p{prompts}"),
                        "tool_use_id": id,
                        "tool_name": tool,
                        "tool_input": input,
                    });
                    if let Some(agent) = agent_id {
                        payload["agent_id"] = json!(agent);
                    }
                    // The hooks saw the turn's calls in the same order. A call
                    // that does not line up ends the pairing for the turn.
                    let seen = current
                        .and_then(|i| hooked[i].tools.get(next_tool))
                        .filter(|seen| seen.name == name);
                    let Some(seen) = seen else {
                        next_tool = usize::MAX;
                        out.push("", "PreToolUse", payload.clone());
                        // No result is recorded; the call is taken as done.
                        payload["tool_response"] = result;
                        out.push("", "PostToolUse", payload);
                        continue;
                    };
                    next_tool += 1;
                    out.push(&exact(seen.at), "PreToolUse", payload.clone());
                    let ms = seen.duration_ms.unwrap_or(0);
                    let done = exact(seen.at + chrono::Duration::milliseconds(ms as i64));
                    payload["duration_ms"] = json!(seen.duration_ms);
                    match &seen.error {
                        Some(error) => {
                            payload["error"] = json!(error);
                            out.push(&done, "PostToolUseFailure", payload);
                        }
                        None => {
                            payload["tool_response"] = result;
                            out.push(&done, "PostToolUse", payload);
                        }
                    }
                }
            }
            (_, Some("turn_ended")) if agent_id.is_none() => {
                let prompt_id = format!("p{prompts}");
                if let Some(i) = open.take().filter(|&i| hooked[i].ended_at.is_some()) {
                    end_turn(out, &hooked[i], prompt_id);
                } else if row["status"] == "error" {
                    out.push(
                        "",
                        "StopFailure",
                        json!({ "prompt_id": prompt_id, "error": row["error"] }),
                    );
                } else {
                    out.push("", "Stop", json!({ "prompt_id": prompt_id }));
                }
            }
            _ => {}
        }
    })?;
    if let Some(i) = open {
        end_turn(out, &hooked[i], format!("p{prompts}"));
    }
    Ok((calls, prompts))
}

/// The directory a Cursor project folder name stands for. Cursor names the
/// folder after the path with every separator turned into a dash, so
/// `home-me-my-app` could be `/home/me/my-app` or `/home/me/my/app`: the one
/// that exists on disk is taken.
pub fn resolve_project(slug: &str, root: &Path) -> Option<PathBuf> {
    if slug.is_empty() {
        return Some(root.to_path_buf());
    }
    let mut names: Vec<String> = fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    // Longest first, so `my-app` is tried before `my`.
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    for name in names {
        let as_slug = name.trim_start_matches('.').replace(['.', '_', ' '], "-");
        let rest = match slug.strip_prefix(as_slug.as_str()) {
            Some("") => "",
            Some(rest) if rest.starts_with('-') => &rest[1..],
            _ => continue,
        };
        if let Some(found) = resolve_project(rest, &root.join(&name)) {
            return Some(found);
        }
    }
    None
}

fn time_of(time: std::io::Result<std::time::SystemTime>) -> Option<DateTime<Utc>> {
    time.ok().map(DateTime::<Utc>::from)
}

/// The session's events and what is known beyond them. `transcript` is
/// `<project>/agent-transcripts/<id>/<id>.jsonl`; `capture` is the raw hook
/// capture of the session, if the hooks saw any of it.
pub fn session(transcript: &Path, capture: Option<&Path>) -> Result<(Vec<Value>, Option<Facts>)> {
    let session_id = transcript
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut hooked = capture.map(cursor_hooks::read).unwrap_or_default();
    let mut out = Builder::new(CURSOR, &session_id);
    let (calls, prompts) = read_file(transcript, None, &mut hooked.turns, &mut out)?;
    let mut total = calls;
    for file in subagent_files(transcript) {
        let agent = file
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let identity = json!({ "agent_id": agent, "agent_type": "" });
        out.push("", "SubagentStart", identity.clone());
        total += read_file(&file, Some(&agent), &mut [], &mut out)?.0;
        out.push("", "SubagentStop", identity);
    }
    let events = out.in_order();
    if total == 0 && !events.iter().any(|e| e["hook"] == "UserPromptSubmit") {
        return Ok((Vec::new(), None));
    }

    let metadata = fs::metadata(transcript)?;
    let modified = time_of(metadata.modified());
    // Not every filesystem records when a file was created.
    let created = time_of(metadata.created()).or(modified);
    let mut start = json!({ "source": "startup" });
    let project = transcript.ancestors().nth(3).and_then(|p| p.file_name());
    let cwd = project.and_then(|slug| resolve_project(&slug.to_string_lossy(), Path::new("/")));
    if let Some(cwd) = cwd {
        start["cwd"] = json!(cwd);
    }
    let mut out = Builder::new(CURSOR, &session_id);
    out.push(&stamp(created), "SessionStart", start);
    let mut all = out.in_order();
    all.extend(events);

    let (usage, cost) = cursor_hooks::usage(&hooked.turns, prompts);
    let facts = Facts {
        first_at: created,
        last_at: modified,
        version: hooked.cursor_version,
        cost,
        usage,
        ..Default::default()
    };
    Ok((all, Some(facts)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn turns_the_hooks_saw_get_their_times_model_and_tokens() {
        use crate::cursor_hooks::tests::{event, write};
        use crate::session::{CostSource, Outcome, ToolStatus};
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("projects/no-such-place/agent-transcripts/k2/k2.jsonl");
        let asked = |day: &str, text: &str| {
            user(&format!(
                "<timestamp>{day}, 2026, 11:59 PM (UTC+2)</timestamp>\n<user_query>\n{text}\n</user_query>"
            ))
        };
        write_rows(
            &path,
            &[
                // the same words a day earlier, before the hooks were installed
                asked("Thursday, Nov 12", "which are open?"),
                uses(&[("Shell", json!({ "command": "gh issue list" }))]),
                json!({ "type": "turn_ended", "status": "success" }),
                asked("Friday, Nov 13", "which are open?"),
                uses(&[
                    ("Shell", json!({ "command": "gh issue list" })),
                    ("Read", json!({ "path": "/w/repo/gone.rs" })),
                ]),
                // the hooks have no third call for this turn
                uses(&[("Grep", json!({ "pattern": "TODO" }))]),
                json!({ "type": "turn_ended", "status": "success" }),
                // the transcript has no row for the end of this turn
                asked("Friday, Nov 13", "and now?"),
            ],
        );
        let capture = dir.path().join("raw/cursor/k2.jsonl");
        write(
            &capture,
            &[
                event(
                    10,
                    "beforeSubmitPrompt",
                    "g1",
                    json!({ "prompt": "which are open?", "model_id": "claude-opus-5-5" }),
                ),
                event(
                    12,
                    "preToolUse",
                    "g1",
                    json!({ "tool_use_id": "t1", "tool_name": "Shell" }),
                ),
                event(
                    16,
                    "postToolUse",
                    "g1",
                    json!({ "tool_use_id": "t1", "duration": 3503.2, "tool_output": "secret output" }),
                ),
                event(
                    17,
                    "preToolUse",
                    "g1",
                    json!({ "tool_use_id": "t2", "tool_name": "Read" }),
                ),
                event(
                    18,
                    "postToolUseFailure",
                    "g1",
                    json!({ "tool_use_id": "t2", "error_message": "no such file" }),
                ),
                event(
                    30,
                    "stop",
                    "g1",
                    json!({ "status": "completed", "input_tokens": 1_000_000, "output_tokens": 0 }),
                ),
                event(
                    40,
                    "beforeSubmitPrompt",
                    "g2",
                    json!({ "prompt": "and now?", "model_id": "gpt-9" }),
                ),
                event(
                    41,
                    "stop",
                    "g2",
                    json!({ "status": "error", "input_tokens": 100, "output_tokens": 10 }),
                ),
            ],
        );

        let (events, facts) = session(&path, Some(&capture)).unwrap();
        // what a tool printed stays in the raw capture
        assert!(!serde_json::to_string(&events).unwrap().contains("secret"));
        let s = crate::normalize::from_events(&events, facts.as_ref(), CURSOR).unwrap();

        let at = |t: Option<DateTime<Utc>>| t.map(|t| t.format("%d %H:%M:%S%.3f").to_string());
        let turns: Vec<_> = s
            .prompts
            .iter()
            .map(|p| (at(p.at), at(p.ended_at), p.outcome))
            .collect();
        assert_eq!(
            turns,
            [
                (
                    Some("12 21:59:00.000".into()),
                    None,
                    Some(Outcome::Completed)
                ),
                (
                    Some("13 21:59:10.500".into()),
                    Some("13 21:59:30.500".into()),
                    Some(Outcome::Completed)
                ),
                (
                    Some("13 21:59:40.500".into()),
                    Some("13 21:59:41.500".into()),
                    Some(Outcome::ApiError)
                ),
            ]
        );
        assert_eq!(s.active_ms, 21_000);
        let calls: Vec<_> = s
            .tool_calls
            .iter()
            .map(|c| (c.tool.as_str(), c.status, c.duration_ms, c.error.as_deref()))
            .collect();
        assert_eq!(
            calls,
            [
                ("Bash", ToolStatus::Ok, None, None),
                ("Bash", ToolStatus::Ok, Some(3_503), None),
                (
                    "Read",
                    ToolStatus::Failed,
                    Some(1_000),
                    Some("no such file")
                ),
                ("Grep", ToolStatus::Ok, None, None),
            ]
        );

        assert_eq!(s.models, ["claude-opus-5-5", "gpt-9"]);
        assert_eq!(s.agent_version.as_deref(), Some("3.27.22"));
        let cost = s.cost.unwrap();
        assert_eq!(
            (
                cost.total_usd,
                cost.source,
                cost.unpriced_requests,
                cost.prompts_covered
            ),
            (4.0, CostSource::PartialEstimate, 1, Some(2))
        );

        // without a capture nothing is made up
        let (events, facts) = session(&path, None).unwrap();
        let s = crate::normalize::from_events(&events, facts.as_ref(), CURSOR).unwrap();
        assert!(s.cost.is_none() && s.models.is_empty() && s.active_ms == 0);
        assert!(s.tool_calls.iter().all(|c| c.status == ToolStatus::Ok));
    }

    #[test]
    fn reads_the_time_beside_a_prompt() {
        let at = |text: &str| prompt_time(text).map(|t| t.to_rfc3339());
        assert_eq!(
            at("<timestamp>Thursday, Aug 6, 2026, 12:50 PM (UTC+3)</timestamp>").as_deref(),
            Some("2026-08-06T09:50:00+00:00")
        );
        assert_eq!(
            at("<timestamp>Monday, Nov 9, 2026, 12:28 AM (UTC-5:30)</timestamp>").as_deref(),
            Some("2026-11-09T05:58:00+00:00")
        );
        assert_eq!(
            at("<timestamp>Monday, Nov 9, 2026, 9:05 AM (UTC)</timestamp>").as_deref(),
            Some("2026-11-09T09:05:00+00:00")
        );
        assert_eq!(at("<timestamp>soon</timestamp>"), None);
        assert_eq!(at("no time here"), None);
    }

    fn write_rows(path: &Path, rows: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        for row in rows {
            writeln!(f, "{row}").unwrap();
        }
    }

    fn user(text: &str) -> Value {
        json!({ "role": "user", "message": { "content": [{ "type": "text", "text": text }] } })
    }

    fn uses(tools: &[(&str, Value)]) -> Value {
        let blocks: Vec<Value> =
            std::iter::once(json!({ "type": "text", "text": "ok" }))
                .chain(tools.iter().map(
                    |(name, input)| json!({ "type": "tool_use", "name": name, "input": input }),
                ))
                .collect();
        json!({ "role": "assistant", "message": { "content": blocks } })
    }

    #[test]
    fn rebuilds_a_cursor_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("projects/no-such-place/agent-transcripts/k1/k1.jsonl");
        write_rows(
            &path,
            &[
                user("<available_subagent_types>\nexplore: looks around\n</available_subagent_types>"),
                user("<timestamp>Thursday, Nov 5, 2026, 1:02 PM (UTC+2)</timestamp>\n<attached_files>\n<code_selection path=\"/w/secret.key\">\n1|sk-live-123\n</code_selection>\n</attached_files>\n<user_query>\nfix the parser\n</user_query>"),
                uses(&[("Read", json!({ "path": "/w/repo/a.rs", "limit": 10 })),
                       ("StrReplace", json!({ "path": "/w/repo/a.rs", "old_string": "old();", "new_string": "one();\ntwo();" }))]),
                uses(&[("Write", json!({ "path": "/w/repo/b.rs", "contents": "fn b() {}\nfn c() {}\n" })),
                       ("Shell", json!({ "command": "cargo test", "description": "run tests" })),
                       ("UpdateCurrentStep", json!({ "note": "x".repeat(900) }))]),
                json!({ "type": "turn_ended", "status": "success" }),
                user("plain second prompt"),
                json!({ "type": "turn_ended", "status": "error", "error": "rate limited" }),
            ],
        );
        write_rows(
            &dir.path()
                .join("projects/no-such-place/agent-transcripts/k1/subagents/sub1.jsonl"),
            &[
                user("sub task"),
                uses(&[("Grep", json!({ "pattern": "TODO" }))]),
            ],
        );

        let (events, facts) = session(&path, None).unwrap();
        let facts = facts.unwrap();
        assert_eq!(events[0]["hook"], "SessionStart");
        assert!(events.iter().all(|e| e["source"] == "cursor"));
        // an import never carries a whole file from a tool's input
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains(&"x".repeat(600)));

        let s = crate::normalize::from_events(&events, Some(&facts), CURSOR).unwrap();
        assert_eq!(s.source, "cursor");
        assert_eq!(s.session_id, "k1");
        let prompts: Vec<&str> = s.prompts.iter().map(|p| p.text.preview.as_str()).collect();
        assert_eq!(
            prompts,
            ["fix the parser", "plain second prompt"],
            "attachments and what Cursor adds itself are not the prompt"
        );
        assert_eq!(
            s.prompts[0].at.map(|t| t.to_rfc3339()).as_deref(),
            Some("2026-11-05T11:02:00+00:00")
        );
        assert!(s.prompts[1].at.is_none());
        use crate::session::Outcome;
        assert_eq!(s.prompts[0].outcome, Some(Outcome::Completed));
        assert_eq!(s.prompts[1].outcome, Some(Outcome::ApiError));
        assert_eq!(s.prompts[1].error.as_deref(), Some("rate limited"));

        let tools: Vec<&str> = s.tool_calls.iter().map(|c| c.tool.as_str()).collect();
        assert_eq!(
            tools,
            ["Read", "Edit", "Write", "Bash", "UpdateCurrentStep", "Grep"]
        );
        assert!(s
            .tool_calls
            .iter()
            .all(|c| c.status == crate::session::ToolStatus::Ok));
        assert_eq!(s.tool_calls[3].input_summary.as_deref(), Some("cargo test"));
        assert_eq!(s.tool_calls[5].agent_id.as_deref(), Some("sub1"));
        assert_eq!(s.counts.subagents, 1);

        let file = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(
            (
                file("/w/repo/a.rs").reads,
                file("/w/repo/a.rs").lines_added,
                file("/w/repo/a.rs").lines_removed
            ),
            (1, 2, 1)
        );
        assert_eq!(file("/w/repo/b.rs").lines_added, 2);
        assert_eq!(crate::rewrite::added_lines(&events).len(), 2);

        // what a Cursor transcript does not have
        assert!(s.cost.is_none());
        assert!(s.models.is_empty());
        assert_eq!(s.active_ms, 0);
        assert!(s.started_at.is_some() && s.ended_at.is_some());
        assert_eq!(
            s.cwd, None,
            "the project folder does not exist on this machine"
        );
        assert!(session_bytes(&path) > fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn finds_the_directory_a_project_folder_stands_for() {
        let dir = tempfile::tempdir().unwrap();
        for path in [
            "home/me/my-app/src",
            "home/me/my/app",
            "home/me/.config/tool",
            "home/me/a_b",
        ] {
            fs::create_dir_all(dir.path().join(path)).unwrap();
        }
        let resolve = |slug: &str| {
            resolve_project(slug, dir.path())
                .map(|p| p.strip_prefix(dir.path()).unwrap().to_path_buf())
        };
        assert_eq!(resolve("home-me-my-app"), Some("home/me/my-app".into()));
        assert_eq!(
            resolve("home-me-my-app-src"),
            Some("home/me/my-app/src".into())
        );
        assert_eq!(resolve("home-me-my"), Some("home/me/my".into()));
        assert_eq!(
            resolve("home-me-config-tool"),
            Some("home/me/.config/tool".into())
        );
        assert_eq!(resolve("home-me-a-b"), Some("home/me/a_b".into()));
        assert_eq!(resolve("home-me-gone"), None);
        assert_eq!(resolve("home-m"), None);
    }

    #[test]
    fn an_empty_transcript_imports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("projects/p/agent-transcripts/k/k.jsonl");
        write_rows(
            &path,
            &[json!({ "type": "turn_ended", "status": "success" })],
        );
        let (events, facts) = session(&path, None).unwrap();
        assert!(events.is_empty() && facts.is_none());
    }
}
