//! What Cursor tells hooks about a session and leaves out of its transcripts:
//! exactly when a prompt was sent and its turn ended, how long each tool call
//! took, the model, and the tokens each turn used.
//!
//! Cursor runs the hooks in `~/.claude/settings.json` under its own event
//! names (`beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `stop`). The
//! events of one turn share a `generation_id`. Checked with Cursor 3.27.
//!
//! A cloud agent is different in three ways (checked 2026-11-14). It keeps no
//! transcript, so its hooks are all there is. The events of one turn do not
//! share an id: the prompt has one, the tool calls another, the end a third,
//! so they are taken in the order they came. And `stop` has no tokens. Its
//! hooks come from the repository's `.cursor/hooks.json`, which can also ask
//! for `afterFileEdit`: what an edit changed. What a shell command changed
//! is not said by any hook: the capture works it out (see `changes`).

use std::collections::HashMap;
use std::path::Path;

use crate::pricing;
use crate::session::{Cost, CostSource, ModelUsage};
use chrono::{DateTime, Utc};
use serde_json::Value;

/// One tool call as the hooks saw it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Tool {
    pub id: String,
    /// Cursor's own name for the tool, as in its transcripts.
    pub name: String,
    /// What it was called with, as the hooks were told.
    pub input: Value,
    pub at: DateTime<Utc>,
    pub duration_ms: Option<u64>,
    /// Set if the call failed.
    pub error: Option<String>,
    /// What a shell command changed in the working tree, as the capture
    /// stored it with the call's end (see `changes`). Null if nothing.
    pub changed: Value,
}

/// Tokens of one turn. Cursor's `input_tokens` counts cached tokens too;
/// `input` here is what was neither read from nor written to the cache.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// What one edit changed in a file, as `afterFileEdit` reports it.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct FileEdit {
    pub path: String,
    pub at: DateTime<Utc>,
    /// Each change as the text before and after.
    pub changes: Vec<(String, String)>,
}

/// One turn: a prompt, the tool calls it led to, and how it ended.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Turn {
    pub prompt: String,
    pub at: DateTime<Utc>,
    /// Null if the hooks did not see the turn end.
    pub ended_at: Option<DateTime<Utc>>,
    /// Set if the turn ended in an error.
    pub error: Option<String>,
    pub model: Option<String>,
    pub tokens: Option<Tokens>,
    pub tools: Vec<Tool>,
    /// File edits, where the hooks were told of them.
    pub edits: Vec<FileEdit>,
    /// Whether the turn has been paired with a prompt in the transcript.
    pub matched: bool,
}

/// What the hooks captured of one session.
#[derive(Debug, Default, PartialEq)]
pub struct Capture {
    /// In the order the prompts were sent.
    pub turns: Vec<Turn>,
    pub cursor_version: Option<String>,
    /// The folder the session worked in. A chat in a window with no folder
    /// open has none.
    pub cwd: Option<String>,
    /// When the hooks first and last heard from the session.
    pub first_at: Option<DateTime<Utc>>,
    pub last_at: Option<DateTime<Utc>>,
    /// What Cursor's cloud said about the session, if it ran there.
    pub runtime: Option<crate::runtime::Seen>,
}

