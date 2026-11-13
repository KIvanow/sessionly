//! Read a Claude Code session transcript for tokens, cost, models and timing.
//!
//! The transcript (`transcript_path` in every hook payload) is JSONL. The rows we
//! use (format is internal to Claude Code, verified against 2.1.302):
//! - `assistant`: `message.id`, `message.model`, `message.usage`. A response
//!   split into several content blocks is written as several rows with the same
//!   `message.id` and the same usage, so usage is counted once per message id.
//! - `cost-state`: Claude Code's own totals, written when the session ends.
//!   It covers the main thread plus all subagents.
//! - any row: `timestamp`, `gitBranch`, `version`, `entrypoint`.
//!
//! Subagents have their own transcripts in `<session>/subagents/agent-<id>.jsonl`
//! with a `.meta.json` next to each.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::pricing;

/// Token usage and estimated cost for one model.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Usage {
    /// API responses (unique message ids).
    pub requests: u64,
    pub input: u64,
    /// Includes thinking tokens.
    pub output: u64,
    pub thinking: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub cost_usd: f64,
    /// Requests whose model has no known price; `cost_usd` excludes them.
    pub unpriced_requests: u64,
}

impl Usage {
    /// Count one API response. Returns its estimated cost (0 if unpriced).
    fn add_message(&mut self, model: &str, usage: &Value) -> f64 {
        let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        let input = n(usage, "input_tokens");
        let output = n(usage, "output_tokens");
        let cache_read = n(usage, "cache_read_input_tokens");
        let (w5, w1) = match usage.get("cache_creation") {
            Some(cc) if cc.is_object() => (
                n(cc, "ephemeral_5m_input_tokens"),
                n(cc, "ephemeral_1h_input_tokens"),
            ),
            _ => (n(usage, "cache_creation_input_tokens"), 0),
        };
        self.requests += 1;
        self.input += input;
        self.output += output;
        self.thinking += usage
            .get("output_tokens_details")
            .map(|d| n(d, "thinking_tokens"))
            .unwrap_or(0);
        self.cache_read += cache_read;
        self.cache_write_5m += w5;
        self.cache_write_1h += w1;

        let prompt = input + cache_read + w5 + w1;
        match pricing::price_for(model, prompt) {
            Some(p) => {
                // Fast mode is billed at 2x the standard rate.
                let speed = if usage.get("speed").and_then(Value::as_str) == Some("fast") {
                    2.0
                } else {
                    1.0
                };
                let cost = speed
                    * (input as f64 * p.input
                        + output as f64 * p.output
                        + cache_read as f64 * p.cache_read
                        + w5 as f64 * p.cache_write_5m()
                        + w1 as f64 * p.cache_write_1h())
                    / 1e6;
                self.cost_usd += cost;
                cost
            }
            // `<synthetic>` messages carry no tokens: nothing to price.
            None if prompt + output == 0 => 0.0,
            None => {
                self.unpriced_requests += 1;
                0.0
            }
        }
    }

    fn merge(&mut self, other: &Usage) {
        self.requests += other.requests;
        self.input += other.input;
        self.output += other.output;
        self.thinking += other.thinking;
        self.cache_read += other.cache_read;
        self.cache_write_5m += other.cache_write_5m;
        self.cache_write_1h += other.cache_write_1h;
        self.cost_usd += other.cost_usd;
        self.unpriced_requests += other.unpriced_requests;
    }

    pub fn to_json(&self) -> Value {
        json!({
            "requests": self.requests,
            "input_tokens": self.input,
            "output_tokens": self.output,
            "thinking_tokens": self.thinking,
            "cache_read_tokens": self.cache_read,
            "cache_write_5m_tokens": self.cache_write_5m,
            "cache_write_1h_tokens": self.cache_write_1h,
            "estimated_cost_usd": self.cost_usd,
            "unpriced_requests": self.unpriced_requests,
        })
    }
}

pub type UsageByModel = BTreeMap<String, Usage>;

