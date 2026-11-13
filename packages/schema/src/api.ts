// Shapes of the server's answers to the dashboard. Shared by the server,
// which produces them, and the web app, which reads them.
import type { Upload } from "./upload.ts";

export type Role = "admin" | "member";

export interface Me {
  ok: true;
  email: string;
  name: string | null;
  role: Role;
}

/** How much of what the agent wrote is still in the files. */
export interface RewriteTotals {
  files_measured: number;
  /** Files where under half of the agent's lines survive, or that are gone. */
  files_rewritten: number;
  lines_added: number;
  lines_surviving: number;
}

export interface Totals {
  key: string;
  sessions: number;
  cost_usd: number;
  /** Sessions with no cost figure; `cost_usd` leaves them out. */
  sessions_without_cost: number;
  /** Sessions whose cost is an estimate, or includes one. */
  sessions_with_estimated_cost: number;
  active_ms: number;
  prompts: number;
  tool_calls: number;
  tool_failures: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  input_tokens: number;
  output_tokens: number;
  /** The agents the sessions ran in (`claude-code`, `cursor`, `grok`), in name order. */
  tools: string[];
  /** The main model of each session, in name order. Agents that record none add nothing. */
  models: string[];
  rewrite: RewriteTotals;
}

export type GroupBy = "user" | "repo" | "model" | "tool" | "day";

export interface Summary {
  /** Largest cost first; days oldest first. */
  groups: Totals[];
  total: Totals;
}

export interface SessionRow {
  machine_id: string;
  /** The agent the session ran in: `claude-code`, `cursor` or `grok`. */
  source: string;
  session_id: string;
  /** Who uploaded it: the owner of the token. */
  owner_email: string;
  repo: string | null;
  branch: string | null;
  title: string | null;
  /** Empty unless the record was uploaded with previews. */
  first_prompt: string | null;
  started_at: string | null;
  duration_ms: number | null;
  active_ms: number;
  cost_usd: number | null;
  cost_source: string | null;
  primary_model: string | null;
  prompts: number;
  tool_calls: number;
  tool_failures: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  content: string;
  captured_by: string | null;
  rewrite: RewriteTotals | null;
  updated_at: string;
}

export interface SessionList {
  sessions: SessionRow[];
  /** How many sessions match, before paging. */
  total: number;
}

export interface SessionDetail {
  owner_email: string;
  updated_at: string;
  upload: Upload;
}

/** One file agents changed, summed over the sessions that changed it. */
export interface FileRow {
  /** Relative to the repository (or `~/…`, or absolute, for files outside it). */
  path: string;
  /** Sessions that changed the file. */
  sessions: number;
  lines_added: number;
  lines_removed: number;
  /** An agent created the file. */
  created: boolean;
  /** When a session that changed it last started. */
  last_changed: string | null;
  /** The agents whose sessions changed it, in name order. */
  tools: string[];
  /** Null if no session's changes to this file were measured. */
  rewrite: {
    /** Lines agents added that are tracked (not blank or punctuation-only). */
    lines_added: number;
    lines_surviving: number;
    /** False if the file was gone when last measured. */
    exists: boolean;
  } | null;
}

export interface FileList {
  /** Most lines added first. */
  files: FileRow[];
  /** How many files match, before the limit. */
  total: number;
}

export interface FilterOptions {
  users: string[];
  repos: string[];
  models: string[];
  tools: string[];
}

export interface TokenInfo {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Returned once, when a token is created. */
export interface CreatedToken {
  id: string;
  token: string;
  email: string;
  name: string | null;
  role: Role;
}
