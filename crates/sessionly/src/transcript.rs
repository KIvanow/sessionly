//! Read a Claude Code session transcript for tokens, cost, models and timing.
//!
//! The transcript (`transcript_path` in every hook payload) is JSONL. The rows we
//! use (format is internal to Claude Code, verified against 2.1.302):
//! - `assistant`: `message.id`, `message.model`, `message.usage`. A response is
//!   written as several rows with the same `message.id`. Early rows can carry
//!   placeholder token counts; the last row has the final ones, so the last
//!   row per id is the one counted.
//! - `cost-state`: Claude Code's own totals for the current run of the session
//!   (since `startTime`), rewritten as the run goes on. It covers the main
//!   thread plus all subagents, and API calls that never reach the transcript.
//! - any row: `timestamp`, `gitBranch`, `version`, `entrypoint`.
//!
//! Subagents have their own transcripts in `<session>/subagents/agent-<id>.jsonl`
//! with a `.meta.json` next to each.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::pricing;
use crate::session;

/// Float noise allowed when comparing a recorded total with our estimate.
const CENT_FRACTION: f64 = 1e-6;

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
    /// Requests that used tokens on a model with no known price; `cost_usd`
    /// excludes them.
    pub unpriced_requests: u64,
}

impl Usage {
    /// Count one API response. Returns its estimated cost, or `None` if it
    /// used tokens on a model we can't price.
    fn add_message(&mut self, model: &str, usage: &Value) -> Option<f64> {
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
        let billed = pricing::Billed {
            input,
            output,
            cache_read,
            cache_write_short: w5,
            cache_write_long: w1,
        };
        match pricing::price_for(model, prompt).map(|p| p.cost(&billed)) {
            Some(cost) => {
                // Fast mode is billed at 2x the standard rate.
                let speed = if usage.get("speed").and_then(Value::as_str) == Some("fast") {
                    2.0
                } else {
                    1.0
                };
                let cost = speed * cost;
                self.cost_usd += cost;
                Some(cost)
            }
            // `<synthetic>` messages carry no tokens: nothing to price.
            None if prompt + output == 0 => Some(0.0),
            None => {
                self.unpriced_requests += 1;
                None
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

    /// `None` when none of the requests could be priced.
    fn priced_cost(&self) -> Option<f64> {
        (self.unpriced_requests < self.requests).then_some(self.cost_usd)
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
    /// How many findings its last reply names (see `reviews::findings_in`).
    pub findings: Option<u64>,
}

/// Claude Code's own totals from the last `cost-state` row.
///
/// They cover one run of the session: from `run_started_at` until the row was
/// written (`recorded_until`). Messages before or after that window are not in
/// the total. Inside the window the total also includes API calls that never
/// appear in the transcript, so it can be higher than the transcript estimate.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub total_cost_usd: f64,
    pub run_started_at: Option<DateTime<Utc>>,
    /// Timestamp of the last transcript row written before the cost-state row.
    pub recorded_until: Option<DateTime<Utc>>,
    pub total_duration_ms: Option<u64>,
    pub api_duration_ms: Option<u64>,
    pub tool_duration_ms: Option<u64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
    /// `modelUsage` as written by Claude Code.
    pub model_usage: Value,
}

pub use crate::session::CostSource;

/// Session cost and how it was put together.
#[derive(Debug, Clone, PartialEq)]
pub struct Cost {
    /// Best figure for the whole session.
    pub total_usd: f64,
    pub source: CostSource,
    /// Our estimate over every API response in the transcript.
    pub transcript_estimate_usd: f64,
    /// Requests the total leaves out: on a model without a known price and
    /// outside the recorded run.
    pub unpriced_requests: u64,
    /// Spend in the recorded run that the transcript doesn't show (recorded
    /// total minus our estimate for that run, never negative). `None` when it
    /// can't be worked out: no recorded total, or a model without a known price.
    pub untracked_usd: Option<f64>,
    /// `total_usd` by the branch checked out when it was spent, in name
    /// order (see `session::Cost::by_branch`). Empty when no response has
    /// an estimate to share it out by.
    pub by_branch: Vec<session::BranchCost>,
}

/// One API response, as needed to place it inside or outside the recorded run.
#[derive(Debug, Clone)]
struct Message {
    at: Option<DateTime<Utc>>,
    /// `None` if the model has no known price.
    cost: Option<f64>,
    /// The branch its row names: the one checked out when it was made.
    branch: Option<String>,
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
    /// The model behind each tool call, by tool use id, subagents included.
    pub tool_models: HashMap<String, String>,
    /// Typed review commands that forked a subagent to run in.
    pub review_launches: Vec<ReviewLaunch>,
    /// Efforts Claude Code said it reused for a review typed without one.
    pub reused_efforts: Vec<ReusedEffort>,
    /// What the main thread's last reply to a typed review says it found.
    pub review_replies: Vec<ReviewSaid>,
    messages: Vec<Message>,
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
    /// for that run, and messages before or after the run are our estimate.
    pub fn cost(&self) -> Cost {
        let total = self.total_usage();
        let transcript = total.cost_usd;
        let Some(rec) = &self.recorded else {
            let source = if total.unpriced_requests > 0 {
                CostSource::PartialEstimate
            } else {
                CostSource::Estimated
            };
            return Cost {
                total_usd: transcript,
                source,
                transcript_estimate_usd: transcript,
                unpriced_requests: total.unpriced_requests,
                untracked_usd: None,
                by_branch: self.by_branch(transcript),
            };
        };
        // A message without a timestamp can't be placed, so it counts as part
        // of the recorded run rather than being added on top of it.
        let outside_run = |m: &&Message| {
            m.at.is_some_and(|at| {
                rec.run_started_at.is_some_and(|start| at < start)
                    || rec.recorded_until.is_some_and(|until| at > until)
            })
        };
        let outside: Vec<&Message> = self.messages.iter().filter(outside_run).collect();
        let outside_cost: f64 = outside.iter().filter_map(|m| m.cost).sum();
        let outside_unpriced = outside.iter().filter(|m| m.cost.is_none()).count() as u64;
        let run_estimate = transcript - outside_cost;
        let run_unpriced = total.unpriced_requests - outside_unpriced;
        let recorded_wins = rec.total_cost_usd + CENT_FRACTION >= run_estimate;
        let total_usd = outside_cost + rec.total_cost_usd.max(run_estimate);
        Cost {
            total_usd,
            source: if outside.is_empty() && recorded_wins {
                CostSource::Recorded
            } else {
                CostSource::RecordedAndEstimated
            },
            transcript_estimate_usd: transcript,
            unpriced_requests: outside_unpriced,
            untracked_usd: (run_unpriced == 0)
                .then(|| (rec.total_cost_usd - run_estimate).max(0.0)),
            by_branch: self.by_branch(total_usd),
        }
    }

    /// `total_usd` shared out between the branches the responses were made
    /// on, as their estimates are: what the agent recorded beyond them is
    /// spread the same way. A response on a model without a known price
    /// adds nothing to its branch's share.
    fn by_branch(&self, total_usd: f64) -> Vec<session::BranchCost> {
        let mut estimates: BTreeMap<Option<&str>, f64> = BTreeMap::new();
        for message in &self.messages {
            if let Some(cost) = message.cost {
                *estimates.entry(message.branch.as_deref()).or_default() += cost;
            }
        }
        let all: f64 = estimates.values().sum();
        if all <= 0.0 {
            return Vec::new();
        }
        estimates
            .into_iter()
            .map(|(branch, estimate)| session::BranchCost {
                branch: branch.map(String::from),
                // To a millionth of a dollar: the same transcript gives the same upload.
                usd: (total_usd * estimate / all * 1e6).round() / 1e6,
            })
            .collect()
    }

    pub fn duration_ms(&self) -> Option<i64> {
        Some((self.last_at? - self.first_at?).num_milliseconds())
    }

    /// The parts of the transcript a session record is built from.
    pub fn facts(&self) -> Facts {
        let cost = self.cost();
        let mut usage: Vec<session::ModelUsage> = self
            .usage_by_model()
            .iter()
            .filter(|(model, u)| u.requests > 0 && model.as_str() != "<synthetic>")
            .map(|(model, u)| session::ModelUsage {
                model: model.clone(),
                requests: u.requests,
                input_tokens: u.input,
                output_tokens: u.output,
                thinking_tokens: u.thinking,
                cache_read_tokens: u.cache_read,
                cache_write_5m_tokens: u.cache_write_5m,
                cache_write_1h_tokens: u.cache_write_1h,
                estimated_cost_usd: u.priced_cost(),
            })
            .collect();
        usage.sort_by(|a, b| b.requests.cmp(&a.requests).then(a.model.cmp(&b.model)));
        Facts {
            first_at: self.first_at,
            last_at: self.last_at,
            git_branch: self.git_branch.clone(),
            version: self.version.clone(),
            entrypoint: self.entrypoint.clone(),
            cost: Some(session::Cost {
                total_usd: cost.total_usd,
                source: cost.source,
                transcript_estimate_usd: cost.transcript_estimate_usd,
                unpriced_requests: cost.unpriced_requests,
                untracked_usd: cost.untracked_usd,
                prompts_covered: None,
                by_branch: cost.by_branch,
            }),
            usage,
            subagents: self
                .subagents
                .iter()
                .map(|sub| {
                    let mut total = Usage::default();
                    sub.usage.values().for_each(|u| total.merge(u));
                    SubagentFacts {
                        agent_id: sub.agent_id.clone(),
                        agent_type: sub.agent_type.clone(),
                        description: sub.description.clone(),
                        requests: total.requests,
                        input_tokens: total.input,
                        output_tokens: total.output,
                        estimated_cost_usd: total.priced_cost(),
                        findings: sub.findings,
                    }
                })
                .collect(),
            tool_models: self.tool_models.clone(),
            review_launches: self.review_launches.clone(),
            reused_efforts: self.reused_efforts.clone(),
            review_replies: self.review_replies.clone(),
            review_modes: Vec::new(),
            reviewer_threads: Vec::new(),
        }
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
            "unpriced_requests": cost.unpriced_requests,
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
                "recorded_until": r.recorded_until,
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

/// What a session record needs beyond its events: cost, usage and timing as
/// the agent's own files give them. Saved after every successful read, so
/// they survive those files being deleted (Claude Code cleans old
/// transcripts up).
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Facts {
    pub first_at: Option<DateTime<Utc>>,
    pub last_at: Option<DateTime<Utc>>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    pub entrypoint: Option<String>,
    /// Null when the agent's files say nothing about cost.
    pub cost: Option<session::Cost>,
    pub usage: Vec<session::ModelUsage>,
    pub subagents: Vec<SubagentFacts>,
    /// The model behind each tool call, by tool use id.
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub tool_models: HashMap<String, String>,
    /// Typed review commands that forked a subagent to run in: the hooks do
    /// not say which subagent that is.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub review_launches: Vec<ReviewLaunch>,
    /// Efforts Claude Code said it reused for a review typed without one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reused_efforts: Vec<ReusedEffort>,
    /// How many findings the main thread's last reply to a typed review
    /// names, for a review that ran there and not in a subagent.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub review_replies: Vec<ReviewSaid>,
    /// Codex's `/review` runs, as its rollout has them: review mode entered
    /// and left.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub review_modes: Vec<ReviewMode>,
    /// The threads Codex's reviewers ran in, and when each began: which
    /// review each is of is told from the times (`reviews::runs`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reviewer_threads: Vec<ReviewerThread>,
}

/// A typed review command that forked: the row Claude Code writes as it
/// starts. Of the command's arguments, the effort and a pull request number.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewLaunch {
    pub at: Option<DateTime<Utc>>,
    pub command: String,
    pub effort: Option<String>,
    pub pull_number: Option<u64>,
    /// The subagent the review runs in.
    pub agent_id: String,
}

/// One run of Codex's `/review`: an `EnteredReviewMode` item, and the
/// `ExitedReviewMode` that ends it with what the reviewer found.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewMode {
    pub id: String,
    pub at: Option<DateTime<Utc>>,
    /// What was reviewed, as Codex writes it: `baseBranch`,
    /// `uncommittedChanges`, `commit`, `custom`.
    pub target: Option<String>,
    /// None when the session stopped while it ran.
    pub ended_at: Option<DateTime<Utc>>,
    /// How many findings the reviewer returned.
    pub findings: Option<u64>,
}

/// A thread a reviewer of Codex's `/review` ran in.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewerThread {
    pub agent_id: String,
    pub began: Option<DateTime<Utc>>,
}

/// The number of findings the reply to a typed review names (see
/// `reviews::findings_in`), by the prompt the command was: the reply itself
/// is not kept.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewSaid {
    pub prompt_id: String,
    pub findings: u64,
}

/// "Reusing high effort, the level you typed last time."
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReusedEffort {
    pub at: Option<DateTime<Utc>>,
    pub effort: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SubagentFacts {
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
    /// How many findings its last reply names, where it says so (see
    /// `reviews::findings_in`): used for the subagent a review ran in.
    pub findings: Option<u64>,
}

impl Facts {
    pub fn load(path: &Path) -> Option<Facts> {
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            crate::paths::create_private_dir(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

fn subagent_files(transcript: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(transcript.with_extension("").join("subagents"))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    files
}

/// Combined size of a transcript and its subagent transcripts; 0 if missing.
/// Used to notice that a session has new data.
pub fn tree_size(transcript: &Path) -> u64 {
    std::iter::once(transcript.to_path_buf())
        .chain(subagent_files(transcript))
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// Parse a session transcript and its subagent transcripts.
pub fn parse(path: &Path) -> Result<TranscriptSummary> {
    let mut summary = TranscriptSummary {
        path: path.to_path_buf(),
        ..Default::default()
    };
    // A message id found in more than one file is counted in the first only.
    let mut seen = HashSet::new();
    (summary.main, _) = scan(path, &mut summary, &mut seen, true)?;
    for file in subagent_files(path) {
        let (usage, last_reply) = scan(&file, &mut summary, &mut seen, false)?;
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
            findings: last_reply.as_deref().and_then(crate::reviews::findings_in),
        });
    }
    Ok(summary)
}

/// One API response as a transcript file has it: when its first row was
/// written and on which branch, and the usage of its latest row.
struct Response {
    at: Option<DateTime<Utc>>,
    model: String,
    usage: Value,
    branch: Option<String>,
}

/// Read one transcript file into `summary` and return its usage per model,
/// and the text of its last reply.
fn scan(
    path: &Path,
    summary: &mut TranscriptSummary,
    seen: &mut HashSet<String>,
    is_main: bool,
) -> Result<(UsageByModel, Option<String>)> {
    // in order of first appearance
    let mut responses: Vec<Response> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut latest: Option<DateTime<Utc>> = None;
    let mut last_reply: Option<(Option<String>, Vec<String>)> = None;
    // In the main thread, the typed review being answered: its prompt.
    let mut reviewing: Option<String> = None;
    // What a reply to a typed review says it found, once the turn is over.
    fn said(
        summary: &mut TranscriptSummary,
        reviewing: &mut Option<String>,
        reply: &mut Option<(Option<String>, Vec<String>)>,
    ) {
        let (prompt, reply) = (reviewing.take(), reply.take());
        let (Some(prompt_id), Some((_, all))) = (prompt, reply) else {
            return;
        };
        let known = summary
            .review_replies
            .iter()
            .any(|r| r.prompt_id == prompt_id);
        if !known {
            let said = crate::reviews::review_said(&prompt_id, &all.join("\n"));
            summary.review_replies.extend(said);
        }
    }

    let skipped = crate::jsonl::for_each(path, |row| {
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
            latest = Some(latest.map_or(ts, |l| l.max(ts)));
        }
        match row.get("type").and_then(Value::as_str) {
            // Something asked, and not a tool's result: the turn before it is
            // over. A review command typed here is the one answered next.
            Some("user") if is_main => {
                let blocks = row["message"]["content"].as_array();
                let result = blocks.is_some_and(|b| b.iter().any(|b| b["type"] == "tool_result"));
                // Nor is a row Claude Code put in beside what was asked.
                let beside = row["isMeta"].as_bool() == Some(true);
                if !result && !beside {
                    said(summary, &mut reviewing, &mut last_reply);
                    if crate::reviews::typed_row(&row) {
                        reviewing = text("promptId");
                    }
                }
            }
            Some("assistant") => {
                let message = &row["message"];
                if !is_main || reviewing.is_some() {
                    let texts = message["content"].as_array().into_iter().flatten();
                    // All it said in its last message, in order: the number
                    // of findings may be in a block before the last, and a
                    // message's blocks are written a row each.
                    let said: Vec<&str> = texts
                        .filter_map(|b| b["text"].as_str().filter(|_| b["type"] == "text"))
                        .filter(|t| !t.trim().is_empty())
                        .collect();
                    if !said.is_empty() {
                        let id = message["id"].as_str().map(String::from);
                        let mut all = match last_reply.take() {
                            Some((before, all)) if id.is_some() && before == id => all,
                            _ => Vec::new(),
                        };
                        for text in said {
                            // A row may be written twice.
                            if !all.iter().any(|t| t == text) {
                                all.push(text.to_string());
                            }
                        }
                        last_reply = Some((id, all));
                    }
                }
                if let Some(model) = message["model"].as_str().filter(|m| *m != "<synthetic>") {
                    let calls = message["content"].as_array().into_iter().flatten();
                    for call in calls.filter(|b| b["type"] == "tool_use") {
                        if let Some(id) = call["id"].as_str() {
                            summary
                                .tool_models
                                .insert(id.to_string(), model.to_string());
                        }
                    }
                }
                let (Some(id), Some(usage)) = (message["id"].as_str(), message.get("usage")) else {
                    return;
                };
                match by_id.get(id) {
                    // a later row of the same response: its usage supersedes
                    Some(&i) => responses[i].usage = usage.clone(),
                    None if seen.insert(id.to_string()) => {
                        by_id.insert(id.to_string(), responses.len());
                        let model = message["model"].as_str().unwrap_or("unknown");
                        responses.push(Response {
                            at: row_ts,
                            model: model.to_string(),
                            usage: usage.clone(),
                            branch: text("gitBranch"),
                        });
                    }
                    None => {} // already counted from another file
                }
            }
            Some("cost-state") if is_main => {
                let n = |k: &str| row.get(k).and_then(Value::as_u64);
                if let Some(total) = row.get("totalCostUSD").and_then(Value::as_f64) {
                    summary.recorded = Some(Recorded {
                        total_cost_usd: total,
                        run_started_at: row
                            .get("startTime")
                            .and_then(Value::as_i64)
                            .and_then(DateTime::from_timestamp_millis),
                        recorded_until: latest,
                        total_duration_ms: n("totalDuration"),
                        api_duration_ms: n("totalAPIDuration"),
                        tool_duration_ms: n("totalToolDuration"),
                        lines_added: n("totalLinesAdded"),
                        lines_removed: n("totalLinesRemoved"),
                        model_usage: row.get("modelUsage").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            Some("system") if is_main => {
                let said = row["content"].as_str().unwrap_or_default();
                // A typed review that ran where it was typed ends with what
                // it printed; one that forked says where, and its subagent
                // has the reply.
                if row["subtype"] == "local_command" {
                    if let Some(prompt_id) = reviewing.take() {
                        last_reply = None;
                        let printed = crate::reviews::command_output(said);
                        let known = |r: &ReviewSaid| r.prompt_id == prompt_id;
                        if !summary.review_replies.iter().any(known) {
                            let found = printed
                                .and_then(|out| crate::reviews::review_said(&prompt_id, out));
                            summary.review_replies.extend(found);
                        }
                    }
                }
                if let Some(launch) = review_launch(said) {
                    let known = |l: &ReviewLaunch| l.agent_id == launch.agent_id;
                    if !summary.review_launches.iter().any(known) {
                        summary.review_launches.push(ReviewLaunch {
                            at: row_ts,
                            ..launch
                        });
                    }
                } else if let Some(effort) = crate::reviews::reused_effort(said) {
                    summary
                        .reused_efforts
                        .push(ReusedEffort { at: row_ts, effort });
                }
            }
            _ => {}
        }
    })?;
    summary.skipped_lines += skipped;

    let mut usage = UsageByModel::new();
    for response in responses {
        let cost = usage
            .entry(response.model.clone())
            .or_default()
            .add_message(&response.model, &response.usage);
        summary.messages.push(Message {
            at: response.at,
            cost,
            branch: response.branch,
        });
    }
    if is_main {
        said(summary, &mut reviewing, &mut last_reply);
    }
    Ok((usage, last_reply.map(|(_, all)| all.join("\n"))))
}

/// A review command that forked, from the row that says where (see
/// `reviews::forked_launch`).
fn review_launch(said: &str) -> Option<ReviewLaunch> {
    let launch = crate::reviews::forked_launch(said)?;
    let (effort, pull_number) = crate::reviews::parse_args(&launch.args);
    Some(ReviewLaunch {
        at: None,
        command: launch.command,
        effort,
        pull_number,
        agent_id: launch.agent_id?,
    })
}

/// Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, or `~/.claude`.
pub fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| Some(crate::paths::home_dir()?.join(".claude")))
}

/// Find a session's transcript: first from our raw capture (hook payloads carry
/// `transcript_path`), then by scanning Claude Code's projects directory. A
/// unique prefix of the session id is enough.
pub fn find(session_id: &str, raw_dir: Option<&Path>) -> Option<PathBuf> {
    let projects = claude_config_dir().map(|d| d.join("projects"));
    find_in(session_id, raw_dir, projects.as_deref())
}

fn find_in(session_id: &str, raw_dir: Option<&Path>, projects: Option<&Path>) -> Option<PathBuf> {
    let stem = crate::capture::file_stem(Some(session_id));
    if let Some(raw_dir) = raw_dir {
        let mut found = None;
        let _ = crate::jsonl::for_each(&raw_dir.join(format!("{stem}.jsonl")), |record| {
            if found.is_none() {
                found = record["payload"]["transcript_path"]
                    .as_str()
                    .map(PathBuf::from)
                    .filter(|p| p.exists());
            }
        });
        if found.is_some() {
            return found;
        }
    }
    let mut matches: Vec<PathBuf> = fs::read_dir(projects?)
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

    fn append(path: &Path, row: &Value) {
        let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
        writeln!(f, "{row}").unwrap();
    }

    const OPUS: f64 = (10.0 * 4.0 + 100.0 * 20.0) / 1e6 + 0.20 + 8.0;
    const HAIKU: f64 = (1000.0 * 0.10 + 2000.0 * 0.50 + 1000.0 * 0.125) / 1e6;

    /// Main thread: one opus response at 10:00:01 written as two rows (the
    /// first with a placeholder output count), a tokenless synthetic message,
    /// a non-object row and a truncated last line. One subagent with a haiku
    /// response at 10:01:00.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s1.jsonl");
        write_jsonl(
            &main,
            &[
                json!({ "type": "user", "sessionId": "s1", "timestamp": "2026-11-13T10:00:00.000Z" }),
                assistant(
                    "m1",
                    "claude-opus-5-5",
                    usage(10, 1, 1_000_000, 0, 1_000_000),
                    "2026-11-13T10:00:01.000Z",
                ),
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
                json!("not an object"),
            ],
        );
        fs::OpenOptions::new()
            .append(true)
            .open(&main)
            .unwrap()
            .write_all(b"{\"truncated\n")
            .unwrap();
        write_jsonl(
            &dir.path().join("s1/subagents/agent-abc.jsonl"),
            &[
                assistant(
                    "m3",
                    "claude-haiku-5-5",
                    usage(1_000, 2_000, 0, 1_000, 0),
                    "2026-11-13T10:01:00.000Z",
                ),
                // also present in the main file: counted there only
                assistant(
                    "m1",
                    "claude-opus-5-5",
                    usage(10, 100, 1_000_000, 0, 1_000_000),
                    "2026-11-13T10:01:01.000Z",
                ),
            ],
        );
        fs::write(
            dir.path().join("s1/subagents/agent-abc.meta.json"),
            r#"{"agentType":"Explore","description":"look around"}"#,
        )
        .unwrap();
        (dir, main)
    }

    fn cost_state(total: f64, start: Option<&str>) -> Value {
        let mut row = json!({ "type": "cost-state", "totalCostUSD": total,
                              "totalDuration": 61000, "totalLinesAdded": 4 });
        if let Some(start) = start {
            let ms = DateTime::parse_from_rfc3339(start)
                .unwrap()
                .timestamp_millis();
            row["startTime"] = json!(ms);
        }
        row
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn counts_each_response_once_with_its_final_usage() {
        let (_dir, path) = fixture();
        let s = parse(&path).unwrap();
        let opus = &s.main["claude-opus-5-5"];
        assert_eq!(opus.requests, 1);
        assert_eq!(
            opus.output, 100,
            "the last row's count, not the placeholder"
        );
        assert_eq!(opus.thinking, 3);
        assert_eq!(s.subagents.len(), 1);
        assert_eq!(s.subagents[0].agent_id, "abc");
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("Explore"));
        assert!(!s.subagents[0].usage.contains_key("claude-opus-5-5"));
        assert_eq!(s.total_usage().requests, 3);
        assert_eq!(s.skipped_lines, 1);
        assert_eq!(s.session_id.as_deref(), Some("s1"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        assert_eq!(s.duration_ms(), Some(61_000));
    }

    #[test]
    fn estimates_cost_from_prices() {
        let (_dir, path) = fixture();
        let s = parse(&path).unwrap();
        // opus 5.5: 10*$4 + 100*$20 + 1M*$0.20 + 1M*$8 (1h write), per MTok
        assert!(close(s.main["claude-opus-5-5"].cost_usd, OPUS));
        let cost = s.cost();
        // the tokenless <synthetic> message doesn't make the estimate partial
        assert_eq!(cost.source, CostSource::Estimated);
        assert!(close(cost.total_usd, OPUS + HAIKU));
        assert_eq!(cost.untracked_usd, None);
        assert_eq!(cost.unpriced_requests, 0);
    }

    #[test]
    fn recorded_total_covers_background_calls() {
        let (_dir, path) = fixture();
        append(&path, &cost_state(12.5, None));
        let s = parse(&path).unwrap();
        let cost = s.cost();
        // no startTime: the run starts with the transcript. The subagent
        // message is later than the last main row, so it is added on top.
        assert_eq!(cost.source, CostSource::RecordedAndEstimated);
        assert!(close(cost.total_usd, 12.5 + HAIKU));
        assert!(close(cost.untracked_usd.unwrap(), 12.5 - OPUS));
        let rec = s.recorded.unwrap();
        assert_eq!(rec.total_duration_ms, Some(61_000));
        assert_eq!(rec.lines_added, Some(4));
    }

    #[test]
    fn recorded_total_alone_when_it_covers_everything() {
        let (_dir, path) = fixture();
        // a later main row moves the recorded window past the subagent message
        append(
            &path,
            &json!({ "type": "user", "timestamp": "2026-11-13T10:02:00.000Z" }),
        );
        append(&path, &cost_state(12.5, Some("2026-11-13T09:59:00Z")));
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::Recorded);
        assert!(close(cost.total_usd, 12.5));
        assert!(close(cost.untracked_usd.unwrap(), 12.5 - OPUS - HAIKU));
    }

    #[test]
    fn earlier_runs_are_estimated() {
        let (_dir, path) = fixture();
        append(
            &path,
            &json!({ "type": "user", "timestamp": "2026-11-13T10:02:00.000Z" }),
        );
        // the run started after the opus message: only haiku is inside it
        append(&path, &cost_state(1.0, Some("2026-11-13T10:00:30Z")));
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::RecordedAndEstimated);
        assert!(close(cost.total_usd, OPUS + 1.0));
        assert!(close(cost.untracked_usd.unwrap(), 1.0 - HAIKU));
    }

    #[test]
    fn spend_after_the_recorded_total_is_added() {
        let (_dir, path) = fixture();
        append(&path, &cost_state(9.0, Some("2026-11-13T09:59:00Z")));
        // the session was resumed and has not written a new total yet
        append(
            &path,
            &assistant(
                "m9",
                "claude-opus-5-5",
                usage(10, 100, 1_000_000, 0, 1_000_000),
                "2026-11-13T11:00:00.000Z",
            ),
        );
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::RecordedAndEstimated);
        // 9.0 covers the first opus message; haiku and the new opus are outside
        assert!(close(cost.total_usd, 9.0 + HAIKU + OPUS));
    }

    #[test]
    fn cost_is_shared_out_by_the_branch_of_each_response() {
        let (_dir, path) = fixture();
        // The fixture's two responses are on main. A third is made after the
        // work moved to a branch, and the recorded total covers all three.
        let mut on_branch = assistant(
            "m9",
            "claude-opus-5-5",
            usage(10, 100, 1_000_000, 0, 1_000_000),
            "2026-11-13T10:02:00.000Z",
        );
        on_branch["gitBranch"] = json!("feat");
        append(&path, &on_branch);
        let estimated = parse(&path).unwrap().cost();
        let shares = |cost: &Cost| -> Vec<(Option<String>, f64)> {
            cost.by_branch
                .iter()
                .map(|b| (b.branch.clone(), b.usd))
                .collect()
        };
        let by = shares(&estimated);
        assert_eq!(by.len(), 2, "in name order: {by:?}");
        assert_eq!(by[0].0.as_deref(), Some("feat"));
        assert!((by[0].1 - OPUS).abs() < 1e-6);
        assert_eq!(by[1].0.as_deref(), Some("main"));
        assert!((by[1].1 - OPUS - HAIKU).abs() < 1e-6);

        // What the agent recorded beyond the estimates is spread the same way.
        append(&path, &cost_state(30.0, Some("2026-11-13T09:59:00Z")));
        let recorded = parse(&path).unwrap().cost();
        assert!(close(recorded.total_usd, 30.0));
        let by = shares(&recorded);
        let all = 2.0 * OPUS + HAIKU;
        assert!((by[0].1 - 30.0 * OPUS / all).abs() < 1e-6);
        assert!((by[0].1 + by[1].1 - 30.0).abs() < 1e-5);
        assert_eq!(
            parse(&path).unwrap().facts().cost.unwrap().by_branch,
            recorded.by_branch
        );
    }

    #[test]
    fn a_response_without_a_branch_is_shared_out_under_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut row = assistant(
            "m1",
            "claude-opus-5-5",
            usage(10, 100, 1_000_000, 0, 1_000_000),
            "2026-11-13T10:00:01.000Z",
        );
        row.as_object_mut().unwrap().remove("gitBranch");
        write_jsonl(&path, &[row]);
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.by_branch.len(), 1);
        assert_eq!(cost.by_branch[0].branch, None);
        assert!(close(cost.by_branch[0].usd, OPUS));
    }

    #[test]
    fn estimate_is_used_when_higher_than_the_recorded_run() {
        let (_dir, path) = fixture();
        append(&path, &cost_state(0.0, Some("2026-11-13T09:59:00Z")));
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::RecordedAndEstimated);
        assert!(close(cost.total_usd, OPUS + HAIKU));
        assert_eq!(cost.untracked_usd, Some(0.0));
    }

