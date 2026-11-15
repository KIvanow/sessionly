// Shapes of the server's answers to the dashboard. Shared by the server,
// which produces them, and the web app, which reads them.
import type { Upload } from "./upload.ts";

/**
 * `ci` is for the GitHub Action: it can report pull requests and nothing
 * else. `env` is for a cloud agent's environment, which several people start
 * sessions in: it can upload sessions and nothing else, and a cloud session
 * it uploads is filed under the person the platform says started it.
 */
export type Role = "admin" | "member" | "ci" | "env";

export interface Me {
  ok: true;
  /** The organisation the token belongs to: "default" on a self-hosted install. */
  org: string;
  email: string;
  name: string | null;
  role: Role;
  /** The organisation's name. From `/me` only. */
  org_name?: string;
  /** Whether the token is a person's own: they signed in, or it is for their machines. */
  signed_in?: boolean;
}

/** A service people sign in with. */
export type SignInProvider = "google" | "github";

/** What a server offers someone who is not signed in (`/auth/options`). */
export interface AuthOptions {
  /** A service many organisations share. */
  hosted: boolean;
  /** What people can sign in with. Empty: by token only. */
  providers: SignInProvider[];
  /** Anyone can create an organisation. */
  signup: boolean;
  /** Signing up needs an invitation code. */
  inviteCode: boolean;
}

/** An organisation someone who has signed in can go on to (`/auth/check`). */
export interface Membership {
  user_id: string;
  /** The organisation's id, which unlike its name is its own. */
  org_id: string;
  org_name: string;
  /** The address they are in it under. */
  email: string;
  /** The person has not signed in to this organisation before. */
  first_time: boolean;
  /**
   * Who added them to it, if they have not signed in to it before and it
   * was someone who had signed in: that address is the adder's own.
   */
  invited_by: string | null;
  /**
   * How they were added: by a person who had signed in, or with a token,
   * which says nothing of who held it. Null if that was not recorded.
   */
  invited_via: "sign_in" | "token" | null;
  /**
   * Set if this organisation was signed in to before with another account
   * than the one just signed in with: the provider of that account. Only
   * that account gets in.
   */
  other_account: SignInProvider | null;
}

/** Who a provider said someone is, and where they can sign in (`/auth/check`). */
export interface Arrival {
  provider: SignInProvider;
  /** The addresses the provider vouches for, the main one first. */
  emails: string[];
  /** They came to create an organisation. */
  create: boolean;
  /**
   * The organisations they have signed in to before, and then the ones they
   * were added to and have not, newest first: a few of those at a time,
   * from the `shown`th on that was asked for (when it is not 0, only those).
   */
  orgs: Membership[];
  /** How many more they were added to, beyond the ones listed. */
  more: number;
}

/** What signing in to an organisation, or creating one, gives (`/auth/verify`). */
export interface SignedIn {
  token: string;
  org: { id: string; name: string };
  email: string;
  role: Role;
  expires_at: string;
  /** True if this created the organisation. */
  created: boolean;
}