fn merge_into(target: &mut UsageByModel, source: &UsageByModel) {
    for (model, usage) in source {
        target.entry(model.clone()).or_default().merge(usage);
    }
}

/// One subagent's transcript.
#[derive(Debug, Default, Clone)]
pub struct Subagent {
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub usage: UsageByModel,
}

/// Claude Code's own totals from the `cost-state` row.
///
/// These cover only the latest run of the session (since `run_started_at`), not
/// earlier runs of a resumed session. They do include API calls that never
/// appear in the transcript (background calls such as titles or auto-mode
/// checks), so for that run they can be higher than the transcript estimate.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub total_cost_usd: f64,
    pub run_started_at: Option<DateTime<Utc>>,
    pub total_duration_ms: Option<u64>,
    pub api_duration_ms: Option<u64>,
    pub tool_duration_ms: Option<u64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
    /// `modelUsage` as written by Claude Code.
    pub model_usage: Value,
}

/// Where the session cost figure comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CostSource {
    /// Claude Code's recorded total covers every message in the transcript.
    Recorded,
    /// Recorded total for the latest run plus our estimate for earlier runs.
    RecordedAndEstimated,
    /// Our estimate from token counts only; misses background calls.
    Estimated,
    /// Estimate that leaves out requests to models without a known price.
    Partial,
}

impl CostSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            CostSource::Recorded => "recorded",
            CostSource::RecordedAndEstimated => "recorded_and_estimated",
            CostSource::Estimated => "estimated",
            CostSource::Partial => "partial_estimate",
        }
    }
}

/// Session cost and how it was put together.
#[derive(Debug, Clone, PartialEq)]
pub struct Cost {
    /// Best figure for the whole session.
    pub total_usd: f64,
    pub source: CostSource,
    /// Our estimate over every API response in the transcript.
    pub transcript_estimate_usd: f64,
    /// Spend in the recorded run that the transcript doesn't show (recorded
    /// total minus our estimate for that run, never negative). `None` when it
    /// can't be worked out: no recorded total, or a model without a known price.
    pub untracked_usd: Option<f64>,
}

#[derive(Debug, Default, Clone)]
pub struct TranscriptSummary {
    pub path: PathBuf,
    pub session_id: Option<String>,
    pub first_at: Option<DateTime<Utc>>,
    pub last_at: Option<DateTime<Utc>>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    pub entrypoint: Option<String>,
    /// Main-thread usage.
    pub main: UsageByModel,
    pub subagents: Vec<Subagent>,
    pub recorded: Option<Recorded>,
    /// Lines that weren't valid JSON (for example a partially written last line).
    pub skipped_lines: u64,
    /// Estimated cost of each API response, with its timestamp.
    message_costs: Vec<(Option<DateTime<Utc>>, f64)>,
}

impl TranscriptSummary {
    /// Main thread plus subagents.
    pub fn usage_by_model(&self) -> UsageByModel {
        let mut all = self.main.clone();
        for sub in &self.subagents {
            merge_into(&mut all, &sub.usage);
        }
        all
    }

    pub fn total_usage(&self) -> Usage {
        let mut total = Usage::default();
        for usage in self.usage_by_model().values() {
            total.merge(usage);
        }
        total
    }

    /// Best available session cost.
    ///
    /// Without a recorded total this is our transcript estimate. With one, the
    /// recorded run counts at the higher of Claude Code's total and our estimate
    /// for that run, and anything before the run is our estimate.
    pub fn cost(&self) -> Cost {
        let total = self.total_usage();
        let transcript = total.cost_usd;
        let Some(rec) = &self.recorded else {
            let source = if total.unpriced_requests > 0 {
                CostSource::Partial
            } else {
                CostSource::Estimated
            };
            return Cost {
                total_usd: transcript,
                source,
                transcript_estimate_usd: transcript,
                untracked_usd: None,
            };
        };
        let before_run: f64 = match rec.run_started_at {
            Some(start) => self
                .message_costs
                .iter()
                .filter(|(ts, _)| ts.is_none_or(|t| t < start))
                .map(|(_, c)| c)
                .sum(),
            None => 0.0,
        };
        let run_estimate = transcript - before_run;
        Cost {
            total_usd: before_run + rec.total_cost_usd.max(run_estimate),
            source: if before_run > 0.0 {
                CostSource::RecordedAndEstimated
            } else {
                CostSource::Recorded
            },
            transcript_estimate_usd: transcript,
            untracked_usd: (total.unpriced_requests == 0)
                .then(|| (rec.total_cost_usd - run_estimate).max(0.0)),
        }
    }