/// Read a raw hook capture. A turn whose prompt the hooks did not see (they
/// were installed while it ran) is left out.
pub fn read(capture: &Path) -> Capture {
    let mut out = Capture::default();
    let mut by_generation: HashMap<String, usize> = HashMap::new();
    // A capture that can't be read adds nothing: the transcript still counts.
    let _ = crate::jsonl::for_each(capture, |record| {
        let p = &record["payload"];
        let text = |key: &str| p[key].as_str().filter(|v| !v.is_empty()).map(String::from);
        let at = record["received_at"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc));
        let Some(at) = at else { return };
        crate::runtime::Seen::note(&mut out.runtime, &record);
        out.first_at = Some(out.first_at.map_or(at, |first| first.min(at)));
        out.last_at = Some(out.last_at.map_or(at, |last| last.max(at)));
        if let Some(version) = text("cursor_version") {
            out.cursor_version = Some(version);
        }
        if out.cwd.is_none() {
            out.cwd = p["workspace_roots"][0].as_str().map(String::from);
        }
        // The events of a turn carry its generation; a session starting has
        // none. In the cloud the events of a turn carry ids of their own, so
        // there they are not gone by: an event belongs to the prompt before it.
        let in_cloud = record["runtime"]["kind"] == "cloud";
        let generation = text("generation_id");
        if generation.is_none() && !in_cloud {
            return;
        }
        let model = text("model_id").or_else(|| text("model"));
        let hook = record["hook"].as_str().unwrap_or_default().to_lowercase();
        if hook == "beforesubmitprompt" {
            if let Some(generation) = generation {
                by_generation.insert(generation, out.turns.len());
            }
            out.turns.push(Turn {
                prompt: text("prompt").unwrap_or_default(),
                at,
                model,
                ..Default::default()
            });
            return;
        }
        let known = generation.and_then(|id| by_generation.get(&id).copied());
        // A cloud agent's hooks are all there is of its session. If its
        // prompt was not captured (the hook that carried it did not get to
        // finish), what followed is still a turn, with its prompt unknown.
        if in_cloud && out.turns.is_empty() {
            out.turns.push(Turn {
                at,
                model: model.clone(),
                ..Default::default()
            });
        }
        let latest = out.turns.len().checked_sub(1);
        let Some(turn) = known
            .or(latest.filter(|_| in_cloud))
            .and_then(|i| out.turns.get_mut(i))
        else {
            return;
        };
        match hook.as_str() {
            "afterfileedit" => {
                let changes = p["edits"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|edit| {
                        let side = |key: &str| edit[key].as_str().unwrap_or_default().to_string();
                        (side("old_string"), side("new_string"))
                    })
                    .collect();
                if let Some(path) = text("file_path") {
                    turn.edits.push(FileEdit { path, at, changes });
                }
            }
            "pretooluse" => turn.tools.push(Tool {
                id: text("tool_use_id").unwrap_or_default(),
                name: text("tool_name").unwrap_or_default(),
                input: p["tool_input"].clone(),
                at,
                ..Default::default()
            }),
            "posttooluse" | "posttoolusefailure" => {
                let id = text("tool_use_id").unwrap_or_default();
                if let Some(tool) = turn.tools.iter_mut().rev().find(|t| t.id == id) {
                    tool.duration_ms = p["duration"]
                        .as_f64()
                        .map(|ms| ms.max(0.0).round() as u64)
                        .or(Some((at - tool.at).num_milliseconds().max(0) as u64));
                    if hook == "posttoolusefailure" {
                        let said = text("error_message").or_else(|| text("error"));
                        tool.error = Some(said.unwrap_or_else(|| "failed".into()));
                    }
                    if record["changes"].is_array() {
                        tool.changed = record["changes"].clone();
                    }
                }
            }
            // A turn that is made to go on stops again: the last stop counts.
            "stop" => {
                turn.ended_at = Some(at);
                turn.model = model.or(turn.model.take());
                turn.error = (p["status"] == "error")
                    .then(|| text("error_message").unwrap_or_else(|| "error".into()));
                let n = |key: &str| p[key].as_u64();
                if let (Some(input), Some(output)) = (n("input_tokens"), n("output_tokens")) {
                    let cache_read = n("cache_read_tokens").unwrap_or(0);
                    let cache_write = n("cache_write_tokens").unwrap_or(0);
                    turn.tokens = Some(Tokens {
                        input: input.saturating_sub(cache_read + cache_write),
                        output,
                        cache_read,
                        cache_write,
                    });
                }
            }
            _ => {}
        }
    });
    out
}

