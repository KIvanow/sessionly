// Generated from schema/upload.schema.json by `pnpm gen`. Do not edit by hand.

/**
 * How a prompt turn ended.
 */
export type Outcome = ("completed" | "api_error") | "unknown";

/**
 * What the binary sends to a server for one session. Sending the same
 * session again replaces what the server has: the key is
 * (`session.machine_id`, `session.source`, `session.session_id`).
 */
export interface Upload {
  /**
   * Version of the session record format.
   */
  schema_version?: number;
  session?: Session;
  /**
   * Latest rewrite measurement. Null if the session changed no files or
   * they could not be measured.
   */
  rewrite?: RewriteMeasurement | null;
}
export interface Session {
  /**
   * Version of this record format.
   */
  schema_version?: number;
  /**
   * Agent that produced the session, e.g. "claude-code".
   */
  source?: string;
  /**
   * Version of the sessionly binary that built this record.
   */
  collector_version?: string;
  /**
   * Random id of the sessionly installation that captured the session.
   * Together with `source` and `session_id` it identifies the record.
   */
  machine_id?: string;
  /**
   * Where the activity (prompts, tool calls, files) was read from.
   */
  captured_by?: "hooks" | "transcript";
  /**
   * How much content the record carries. Records leave a machine only as
   * `previews` or `metadata`.
   */
  content?: "local" | "previews" | "metadata";
  session_id?: string;
  title?: string | null;
  /**
   * Who ran the session, from git config on the machine that captured it.
   */
  user?: User | null;
  started_at?: string | null;
  ended_at?: string | null;
  /**
   * Wall-clock span from first to last activity. Includes idle time and gaps
   * between resumes, so it can be days for a long-lived session.
   */
  duration_ms?: number | null;
  /**
   * Time the agent spent working on prompts (sum of prompt turn durations).
   */
  active_ms?: number;
  /**
   * Why the session last ended, as reported by the agent. Null while it is
   * open, including after it has been resumed.
   */
  end_reason?: string | null;
  /**
   * False when capture began partway through the session (the hooks were
   * installed after it started). Prompts, tool calls and files then cover
   * only the captured part, while cost and usage cover the whole session.
   */
  captured_from_start?: boolean;
  /**
   * Working directory the session ran in.
   */
  cwd?: string | null;
  repo?: Repo | null;
  /**
   * Version of the agent CLI.
   */
  agent_version?: string | null;
  /**
   * How the agent was started, e.g. "cli" or "sdk-cli".
   */
  entrypoint?: string | null;
  /**
   * Models that answered at least one request, most used first.
   */
  models?: string[];
  /**
   * Permission modes seen during the session, in order of first use.
   */
  permission_modes?: string[];
  /**
   * Null when no transcript was available to read cost from.
   */
  cost?: Cost | null;
  /**
   * Token usage per model, main thread and subagents combined.
   */
  usage?: ModelUsage[];
  counts?: Counts;
  prompts?: Prompt[];
  tool_calls?: ToolCall[];
  /**
   * Files read or changed through the agent's file tools. Changes made by
   * shell commands are not tracked here.
   */
  files?: FileTouched[];
  subagents?: Subagent[];
  /**
   * Instruction files (CLAUDE.md, rules) loaded into the session.
   */
  instruction_files?: string[];
}
export interface User {
  name?: string | null;
  email?: string | null;
}
export interface Repo {
  /**
   * Repository root on the capturing machine.
   */
  root?: string;
  /**
   * `origin` remote as host/owner/repo, without credentials.
   */
  remote?: string | null;
  branch?: string | null;
}
export interface Cost {
  /**
   * Best figure for the whole session, in USD.
   */
  total_usd?: number;
  /**
   * Where a session's cost figure comes from.
   */
  source?: "recorded" | "recorded_and_estimated" | "estimated" | "partial_estimate" | "unknown";
  /**
   * Estimate from the token counts visible in the transcript.
   */
  transcript_estimate_usd?: number;
  /**
   * Requests the total leaves out: made on a model without a known price,
   * outside any run the agent recorded a total for.
   */
  unpriced_requests?: number;
  /**
   * Spend the agent recorded that the transcript does not show. Null when
   * it can't be worked out (no recorded total, or a model without a known price).
   */
  untracked_usd?: number | null;
  /**
   * How many of the session's prompts the figure covers, when it can't
   * cover them all: an agent that reports usage only to hooks (Cursor) has
   * none for turns that ran before the hooks were installed. Null when the
   * figure covers the whole session.
   */
  prompts_covered?: number | null;
}
export interface ModelUsage {
  model?: string;
  requests?: number;
  input_tokens?: number;
  /**
   * Includes thinking tokens.
   */
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  /**
   * Cache writes with a 5-minute lifetime (1.25x the input price).
   */
  cache_write_5m_tokens?: number;
  /**
   * Cache writes with a 1-hour lifetime (2x the input price).
   */
  cache_write_1h_tokens?: number;
  /**
   * Null when the model has no known price.
   */
  estimated_cost_usd?: number | null;
}
export interface Counts {
  /**
   * Raw hook events the record was built from.
   */
  events?: number;
  prompts?: number;
  tool_calls?: number;
  tool_failures?: number;
  /**
   * Times the user was asked to approve a tool call.
   */
  permission_requests?: number;
  /**
   * Tool calls refused by auto mode.
   */
  permission_denials?: number;
  subagents?: number;
  compactions?: number;
  /**
   * Turns that ended in an API error.
   */
  api_errors?: number;
  files_read?: number;
  files_changed?: number;
  lines_added?: number;
  lines_removed?: number;
}
export interface Prompt {
  prompt_id?: string | null;
  at?: string | null;
  text?: Text;
  /**
   * When the agent finished responding. Null if the turn was interrupted
   * or is still running.
   */
  ended_at?: string | null;
  /**
   * Null if the turn was interrupted or is still running.
   */
  outcome?: Outcome | null;
  /**
   * API error type when outcome is "api_error".
   */
  error?: string | null;
}
/**
 * A piece of text kept as hash, length and short preview.
 */
