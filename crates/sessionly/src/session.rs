//! The normalized session record: one per agent session.
//!
//! This is the contract between the local binary and any server. The JSON
//! Schema in `schema/session.schema.json` is generated from these types
//! (`sessionly schema`), and a test fails if the two drift apart.
//!
//! Content policy: the record carries metadata, sizes, hashes and short
//! previews. Full prompts and file contents stay in the raw capture on the
//! machine that produced them. The previews are still content: prompt text,
//! shell commands, search patterns, URLs and the start of error output. A
//! hosted upload path must strip or redact them, and the absolute paths.
//!
//! Compatibility: every field has a default, so a reader accepts records
//! written before a field existed. Unknown fields are ignored.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Bump when the record changes in a way readers must know about.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Session {
    /// Version of this record format.
    pub schema_version: u32,
    /// Agent that produced the session, e.g. "claude-code".
    pub source: String,
    /// Version of the sessionly binary that built this record.
    pub collector_version: String,
    /// Random id of the sessionly installation that captured the session.
    /// Together with `source` and `session_id` it identifies the record.
    pub machine_id: String,
    /// Where the activity (prompts, tool calls, files) was read from.
    pub captured_by: CapturedBy,
    /// How much content the record carries. Records leave a machine only as
    /// `previews` or `metadata`.
    pub content: Content,
    pub session_id: String,
    pub title: Option<String>,
    /// Who ran the session: from git config on the machine that captured it,
    /// or, for a session that ran in the cloud, the person the platform says
    /// started it (git there is set up as the agent).
    pub user: Option<User>,
    /// Where the session ran, if not on a person's own machine.
    pub runtime: Option<Runtime>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    /// Wall-clock span from first to last activity. Includes idle time and gaps
    /// between resumes, so it can be days for a long-lived session.
    pub duration_ms: Option<i64>,
    /// Time the agent spent working on prompts (sum of prompt turn durations).
    pub active_ms: i64,
    /// Why the session last ended, as reported by the agent. Null while it is
    /// open, including after it has been resumed.
    pub end_reason: Option<String>,
    /// False when capture began partway through the session (the hooks were
    /// installed after it started). Prompts, tool calls and files then cover
    /// only the captured part, while cost and usage cover the whole session.
    pub captured_from_start: bool,
    /// Working directory the session ran in.
    pub cwd: Option<String>,
    pub repo: Option<Repo>,
    /// Version of the agent CLI.
    pub agent_version: Option<String>,
    /// How the agent was started, e.g. "cli" or "sdk-cli"; for a cloud
    /// session, what the platform says started it ("remote_mobile", "website").
    pub entrypoint: Option<String>,
    /// Models that answered at least one request, most used first.
    pub models: Vec<String>,
    /// Permission modes seen during the session, in order of first use.
    pub permission_modes: Vec<String>,
    /// Null when no transcript was available to read cost from.
    pub cost: Option<Cost>,
    /// Token usage per model, main thread and subagents combined.
    pub usage: Vec<ModelUsage>,
    pub counts: Counts,
    pub prompts: Vec<Prompt>,
    pub tool_calls: Vec<ToolCall>,
    /// Files read or changed through the agent's file tools. Changes made by
    /// shell commands are not tracked here.
    pub files: Vec<FileTouched>,
    pub subagents: Vec<Subagent>,
    /// Instruction files (CLAUDE.md, rules) loaded into the session.
    pub instruction_files: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct User {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// A session that a cloud platform ran in a sandbox of its own: a Claude Code
/// cloud session or a Cursor cloud agent. Such a record's `machine_id` is
/// "cloud", since the sandbox is new each time.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Runtime {
    pub kind: RuntimeKind,
    /// The platform's own id for the session (`cse_…`, `bc-…`), which is
    /// what its web pages and API go by.
    pub id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    #[default]
    Cloud,
    /// A value written by a newer version.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Repo {
    /// Repository root on the capturing machine.
    pub root: String,
    /// `origin` remote as host/owner/repo, without credentials.
    pub remote: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Cost {
    /// Best figure for the whole session, in USD.
    pub total_usd: f64,
    pub source: CostSource,
    /// Estimate from the token counts visible in the transcript.
    pub transcript_estimate_usd: f64,
    /// Requests the total leaves out: made on a model without a known price,
    /// outside any run the agent recorded a total for.
    pub unpriced_requests: u64,
    /// Spend the agent recorded that the transcript does not show. Null when
    /// it can't be worked out (no recorded total, or a model without a known price).
    pub untracked_usd: Option<f64>,
    /// How many of the session's prompts the figure covers, when it can't
    /// cover them all: an agent that reports usage only to hooks (Cursor) has
    /// none for turns that ran before the hooks were installed. Null when the
    /// figure covers the whole session.
    pub prompts_covered: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct ModelUsage {
    pub model: String,
    pub requests: u64,
    pub input_tokens: u64,
    /// Includes thinking tokens.
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub cache_read_tokens: u64,
    /// Cache writes with a 5-minute lifetime (1.25x the input price).
    pub cache_write_5m_tokens: u64,
    /// Cache writes with a 1-hour lifetime (2x the input price).
    pub cache_write_1h_tokens: u64,
    /// Null when the model has no known price.
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Counts {
    /// Raw hook events the record was built from.
    pub events: u64,
    pub prompts: u64,
    pub tool_calls: u64,
    pub tool_failures: u64,
    /// Times the user was asked to approve a tool call.
    pub permission_requests: u64,
    /// Tool calls refused by auto mode.
    pub permission_denials: u64,
    pub subagents: u64,
    pub compactions: u64,
    /// Turns that ended in an API error.
    pub api_errors: u64,
    pub files_read: u64,
    pub files_changed: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
}

/// A piece of text kept as hash, length and short preview.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Text {
    /// SHA-256 of the full text, hex.
    pub sha256: String,
    pub chars: u64,
    /// First characters of the text.
    pub preview: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Prompt {
    pub prompt_id: Option<String>,
    pub at: Option<DateTime<Utc>>,
    pub text: Text,
    /// When the agent finished responding. Null if the turn was interrupted
    /// or is still running.
    pub ended_at: Option<DateTime<Utc>>,
    /// Null if the turn was interrupted or is still running.
    pub outcome: Option<Outcome>,
    /// API error type when outcome is "api_error".
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct ToolCall {
    pub tool_use_id: String,
    /// Prompt turn the call belongs to.
    pub prompt_id: Option<String>,
    /// Set when a subagent made the call.
    pub agent_id: Option<String>,
    pub tool: String,
    /// Model that made the call. Null where the agent does not say: Grok, and
    /// Cursor turns the hooks did not see.
    pub model: Option<String>,
    pub at: Option<DateTime<Utc>>,
    pub status: ToolStatus,
    pub duration_ms: Option<u64>,
    /// File the call operated on, for file tools.
    pub file_path: Option<String>,
    /// SHA-256 of the full tool input (JSON), hex.
    pub input_sha256: String,
    /// Short human-readable summary of the input: the command, pattern, URL
    /// or description, depending on the tool.
    pub input_summary: Option<String>,
    /// Size of the tool's result as serialized JSON.
    pub output_bytes: Option<u64>,
    /// Start of the error message for failed calls. For shell commands this
    /// is the start of the command's output.
    pub error: Option<String>,
    pub lines_added: u64,
    pub lines_removed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct FileTouched {
    pub path: String,
    pub reads: u64,
    /// Successful write or edit calls.
    pub writes: u64,
    /// True if the agent created the file in this session.
    pub created: bool,
    pub lines_added: u64,
    pub lines_removed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Subagent {
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub tool_calls: u64,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
}

/// How a tool call ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Ok,
    Failed,
    /// The user interrupted it.
    Interrupted,
    /// Refused by auto mode or a permission rule.
    Denied,
    /// The user declined the permission prompt. Known only for sessions read
    /// from a transcript; a hook-captured one shows `no_result` instead.
    Rejected,
    /// Attempted, but no result was captured: rejected by the user,
    /// interrupted, or still running.
    #[default]
    NoResult,
    /// A value written by a newer version.
    #[serde(other)]
    Unknown,
}

/// How a prompt turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    ApiError,
    /// A value written by a newer version.
    #[serde(other)]
    Unknown,
}

/// Where a session's cost figure comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CostSource {
    /// The agent's own total, covering every message in the transcript.
    Recorded,
    /// The agent's total for one run, combined with our estimates for
    /// messages outside that run.
    RecordedAndEstimated,
    /// Our estimate from token counts only. A lower bound: it misses calls
    /// that never reach the transcript.
    #[default]
    Estimated,
    /// An estimate that leaves out requests to models without a known price.
    PartialEstimate,
    /// A value written by a newer version.
    #[serde(other)]
    Unknown,
}

impl CostSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            CostSource::Recorded => "recorded",
            CostSource::RecordedAndEstimated => "recorded_and_estimated",
            CostSource::Estimated => "estimated",
            CostSource::PartialEstimate => "partial_estimate",
            CostSource::Unknown => "unknown",
        }
    }
}