    pub fn duration_ms(&self) -> Option<i64> {
        Some((self.last_at? - self.first_at?).num_milliseconds())
    }

    pub fn to_json(&self) -> Value {
        let cost = self.cost();
        let by_model = |m: &UsageByModel| -> Value {
            m.iter()
                .map(|(model, usage)| (model.clone(), usage.to_json()))
                .collect::<serde_json::Map<_, _>>()
                .into()
        };
        json!({
            "session_id": self.session_id,
            "transcript_path": self.path,
            "first_at": self.first_at,
            "last_at": self.last_at,
            "duration_ms": self.duration_ms(),
            "git_branch": self.git_branch,
            "version": self.version,
            "entrypoint": self.entrypoint,
            "cost_usd": cost.total_usd,
            "cost_source": cost.source.as_str(),
            "transcript_estimate_usd": cost.transcript_estimate_usd,
            "untracked_usd": cost.untracked_usd,
            "total": self.total_usage().to_json(),
            "by_model": by_model(&self.usage_by_model()),
            "main_by_model": by_model(&self.main),
            "subagents": self.subagents.iter().map(|s| json!({
                "agent_id": s.agent_id,
                "agent_type": s.agent_type,
                "description": s.description,
                "by_model": by_model(&s.usage),
            })).collect::<Vec<_>>(),
            "recorded": self.recorded.as_ref().map(|r| json!({
                "total_cost_usd": r.total_cost_usd,
                "run_started_at": r.run_started_at,
                "total_duration_ms": r.total_duration_ms,
                "api_duration_ms": r.api_duration_ms,
                "tool_duration_ms": r.tool_duration_ms,
                "lines_added": r.lines_added,
                "lines_removed": r.lines_removed,
                "model_usage": r.model_usage,
            })),
            "skipped_lines": self.skipped_lines,
        })
    }
}

/// Parse a session transcript and its subagent transcripts.
pub fn parse(path: &Path) -> Result<TranscriptSummary> {
    let mut summary = TranscriptSummary {
        path: path.to_path_buf(),
        ..Default::default()
    };
    let mut seen = HashSet::new();
    let mut main = UsageByModel::new();
    scan(path, &mut summary, &mut seen, &mut main)?;
    summary.main = main;

    let subagent_dir = path.with_extension("").join("subagents");
    if let Ok(entries) = fs::read_dir(&subagent_dir) {
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect();
        files.sort();
        for file in files {
            let mut usage = UsageByModel::new();
            scan(&file, &mut summary, &mut seen, &mut usage)?;
            let stem = file
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let meta: Value = fs::read_to_string(file.with_extension("meta.json"))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(Value::Null);
            let text = |k: &str| meta.get(k).and_then(Value::as_str).map(String::from);
            summary.subagents.push(Subagent {
                agent_id: stem.strip_prefix("agent-").unwrap_or(&stem).to_string(),
                agent_type: text("agentType"),
                description: text("description"),
                usage,
            });
        }
    }
    Ok(summary)
}