export interface Text {
  /**
   * SHA-256 of the full text, hex.
   */
  sha256?: string;
  chars?: number;
  /**
   * First characters of the text.
   */
  preview?: string;
}
export interface ToolCall {
  tool_use_id?: string;
  /**
   * Prompt turn the call belongs to.
   */
  prompt_id?: string | null;
  /**
   * Set when a subagent made the call.
   */
  agent_id?: string | null;
  tool?: string;
  at?: string | null;
  /**
   * How a tool call ended.
   */
  status?: ("ok" | "failed") | "interrupted" | "denied" | "rejected" | "no_result" | "unknown";
  duration_ms?: number | null;
  /**
   * File the call operated on, for file tools.
   */
  file_path?: string | null;
  /**
   * SHA-256 of the full tool input (JSON), hex.
   */
  input_sha256?: string;
  /**
   * Short human-readable summary of the input: the command, pattern, URL
   * or description, depending on the tool.
   */
  input_summary?: string | null;
  /**
   * Size of the tool's result as serialized JSON.
   */
  output_bytes?: number | null;
  /**
   * Start of the error message for failed calls. For shell commands this
   * is the start of the command's output.
   */
  error?: string | null;
  lines_added?: number;
  lines_removed?: number;
}
export interface FileTouched {
  path?: string;
  reads?: number;
  /**
   * Successful write or edit calls.
   */
  writes?: number;
  /**
   * True if the agent created the file in this session.
   */
  created?: boolean;
  lines_added?: number;
  lines_removed?: number;
}
export interface Subagent {
  agent_id?: string;
  agent_type?: string | null;
  description?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  tool_calls?: number;
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number | null;
}
/**
 * How much of a session's changes is still in the files, measured later.
 */
export interface RewriteMeasurement {
  measured_at?: string | null;
  /**
   * Branch and commit that were checked out when measuring.
   */
  branch?: string | null;
  head?: string | null;
  files_measured?: number;
  /**
   * Files where less than half of the agent's lines survive, or that are gone.
   */
  files_rewritten?: number;
  /**
   * Lines the agent added that are tracked (not blank or punctuation-only).
   */
  lines_added?: number;
  /**
   * How many of them are still in the files.
   */
  lines_surviving?: number;
  files?: RewriteFile[];
}
export interface RewriteFile {
  path?: string;
  lines_added?: number;
  lines_surviving?: number;
  exists?: boolean;
}