/// How much content a record carries.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum Content {
    /// As built on the capturing machine: previews and absolute paths. Never uploaded.
    #[default]
    #[value(skip)]
    Local,
    /// Previews kept (the first 200 characters of prompts, shell commands,
    /// search patterns, URLs and error output). Paths are made relative.
    Previews,
    /// No text from prompts, commands or output at all: counts, sizes,
    /// timings, tool names and relative file paths only.
    Metadata,
}

/// Where a session's activity was read from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CapturedBy {
    /// Hook events, as they happened.
    #[default]
    Hooks,
    /// Reconstructed afterwards from the agent's transcript.
    Transcript,
}

/// How much of a session's changes is still in the files, measured later.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct RewriteMeasurement {
    pub measured_at: Option<DateTime<Utc>>,
    /// Branch and commit that were checked out when measuring.
    pub branch: Option<String>,
    pub head: Option<String>,
    pub files_measured: u64,
    /// Files where less than half of the agent's lines survive, or that are gone.
    pub files_rewritten: u64,
    /// Lines the agent added that are tracked (not blank or punctuation-only).
    pub lines_added: u64,
    /// How many of them are still in the files.
    pub lines_surviving: u64,
    pub files: Vec<RewriteFile>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct RewriteFile {
    pub path: String,
    pub lines_added: u64,
    pub lines_surviving: u64,
    pub exists: bool,
}

