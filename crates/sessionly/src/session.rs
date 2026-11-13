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
    pub session_id: String,
    pub title: Option<String>,
    /// Who ran the session, from git config on the machine that captured it.
    pub user: Option<User>,
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
    /// How the agent was started, e.g. "cli" or "sdk-cli".
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
    /// "recorded": the agent's own total. "recorded_and_estimated": its total
    /// for the latest run plus our estimate for earlier runs. "estimated": our
    /// estimate from token counts. "partial_estimate": an estimate that leaves
    /// out requests to models without a known price.
    pub source: String,
    /// Estimate from the token counts visible in the transcript.
    pub transcript_estimate_usd: f64,
    /// Requests the total leaves out: made on a model without a known price,
    /// outside any run the agent recorded a total for.
    pub unpriced_requests: u64,
    /// Spend the agent recorded that the transcript does not show. Null when
    /// it can't be worked out (no recorded total, or a model without a known price).
    pub untracked_usd: Option<f64>,
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
    /// "completed" or "api_error". Null if interrupted or still running.
    pub outcome: Option<String>,
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
    pub at: Option<DateTime<Utc>>,
    /// "ok", "failed", "interrupted", "denied", or "no_result" (the call was
    /// attempted but no result was captured: rejected by the user, interrupted,
    /// or still running).
    pub status: String,
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

/// JSON Schema for [`Session`], pretty-printed with a trailing newline.
pub fn json_schema() -> String {
    let schema = schemars::schema_for!(Session);
    serde_json::to_string_pretty(&schema).expect("schema serializes") + "\n"
}

#[cfg(test)]
mod tests {
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