/** A person of an organisation (`/users`). */
export interface UserInfo {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  created_at: string;
  removed_at: string | null;
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

/** `runtime` groups by where sessions ran: `local` or `cloud`. */
export type GroupBy = "user" | "repo" | "model" | "tool" | "day" | "runtime";

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
  /**
   * Whose session it is: the owner of the token that uploaded it, or for a
   * cloud session uploaded with an `env` token, the person who started it.
   */
  owner_email: string;
  /** `cloud` for a session a cloud platform ran in its own sandbox, else null. */
  runtime: string | null;
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
  /** Where the sessions ran: `local`, `cloud`, or both. */
  runtimes: string[];
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

/** Added lines of one file, as hashes (see `AddedLines` in the upload). */
export interface FileHashes {
  path: string;
  hashes: string[];
}

/**
 * What the GitHub Action sends each time something happens on a pull
 * request: where it stands, how review went so far, and the lines it adds.
 */
export interface PullReport {
  /** `github.com/owner/name` of the repository the pull request is in. */
  repo: string;
  /** The repository its branch is in, when that is a fork. */
  head_repo?: string | null;
  /**
   * Other names clones of the repository may still have as their origin,
   * for example from before it was renamed or moved to another owner.
   */
  aliases?: string[];
  /**
   * Email addresses its commits were made with. Sessions count toward the
   * pull request only if they are by one of these people (a session records
   * the email git is set up with, which is the one commits carry), or ran in
   * the cloud on the pull request's branch (there the commits are the
   * agent's). Used for matching and not stored. Without any, every session
   * in the repository is looked at.
   */
  commit_emails?: string[];
  number: number;
  title?: string | null;
  url?: string | null;
  /** Login of who opened it. */
  author: string;
  state: "open" | "merged" | "closed";
  draft?: boolean;
  head_ref?: string | null;
  base_ref?: string | null;
  created_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  /** What prompted the report: `opened`, `synchronize`, `closed`, `review`, … */
  event: string;
  commits: number;
  /** Reviews submitted by anyone but the author, bots included. */
  reviews: number;
  /** Reviews that asked for changes. */
  changes_requested: number;
  /** Comments on the diff by people other than the author. */
  review_comments: number;
  /** Comments on the diff by bots (CodeRabbit and the like). */
  bot_review_comments: number;
  /** Times review feedback was followed by a new commit. */
  review_rounds: number;
  /** The lines the pull request adds, per file, as it is now. */
  files: FileHashes[];
  /** Changed files GitHub gave no diff for (too large, or binary). */
  files_without_diff?: number;
}

/** Lines an agent wrote, by which agent and model. */
export interface LinesBy {
  /** The agent: `claude-code`, `cursor`, `grok`. */
  tool: string;
  /** Null if the model is not known. */
  model: string | null;
  lines: number;
}

/**
 * Which of a pull request's lines agents wrote. Only tracked lines count
 * (not blank, not punctuation only), and only agents whose sessions were
 * uploaded with line hashes: everything else counts as not an agent's, so
 * the agent figures are a floor.
 */
export interface PullAttribution {
  /** As first reported (when it was opened, if the Action ran then). */
  first: { lines: number; agent_lines: number };
  /** Whether the first report was made when it was opened. */
  from_open: boolean;
  /** As last reported. */
  now: { lines: number; agent_lines: number; by: LinesBy[] };
  /** The agent lines at first report, and how many are still there now. */
  by: (LinesBy & { surviving: number })[];
  /**
   * Set when a cloud agent worked on the pull request. Absent on reports
   * stored before this was recorded.
   */
  cloud?: PullCloud | null;
}

/**
 * A pull request a cloud agent worked on: its commits are made as the agent
 * (`Claude <noreply@anthropic.com>`, `Cursor Agent <cursoragent@cursor.com>`),
 * or its branch is one a cloud session ran on.
 */
export interface PullCloud {
  /** The agents recognised by their commits or branch: `claude-code`, `cursor`. */
  agents: string[];
  /**
   * Cloud sessions uploaded for this repository and branch. With none, the
   * agent's lines cannot be told apart and count as not an agent's.
   */
  sessions: number;
}

export interface PullRow {
  repo: string;
  number: number;
  title: string | null;
  url: string | null;
  author: string;
  state: "open" | "merged" | "closed";
  created_at: string | null;
  merged_at: string | null;
  /** The event of the first report: `opened` if the Action saw it from the start. */
  first_event: string;
  commits: number;
  reviews: number;
  changes_requested: number;
  review_comments: number;
  bot_review_comments: number;
  review_rounds: number;
  files_without_diff: number;
  attribution: PullAttribution;
  updated_at: string;
}

export interface PullList {
  /** Most recently created first. */
  pulls: PullRow[];
  total: number;
}

/**
 * Pull requests an agent and model had lines in, summed. A pull request with
 * lines from two models counts under both.
 */
export interface PullsByModel extends LinesBy {
  /** Pull requests it has lines in, as last reported; `lines` are those lines. */
  pulls: number;
  /**
   * Its lines in pull requests when they were opened. Only pull requests
   * reported from the moment they were opened count here: for the others
   * there is nothing to compare the end with.
   */
  opened_lines: number;
  /** Of `opened_lines`, still in the pull request at last report. */
  surviving: number;
  review_rounds: number;
  changes_requested: number;
  review_comments: number;
  bot_review_comments: number;
}

export interface PullSummary {
  /** Most lines first. */
  by_model: PullsByModel[];
  total: {
    pulls: number;
    /** Pull requests with at least one agent line. */
    pulls_with_agent_lines: number;
    /** Tracked lines the pull requests add, as last reported, and how many an agent wrote. */
    lines: number;
    agent_lines: number;
    /** Pull requests reported from the moment they were opened. */
    pulls_from_open: number;
    /** Agent lines those had when opened, and how many are still there. */
    opened_agent_lines: number;
    agent_lines_surviving: number;
    /** Pull requests a cloud agent worked on, and how many of those have no session. */
    cloud_pulls: number;
    cloud_pulls_without_session: number;
  };
}