/// Tokens per model over the turns the hooks saw end, and what they would
/// cost at API list prices. That is an estimate of the work done, not what
/// Cursor bills: a subscription is not priced per token. `prompts` is how
/// many prompts the whole session has.
///
/// A model's `requests` counts turns here: Cursor reports tokens per turn,
/// not per request.
pub fn usage(turns: &[Turn], prompts: u64) -> (Vec<ModelUsage>, Option<Cost>) {
    let mut by_model: Vec<ModelUsage> = Vec::new();
    let (mut covered, mut unpriced, mut total) = (0u64, 0u64, 0f64);
    for turn in turns {
        let Some(tokens) = turn.tokens else { continue };
        covered += 1;
        let model = turn.model.clone().unwrap_or_else(|| "unknown".into());
        let i = by_model
            .iter()
            .position(|u| u.model == model)
            .unwrap_or_else(|| {
                by_model.push(ModelUsage {
                    model: model.clone(),
                    ..Default::default()
                });
                by_model.len() - 1
            });
        let entry = &mut by_model[i];
        entry.requests += 1;
        entry.input_tokens += tokens.input;
        entry.output_tokens += tokens.output;
        entry.cache_read_tokens += tokens.cache_read;
        // How long Cursor asks for a cache entry to live is not reported.
        entry.cache_write_5m_tokens += tokens.cache_write;
        match pricing::price_for(&model, 0) {
            Some(p) => {
                let cost = (tokens.input as f64 * p.input
                    + tokens.output as f64 * p.output
                    + tokens.cache_read as f64 * p.cache_read
                    + tokens.cache_write as f64 * p.cache_write_5m())
                    / 1e6;
                entry.estimated_cost_usd = Some(entry.estimated_cost_usd.unwrap_or(0.0) + cost);
                total += cost;
            }
            None => unpriced += 1,
        }
    }
    by_model.sort_by_key(|u| std::cmp::Reverse(u.requests));
    // Tokens alone, all on models without a known price, give no figure.
    let cost = (covered > unpriced).then_some(Cost {
        total_usd: total,
        source: if unpriced > 0 {
            CostSource::PartialEstimate
        } else {
            CostSource::Estimated
        },
        transcript_estimate_usd: total,
        unpriced_requests: unpriced,
        untracked_usd: None,
        prompts_covered: (covered < prompts).then_some(covered),
    });
    (by_model, cost)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::Write;

    pub(crate) fn event(second: u32, hook: &str, generation: &str, payload: Value) -> Value {
        let mut payload = payload;
        payload["generation_id"] = json!(generation);
        payload["cursor_version"] = json!("3.27.22");
        json!({
            "v": 1, "source": "cursor", "hook": hook,
            "received_at": format!("2026-11-13T21:59:{second:02}.500Z"),
            "payload": payload,
        })
    }

    pub(crate) fn write(path: &Path, events: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        for e in events {
            writeln!(f, "{e}").unwrap();
        }
    }

    #[test]
    fn reads_turns_tools_and_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.jsonl");
        write(
            &path,
            &[
                // the hooks were installed while this turn ran: no prompt was seen
                event(
                    1,
                    "postToolUse",
                    "g0",
                    json!({ "tool_use_id": "t0", "tool_name": "Read" }),
                ),
                event(
                    2,
                    "stop",
                    "g0",
                    json!({ "status": "completed", "input_tokens": 9, "output_tokens": 9 }),
                ),
                event(
                    10,
                    "beforeSubmitPrompt",
                    "g1",
                    json!({ "prompt": "which are open?", "model": "claude-opus-5-5-medium", "model_id": "claude-opus-5-5" }),
                ),
                event(
                    12,
                    "preToolUse",
                    "g1",
                    json!({ "tool_use_id": "t1", "tool_name": "Shell", "model": "claude-opus-5-5" }),
                ),
                event(
                    16,
                    "postToolUse",
                    "g1",
                    json!({ "tool_use_id": "t1", "tool_name": "Shell", "duration": 3503.204, "tool_output": "secret output" }),
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
                    json!({ "tool_use_id": "t2", "tool_name": "Read", "error_message": "no such file" }),
                ),
                event(
                    30,
                    "stop",
                    "g1",
                    json!({ "status": "completed", "model_id": "claude-opus-5-5",
                    "input_tokens": 352_317, "output_tokens": 1_256, "cache_read_tokens": 185_983, "cache_write_tokens": 166_328 }),
                ),
                event(
                    40,
                    "beforeSubmitPrompt",
                    "g2",
                    json!({ "prompt": "and now?", "model": "gpt-9" }),
                ),
                event(
                    41,
                    "stop",
                    "g2",
                    json!({ "status": "error", "input_tokens": 100, "output_tokens": 10 }),
                ),
                event(
                    50,
                    "beforeSubmitPrompt",
                    "g3",
                    json!({ "prompt": "still running" }),
                ),
            ],
        );
        let capture = read(&path);
        assert_eq!(capture.cursor_version.as_deref(), Some("3.27.22"));
        let prompts: Vec<&str> = capture.turns.iter().map(|t| t.prompt.as_str()).collect();
        assert_eq!(prompts, ["which are open?", "and now?", "still running"]);

        let first = &capture.turns[0];
        assert_eq!(first.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!((first.ended_at.unwrap() - first.at).num_seconds(), 20);
        assert_eq!(
            first.tokens,
            Some(Tokens {
                input: 6,
                output: 1_256,
                cache_read: 185_983,
                cache_write: 166_328
            })
        );
        let tools: Vec<_> = first
            .tools
            .iter()
            .map(|t| (t.name.as_str(), t.duration_ms, t.error.as_deref()))
            .collect();
        assert_eq!(
            tools,
            [
                ("Shell", Some(3_503), None),
                ("Read", Some(1_000), Some("no such file"))
            ]
        );
        assert_eq!(capture.turns[1].error.as_deref(), Some("error"));
        assert!(capture.turns[2].ended_at.is_none() && capture.turns[2].tokens.is_none());

        // a missing capture is no capture
        assert_eq!(read(&dir.path().join("none.jsonl")), Capture::default());
    }

    #[test]
    fn reads_the_folder_the_times_and_what_tools_were_called_with() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.jsonl");
        write(
            &path,
            &[
                // a session starting belongs to no turn, and a chat in a window
                // with no folder open names no folder
                event(1, "sessionStart", "", json!({ "workspace_roots": [] })),
                event(
                    2,
                    "beforeSubmitPrompt",
                    "g1",
                    json!({ "prompt": "find it", "workspace_roots": ["/w/repo"] }),
                ),
                event(
                    3,
                    "preToolUse",
                    "g1",
                    json!({ "tool_use_id": "t1", "tool_name": "Read", "tool_input": { "file_path": "a.rs" } }),
                ),
            ],
        );
        let capture = read(&path);
        assert_eq!(capture.cwd.as_deref(), Some("/w/repo"));
        let second = |t: Option<DateTime<Utc>>| t.unwrap().format("%S").to_string();
        assert_eq!(
            (second(capture.first_at), second(capture.last_at)),
            ("01".to_string(), "03".to_string())
        );
        assert_eq!(capture.turns.len(), 1);
        assert_eq!(
            capture.turns[0].tools[0].input,
            json!({ "file_path": "a.rs" })
        );
    }

    #[test]
    fn estimates_cost_for_the_turns_seen() {
        let turn = |model: &str, tokens: Tokens| Turn {
            model: Some(model.into()),
            tokens: Some(tokens),
            ..Default::default()
        };
        let opus = Tokens {
            input: 6,
            output: 1_256,
            cache_read: 185_983,
            cache_write: 166_328,
        };
        let turns = [
            turn("claude-opus-5-5", opus),
            turn(
                "claude-opus-5-5",
                Tokens {
                    input: 1_000_000,
                    ..Default::default()
                },
            ),
            turn(
                "gpt-9",
                Tokens {
                    input: 100,
                    output: 10,
                    ..Default::default()
                },
            ),
            Turn::default(),
        ];
        let (by_model, cost) = usage(&turns, 13);
        assert_eq!(by_model.len(), 2);
        assert_eq!(
            (by_model[0].model.as_str(), by_model[0].requests),
            ("claude-opus-5-5", 2)
        );
        assert_eq!(by_model[0].input_tokens, 1_000_006);
        assert_eq!(by_model[0].cache_write_5m_tokens, 166_328);
        // $4 in, $20 out, $0.20 cache read, $5 cache write per million
        let first = (6.0 * 4.0 + 1_256.0 * 20.0 + 185_983.0 * 0.2 + 166_328.0 * 5.0) / 1e6;
        let cost = cost.unwrap();
        assert!((cost.total_usd - (first + 4.0)).abs() < 1e-9);
        assert_eq!(by_model[0].estimated_cost_usd, Some(cost.total_usd));
        assert_eq!(by_model[1].estimated_cost_usd, None);
        assert_eq!(cost.source, CostSource::PartialEstimate);
        assert_eq!((cost.unpriced_requests, cost.prompts_covered), (1, Some(3)));

        // every prompt covered and priced: a plain estimate
        let (_, all) = usage(&turns[..2], 2);
        let all = all.unwrap();
        assert_eq!(
            (all.source, all.prompts_covered),
            (CostSource::Estimated, None)
        );
        // nothing with a known price, or nothing seen: no figure
        assert_eq!(usage(&turns[2..], 2).1, None);
        assert_eq!(usage(&[], 2), (Vec::new(), None));
    }
}