    #[test]
    fn messages_without_a_timestamp_are_not_counted_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut row = assistant(
            "m1",
            "claude-opus-5-5",
            usage(10, 100, 1_000_000, 0, 1_000_000),
            "x",
        );
        row.as_object_mut().unwrap().remove("timestamp");
        write_jsonl(
            &path,
            &[row, cost_state(OPUS, Some("2026-11-13T10:00:00Z"))],
        );
        let cost = parse(&path).unwrap().cost();
        assert!(close(cost.total_usd, OPUS));
        assert!(close(cost.untracked_usd.unwrap(), 0.0));
    }

    #[test]
    fn unpriced_models_are_reported_not_hidden() {
        let (_dir, path) = fixture();
        append(
            &path,
            &assistant(
                "m8",
                "claude-future-9",
                usage(5, 5, 0, 0, 0),
                "2026-11-13T10:00:03.000Z",
            ),
        );
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::PartialEstimate);
        assert_eq!(cost.unpriced_requests, 1);

        // Inside a recorded run the total covers it, but the untracked share
        // can't be known.
        append(
            &path,
            &json!({ "type": "user", "timestamp": "2026-11-13T10:02:00.000Z" }),
        );
        append(&path, &cost_state(20.0, Some("2026-11-13T09:59:00Z")));
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::Recorded);
        assert_eq!((cost.unpriced_requests, cost.untracked_usd), (0, None));

        // In an earlier run nothing covers it: the total is incomplete.
        append(&path, &cost_state(20.0, Some("2026-11-13T10:00:30Z")));
        let cost = parse(&path).unwrap().cost();
        assert_eq!(cost.source, CostSource::RecordedAndEstimated);
        assert_eq!(cost.unpriced_requests, 1);
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
    fn a_typed_review_that_ran_where_it_was_typed_says_what_it_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        let user = |id: &str, content: Value| {
            json!({ "type": "user", "promptId": id, "sessionId": "s1",
                    "message": { "role": "user", "content": content } })
        };
        let says = |id: &str, text: &str| {
            json!({ "type": "assistant", "sessionId": "s1",
                    "message": { "id": id, "model": "claude-opus-5-5", "usage": {},
                                 "content": [{ "type": "text", "text": text }] } })
        };
        let printed = |text: &str| {
            json!({ "type": "system", "subtype": "local_command", "sessionId": "s1",
                    "content": format!("<local-command-stdout>{text}</local-command-stdout>") })
        };
        let mut beside = user("p1", json!("Review the changes for security problems."));
        beside["isMeta"] = json!(true);
        write_jsonl(
            &path,
            &[
                // typed, as Claude Code writes it, and answered in the main thread
                user("p1", json!("/security-review")),
                // what the command stands for, put in beside it: not the next thing asked
                beside,
                says("m1", "Looking at the diff."),
                // nor is a tool's result
                user(
                    "p1",
                    json!([{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }]),
                ),
                says("m2", "I found 3 issues."),
                says("m2", "The first is in auth.rs."),
                // not a review: what is said to it is not read
                user("p2", json!("thanks, fix them")),
                says("m3", "I found 9 problems on the way."),
                // ran to its end where it was typed: what it printed
                user("p3", json!("/code-review high #15")),
                printed("10 findings, most severe first:\n\n1. `a.rs`: ..."),
                says("m4", "I found 2 issues of my own."),
                // forked: its subagent has the reply, and the notice has none
                user("p4", json!("/code-review high")),
                printed("Running in the background as @code-review</local-command-stdout>\n<forked-skill-launch>{\"agentId\":\"f1\",\"skillName\":\"code-review\",\"description\":\"/code-review high\"}</forked-skill-launch>"),
                // the row an older transcript has for a typed command
                user(
                    "p5",
                    json!("<command-name>/security-review</command-name>\n<command-args></command-args>"),
                ),
                says("m5", "No findings."),
            ],
        );
        let facts = parse(&path).unwrap().facts();
        let said: Vec<_> = facts
            .review_replies
            .iter()
            .map(|r| (r.prompt_id.as_str(), r.findings))
            .collect();
        assert_eq!(said, [("p1", 3), ("p3", 10), ("p5", 0)]);
        assert_eq!(facts.review_launches.len(), 1);
    }

    #[test]
    fn facts_round_trip_and_tree_size() {
        let (dir, path) = fixture();
        let facts = parse(&path).unwrap().facts();
        assert_eq!(facts.usage[0].model, "claude-haiku-5-5");
        assert_eq!(facts.usage.len(), 2, "synthetic is left out");
        assert_eq!(facts.subagents[0].output_tokens, 2_000);
        assert!(close(facts.subagents[0].estimated_cost_usd.unwrap(), HAIKU));
        let saved = dir.path().join("facts/s1.json");
        facts.save(&saved).unwrap();
        assert_eq!(Facts::load(&saved), Some(facts));
        assert_eq!(Facts::load(&dir.path().join("missing.json")), None);

        let before = tree_size(&path);
        append(&dir.path().join("s1/subagents/agent-abc.jsonl"), &json!({}));
        assert!(tree_size(&path) > before);
        assert_eq!(tree_size(&dir.path().join("gone.jsonl")), 0);
    }

    #[test]
    fn finds_transcript_via_raw_capture() {
        let (dir, path) = fixture();
        let raw = dir.path().join("raw");
        write_jsonl(
            &raw.join("s1.jsonl"),
            &[json!({ "payload": { "transcript_path": path } })],
        );
        assert_eq!(find_in("s1", Some(&raw), None), Some(path));
    }

    #[test]
    fn finds_transcript_by_unique_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        let a = projects.join("p1/aaaa1111-x.jsonl");
        write_jsonl(&a, &[json!({})]);
        write_jsonl(&projects.join("p2/aaaa2222-y.jsonl"), &[json!({})]);
        let find = |id: &str| find_in(id, None, Some(&projects));
        assert_eq!(find("aaaa1"), Some(a.clone()));
        assert_eq!(find("aaaa1111-x"), Some(a));
        assert_eq!(find("aaaa"), None); // ambiguous
        assert_eq!(find("zzzz"), None);
    }
}
