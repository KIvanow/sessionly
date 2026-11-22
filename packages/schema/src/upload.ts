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
  /**
   * The lines the agent added, as hashes, so a server can tell which lines
   * of a pull request an agent wrote. Sent only when that is switched on
   * (`sessionly settings --line-hashes on`); empty otherwise.
   */
  lines?: AddedLines[];
  /**
   * The rewrite measurement as it was 1, 7 and 30 days after the session
   * ended, for each of those ages it has reached and was measured at.
   * Left out while there is none.
   */
  checkpoints?: RewriteCheckpoint[];
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
   * Who ran the session: from git config on the machine that captured it,
   * or, for a session that ran in the cloud, the person the platform says
   * started it (git there is set up as the agent).
   */
  user?: User | null;
  /**
   * Where the session ran, if not on a person's own machine.
   */
  runtime?: Runtime | null;
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
   * How the agent was started, e.g. "cli" or "sdk-cli"; for a cloud
   * session, what the platform says started it ("remote_mobile", "website").
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
   * Files read or changed through the agent's file tools, and by its shell
   * commands where the hooks saw them: the working tree is compared before
   * and after each command. In the cloud everything that changed counts.
   * On a person's own machine that depends on `--shell-edits`: by default
   * only what is sure to be the command's, with `all` everything that
   * changed meanwhile, with `off` nothing.
   */
  files?: FileTouched[];
  subagents?: Subagent[];
  /**
   * Times a review command ran in the session (see `reviews`): the same
   * in every content mode, since nothing of a run's arguments is kept but
   * the effort and a pull request number.
   */
  reviews?: ReviewRun[];
  /**
   * Instruction files (CLAUDE.md, rules) loaded into the session.
   */
  instruction_files?: string[];
}
export interface User {
  name?: string | null;
  email?: string | null;
}
/**
 * A session that a cloud platform ran in a sandbox of its own: a Claude Code
 * cloud session or a Cursor cloud agent. Such a record's `machine_id` is
 * "cloud", since the sandbox is new each time.
 */
export interface Runtime {
  kind?: "cloud" | "unknown";
  /**
   * The platform's own id for the session (`cse_…`, `bc-…`), which is
   * what its web pages and API go by.
   */
  id?: string | null;
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
  /**
   * `total_usd` by the branch that was checked out when it was spent,
   * where the agent says which with every response (Claude Code): a
   * server then counts for a pull request what was spent on its branch
   * and on the one it is based on, and not what was spent on others.
   * Shared out as the estimates of the responses on each branch are; a
   * branch of null is the responses that named none. Left out where
   * that is not known, and of a session in the cloud, whose sandbox
   * holds the one branch.
   */
  by_branch?: BranchCost[];
}
/**
 * What a session spent while one branch was checked out.
 */
export interface BranchCost {
  branch?: string | null;
  usd?: number;
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
  /**
   * Review runs: the length of `Session::reviews`. Left out for an agent
   * whose review commands are not read (Cursor and Grok): not known,
   * which is not none.
   */
  reviews?: number | null;
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
  /**
   * For a `Skill` call, the skill's name as written (`code-review`,
   * `plugin:name`). A name, like the tool's, so it is kept in every
   * content mode; its arguments are not.
   */
  skill?: string | null;
  /**
   * Model that made the call. Null where the agent does not say: Grok, and
   * Cursor turns the hooks did not see.
   */
  model?: string | null;
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
 * One run of a review command: `/code-review` and the like (the names are
 * in `reviews`).
 */
export interface ReviewRun {
  /**
   * The tool-use id of the Skill call; for a slash command, the turn's
   * prompt id, or one made from its time where there is none.
   */
  id?: string;
  at?: string | null;
  /**
   * What was run, as written: "code-review", "ultrareview", "review",
   * "security-review", or a plugin's "name:code-review".
   */
  command?: string;
  /**
   * How it was started.
   */
  via?: "skill" | "slash_command" | "codex_review" | "unknown";
  /**
   * Where the review itself ran.
   */
  ran?: "local" | "cloud" | "unknown";
  /**
   * The first argument when it is one of low, medium, high, xhigh, max
   * or ultra. Else none.
   */
  effort?: string | null;
  /**
   * A pull request number among the arguments: `621`, `#528` or a pull
   * request's URL. Else none.
   */
  pull_number?: number | null;
  /**
   * What Codex's `/review` was pointed at: `base_branch` (the changes
   * against a branch), `uncommitted_changes`, `commit` or `custom`. None
   * for the other agents, whose commands take a pull request.
   */
  target?: string | null;
  /**
   * Set when a subagent ran it.
   */
  agent_id?: string | null;
  /**
   * How a tool call ended.
   */
  status?: ("ok" | "failed") | "interrupted" | "denied" | "rejected" | "no_result" | "unknown";
  /**
   * From the start to the end of the last of its subagents, or the
   * call's own duration where it had none.
   */
  duration_ms?: number | null;
  /**
   * Subagents that did the review: the one a skill forks to run in, and
   * those started from the review's thread before the person's next
   * prompt, with the subagents they started in turn.
   */
  subagents?: number;
  /**
   * Those subagents' estimated cost. A floor: the main thread's own
   * tokens during the review are not in it. Null when none has a cost,
   * and for a review that ran in the cloud, which is billed apart.
   */
  estimated_cost_usd?: number | null;
  /**
   * Findings reported at the end, where the agent reports them as a
   * list (`ReportFindings`). Else none.
   */
  findings?: number | null;
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
/**
 * Lines an agent added to one file with one model. A line is hashed without
 * the whitespace at its ends; blank lines and lines without a letter or
 * digit are left out. The same line added twice is listed twice.
 */
export interface AddedLines {
  /**
   * As in the session's `files`.
   */
  path?: string;
  /**
   * Null if the model is not known.
   */
  model?: string | null;
  /**
   * First 8 bytes of each line's SHA-256, as 16 hex digits.
   */
  hashes?: string[];
}
/**
 * How much of a session's changes was still in the files at a fixed age
 * after it ended: the first measurement taken at or after that age. Counts
 * and times only. Once taken it is kept as it is.
 */
export interface RewriteCheckpoint {
  /**
   * The age it is for: `1d`, `7d` or `30d` after the session ended.
   */
  checkpoint?: string;
  /**
   * Lines the agent added that are tracked, when this was measured.
   */
  added?: number;
  /**
   * How many of them were in the files then.
   */
  surviving?: number;
  measured_at?: string | null;
  /**
   * How long after the session ended it was measured, which is the age
   * or more: a machine that was off on the day measures later.
   */
  age_seconds?: number;
  /**
   * When the session had ended, as that age was counted. A checkpoint
   * belongs to this end: of a session that has another end now (it went
   * on since), it is a checkpoint no more.
   */
  ended_at?: string | null;
}