fn scan(
    path: &Path,
    summary: &mut TranscriptSummary,
    seen: &mut HashSet<String>,
    usage: &mut UsageByModel,
) -> Result<()> {
    let file = fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            summary.skipped_lines += 1;
            continue;
        };
        let text = |k: &str| {
            row.get(k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(String::from)
        };
        if summary.session_id.is_none() {
            summary.session_id = text("sessionId");
        }
        if summary.git_branch.is_none() {
            summary.git_branch = text("gitBranch");
        }
        if summary.version.is_none() {
            summary.version = text("version");
        }
        if summary.entrypoint.is_none() {
            summary.entrypoint = text("entrypoint");
        }
        let row_ts = row
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc));
        if let Some(ts) = row_ts {
            summary.first_at = Some(summary.first_at.map_or(ts, |f| f.min(ts)));
            summary.last_at = Some(summary.last_at.map_or(ts, |l| l.max(ts)));
        }
        match row.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let message = &row["message"];
                let (Some(id), Some(u)) = (message["id"].as_str(), message.get("usage")) else {
                    continue;
                };
                if !seen.insert(id.to_string()) {
                    continue;
                }
                let model = message["model"].as_str().unwrap_or("unknown");
                let cost = usage
                    .entry(model.to_string())
                    .or_default()
                    .add_message(model, u);
                summary.message_costs.push((row_ts, cost));
            }
            Some("cost-state") => {
                let n = |k: &str| row.get(k).and_then(Value::as_u64);
                if let Some(total) = row.get("totalCostUSD").and_then(Value::as_f64) {
                    summary.recorded = Some(Recorded {
                        total_cost_usd: total,
                        run_started_at: row
                            .get("startTime")
                            .and_then(Value::as_i64)
                            .and_then(DateTime::from_timestamp_millis),
                        total_duration_ms: n("totalDuration"),
                        api_duration_ms: n("totalAPIDuration"),
                        tool_duration_ms: n("totalToolDuration"),
                        lines_added: n("totalLinesAdded"),
                        lines_removed: n("totalLinesRemoved"),
                        model_usage: row.get("modelUsage").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, or `~/.claude`.
pub fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().join(".claude"))
}

/// Find a session's transcript: first from our raw capture (hook payloads carry
/// `transcript_path`), then by scanning Claude Code's projects directory. A
/// unique prefix of the session id is enough.
pub fn find(session_id: &str, raw_dir: &Path) -> Option<PathBuf> {
    find_in(session_id, raw_dir, &claude_config_dir().join("projects"))
}

fn find_in(session_id: &str, raw_dir: &Path, projects: &Path) -> Option<PathBuf> {
    let stem = crate::capture::file_stem(Some(session_id));
    if let Ok(file) = fs::File::open(raw_dir.join(format!("{stem}.jsonl"))) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Some(path) = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|r| r["payload"]["transcript_path"].as_str().map(PathBuf::from))
                .filter(|p| p.exists())
            {
                return Some(path);
            }
        }
    }
    let mut matches: Vec<PathBuf> = fs::read_dir(projects)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|project| fs::read_dir(project.path()).ok())
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|x| x == "jsonl")
                && p.file_stem()
                    .is_some_and(|s| s.to_string_lossy().starts_with(&stem))
        })
        .collect();
    if let Some(exact) = matches
        .iter()
        .find(|p| p.file_stem().is_some_and(|s| *s == *stem))
    {
        return Some(exact.clone());
    }
    (matches.len() == 1).then(|| matches.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn assistant(id: &str, model: &str, usage: Value, ts: &str) -> Value {
        json!({
            "type": "assistant", "sessionId": "s1", "timestamp": ts,
            "gitBranch": "main", "version": "2.1.302", "entrypoint": "cli",
            "message": { "id": id, "model": model, "usage": usage }
        })
    }

    fn usage(input: u64, output: u64, read: u64, w5: u64, w1: u64) -> Value {
        json!({
            "input_tokens": input, "output_tokens": output,
            "cache_read_input_tokens": read, "cache_creation_input_tokens": w5 + w1,
            "cache_creation": { "ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1 },
            "output_tokens_details": { "thinking_tokens": 3 }
        })
    }

    fn write_jsonl(path: &Path, rows: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        for r in rows {
            writeln!(f, "{r}").unwrap();
        }
    }

    fn fixture(with_cost_state: bool) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s1.jsonl");
        let mut rows = vec![
            json!({ "type": "user", "sessionId": "s1", "timestamp": "2026-11-13T10:00:00.000Z" }),
            assistant(
                "m1",
                "claude-opus-5-5",
                usage(10, 100, 1_000_000, 0, 1_000_000),
                "2026-11-13T10:00:01.000Z",
            ),
            // same message, second content block: must not be counted twice
            assistant(
                "m1",
                "claude-opus-5-5",
                usage(10, 100, 1_000_000, 0, 1_000_000),
                "2026-11-13T10:00:01.500Z",
            ),
            assistant(
                "m2",
                "<synthetic>",
                usage(0, 0, 0, 0, 0),
                "2026-11-13T10:00:02.000Z",
            ),
        ];
        rows.push(json!("not an object"));
        if with_cost_state {
            rows.push(
                json!({ "type": "cost-state", "totalCostUSD": 12.5, "totalDuration": 61000,
                              "totalLinesAdded": 4, "modelUsage": { "claude-opus-5-5": {} } }),
            );
        }
        write_jsonl(&main, &rows);
        fs::OpenOptions::new()
            .append(true)
            .open(&main)
            .unwrap()
            .write_all(b"{\"truncated\n")
            .unwrap();
        let sub = dir.path().join("s1/subagents/agent-abc.jsonl");
        write_jsonl(
            &sub,
            &[assistant(
                "m3",
                "claude-haiku-5-5",
                usage(1_000, 2_000, 0, 1_000, 0),
                "2026-11-13T10:01:00.000Z",
            )],
        );
        fs::write(
            dir.path().join("s1/subagents/agent-abc.meta.json"),
            r#"{"agentType":"Explore","description":"look around"}"#,
        )
        .unwrap();
        (dir, main)
    }

    #[test]
    fn counts_each_message_once_and_includes_subagents() {
        let (_dir, path) = fixture(false);
        let s = parse(&path).unwrap();
        let opus = &s.main["claude-opus-5-5"];
        assert_eq!(opus.requests, 1);
        assert_eq!(opus.output, 100);
        assert_eq!(opus.thinking, 3);
        assert_eq!(s.subagents.len(), 1);
        assert_eq!(s.subagents[0].agent_id, "abc");
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("Explore"));
        assert_eq!(s.total_usage().requests, 3);
        assert_eq!(s.skipped_lines, 1);
        assert_eq!(s.session_id.as_deref(), Some("s1"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        assert_eq!(s.duration_ms(), Some(60_000));
    }

    #[test]
    fn estimates_cost_from_prices() {
        let (_dir, path) = fixture(false);
        let s = parse(&path).unwrap();
        // opus 5.5: 10*$4 + 100*$20 + 1M*$0.20 + 1M*$8 (1h write), per MTok
        let opus = (10.0 * 4.0 + 100.0 * 20.0) / 1e6 + 0.20 + 8.0;
        assert!((s.main["claude-opus-5-5"].cost_usd - opus).abs() < 1e-9);
        // haiku 5.5: 1000*$0.10 + 2000*$0.50 + 1000*$0.125 (5m write)
        let haiku = (1000.0 * 0.10 + 2000.0 * 0.50 + 1000.0 * 0.125) / 1e6;
        let cost = s.cost();
        // the <synthetic> message has no price but also no tokens
        assert_eq!(cost.source, CostSource::Estimated);
        assert!((cost.total_usd - (opus + haiku)).abs() < 1e-9);
        assert_eq!(cost.untracked_usd, None);
    }

    const OPUS: f64 = (10.0 * 4.0 + 100.0 * 20.0) / 1e6 + 0.20 + 8.0;
    const HAIKU: f64 = (1000.0 * 0.10 + 2000.0 * 0.50 + 1000.0 * 0.125) / 1e6;

    fn append_cost_state(path: &Path, total: f64, start: Option<&str>) {
        let mut row = json!({ "type": "cost-state", "totalCostUSD": total });
        if let Some(start) = start {
            let ms = DateTime::parse_from_rfc3339(start)
                .unwrap()
                .timestamp_millis();
            row["startTime"] = json!(ms);
        }
        writeln!(
            fs::OpenOptions::new().append(true).open(path).unwrap(),
            "{row}"
        )
        .unwrap();
    }

    #[test]
    fn recorded_total_covers_background_calls() {
        let (_dir, path) = fixture(true);
        let s = parse(&path).unwrap();
        let cost = s.cost();
        // no startTime: the recorded run covers the whole transcript
        assert_eq!(cost.source, CostSource::Recorded);
        assert_eq!(cost.total_usd, 12.5);
        assert!((cost.untracked_usd.unwrap() - (12.5 - OPUS - HAIKU)).abs() < 1e-9);
        let rec = s.recorded.unwrap();
        assert_eq!(rec.total_duration_ms, Some(61_000));
        assert_eq!(rec.lines_added, Some(4));
    }

    #[test]
    fn earlier_runs_are_estimated() {
        // The latest run started after the opus message: only the subagent's
        // haiku message falls inside it.
        let (_dir, path) = fixture(false);
        append_cost_state(&path, 1.0, Some("2026-11-13T10:00:30Z"));
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::RecordedAndEstimated);
        assert!((cost.total_usd - (OPUS + 1.0)).abs() < 1e-9);
        assert!((cost.untracked_usd.unwrap() - (1.0 - HAIKU)).abs() < 1e-9);
    }

    #[test]
    fn recorded_run_never_counts_below_transcript() {
        let (_dir, path) = fixture(false);
        append_cost_state(&path, 0.0, Some("2026-11-13T10:00:30Z"));
        let cost = parse(&path).unwrap().cost();
        assert!((cost.total_usd - (OPUS + HAIKU)).abs() < 1e-9);
        assert_eq!(cost.untracked_usd, Some(0.0));
    }

    #[test]
    fn unknown_model_makes_estimate_partial() {
        let (_dir, path) = fixture(false);
        let row = assistant(
            "m9",
            "claude-future-9",
            usage(5, 5, 0, 0, 0),
            "2026-11-13T10:00:03.000Z",
        );
        writeln!(
            fs::OpenOptions::new().append(true).open(&path).unwrap(),
            "{row}"
        )
        .unwrap();
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::Partial);
        // and with a recorded total, the untracked share can't be known
        append_cost_state(&path, 20.0, None);
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::Recorded);
        assert_eq!(cost.untracked_usd, None);
    }

    #[test]
    fn fast_mode_costs_double() {
        let mut normal = Usage::default();
        normal.add_message("claude-opus-5-5", &json!({ "output_tokens": 1000 }));
        let mut fast = Usage::default();
        fast.add_message(
            "claude-opus-5-5",
            &json!({ "output_tokens": 1000, "speed": "fast" }),
        );
        assert!((fast.cost_usd - 2.0 * normal.cost_usd).abs() < 1e-12);
    }

    #[test]
    fn finds_transcript_via_raw_capture() {
        let (dir, path) = fixture(false);
        let raw = dir.path().join("raw");
        write_jsonl(
            &raw.join("s1.jsonl"),
            &[json!({ "payload": { "transcript_path": path } })],
        );
        assert_eq!(find_in("s1", &raw, &dir.path().join("none")), Some(path));
    }

    #[test]
    fn finds_transcript_by_unique_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        let a = projects.join("p1/aaaa1111-x.jsonl");
        write_jsonl(&a, &[json!({})]);
        write_jsonl(&projects.join("p2/aaaa2222-y.jsonl"), &[json!({})]);
        let raw = dir.path().join("raw");
        assert_eq!(find_in("aaaa1", &raw, &projects), Some(a.clone()));
        assert_eq!(find_in("aaaa1111-x", &raw, &projects), Some(a));
        assert_eq!(find_in("aaaa", &raw, &projects), None); // ambiguous
        assert_eq!(find_in("zzzz", &raw, &projects), None);
    }
}