/// What the binary sends to a server for one session. Sending the same
/// session again replaces what the server has: the key is
/// (`session.machine_id`, `session.source`, `session.session_id`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Upload {
    /// Version of the session record format.
    pub schema_version: u32,
    pub session: Session,
    /// Latest rewrite measurement. Null if the session changed no files or
    /// they could not be measured.
    pub rewrite: Option<RewriteMeasurement>,
    /// The lines the agent added, as hashes, so a server can tell which lines
    /// of a pull request an agent wrote. Sent only when that is switched on
    /// (`sessionly settings --line-hashes on`); empty otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<AddedLines>,
}

/// Lines an agent added to one file with one model. A line is hashed without
/// the whitespace at its ends; blank lines and lines without a letter or
/// digit are left out. The same line added twice is listed twice.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct AddedLines {
    /// As in the session's `files`.
    pub path: String,
    /// Null if the model is not known.
    pub model: Option<String>,
    /// First 8 bytes of each line's SHA-256, as 16 hex digits.
    pub hashes: Vec<String>,
}

fn pretty(schema: schemars::Schema) -> String {
    serde_json::to_string_pretty(&schema).expect("schema serializes") + "\n"
}

/// JSON Schema for [`Session`], pretty-printed with a trailing newline.
pub fn json_schema() -> String {
    pretty(schemars::schema_for!(Session))
}

/// JSON Schema for [`Upload`], the payload a server receives.
pub fn upload_json_schema() -> String {
    pretty(schemars::schema_for!(Upload))
}

#[cfg(test)]
mod tests {
    #[test]
    fn checked_in_upload_schema_is_current() {
        let on_disk = include_str!("../../../schema/upload.schema.json");
        assert_eq!(
            on_disk,
            super::upload_json_schema(),
            "schema/upload.schema.json is stale; regenerate with: \
             cargo run -q -- schema upload > schema/upload.schema.json"
        );
    }

    #[test]
    fn unknown_enum_values_from_a_newer_version_still_parse() {
        let call: super::ToolCall =
            serde_json::from_str(r#"{"status":"paused","brand_new_field":1}"#).unwrap();
        assert_eq!(call.status, super::ToolStatus::Unknown);
        let cost: super::Cost = serde_json::from_str(r#"{"source":"audited"}"#).unwrap();
        assert_eq!(cost.source, super::CostSource::Unknown);
        let old: super::Session = serde_json::from_str("{}").unwrap();
        assert_eq!(old.content, super::Content::Local);
    }

    #[test]
    fn checked_in_schema_is_current() {
        let on_disk = include_str!("../../../schema/session.schema.json");
        assert_eq!(
            on_disk,
            super::json_schema(),
            "schema/session.schema.json is stale; regenerate with: \
             cargo run -q -- schema > schema/session.schema.json"
        );
    }
}
