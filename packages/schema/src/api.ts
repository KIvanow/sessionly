// Shapes of the server's answers to the dashboard. Shared by the server,
// which produces them, and the web app, which reads them.
import type { ReviewRun, Upload } from "./upload.ts";

/**
 * `ci` is for the GitHub Action: it can report pull requests and nothing
 * else. `env` is for a cloud agent's environment, which several people start
 * sessions in: it can upload sessions and nothing else, and a cloud session
 * it uploads is filed under the person the platform says started it.
 */
export type Role = "admin" | "member" | "ci" | "env" | "viewer";

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
  /**
   * The owner of the organisation. True when this person signed in and is
   * the owner, and for the bootstrap admin token of a server that is not
   * hosted. A token for a machine is not, even the owner's.
   */
  owner: boolean;
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
  /**
   * The one address people sign in at (`https://app.example.com`), if signing
   * in is set up. Not there from a server from before it was said.
   */
  publicUrl?: string | null;
}

/**
 * Where the dashboard counts which of its pages are opened (`/telemetry`),
 * or null when whoever runs the server has turned that off.
 */
export interface Telemetry {
  /** A PostHog project's public key. */
  key: string;
  /** PostHog's address for events, e.g. `https://eu.i.posthog.com`. */
  host: string;
  /** A service many organisations share, rather than a team's own server. */
  hosted: boolean;
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
  /** The organisation a repository is shown in, open to anyone who signs in, as a viewer who can change nothing. */
  demo?: boolean;
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
  /**
   * They came to view the demo (the website's Demo button): the organisation
   * it is in, to be taken into straight away when it is among `orgs`.
   */
  demo_org?: string;
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
  role: "owner" | "admin" | "member" | "viewer";
  created_at: string;
  removed_at: string | null;
  /**
   * Whose account they sign in with here. Null until they have signed in,
   * and again once their account was forgotten. Not there from an older server.
   */
  signed_in_with?: SignInProvider | null;
}

/** How much of what the agent wrote is still in the files. */
export interface RewriteTotals {
  files_measured: number;
  /** Files where under half of the agent's lines survive, or that are gone. */
  files_rewritten: number;
  lines_added: number;
  lines_surviving: number;
}

/**
 * How much of what the agent wrote was still in the files at a fixed age
 * after each session ended, over the sessions measured at that age. A
 * session is measured at an age by the first sync at or after it, so a
 * session that is younger, or was not synced since, is not among them.
 */
export interface KeptAt {
  /** Tracked lines those sessions added, and how many were there at that age. */
  lines_added: number;
  lines_surviving: number;
  /** Sessions measured at that age. */
  sessions_reached: number;
  /** Sessions with measured lines at all: what `sessions_reached` is out of. */
  sessions_total: number;
}

export interface Totals {
  key: string;
  sessions: number;
  cost_usd: number;
  /** Sessions with no cost figure; `cost_usd` leaves them out. */
  sessions_without_cost: number;
  /** Sessions whose cost is an estimate, or includes one. */
  sessions_with_estimated_cost: number;
  /**
   * `cost_usd` by where the work went, every dollar in one of the three:
   * charged to pull requests that are merged or open (see `PullCost`), to
   * ones closed without merging, or to none. The last is the sessions whose
   * work has not reached a pull request: exploration, abandoned branches,
   * work whose pull request is not open yet, and what a Claude Code session
   * spent on other branches than its pull requests' and the ones those are
   * based on. The three add up to `cost_usd`.
   */
  in_pr_usd: number;
  closed_unmerged_usd: number;
  not_in_pr_usd: number;
  active_ms: number;
  prompts: number;
  tool_calls: number;
  tool_failures: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  input_tokens: number;
  output_tokens: number;
  /**
   * Review runs (`/code-review` and the like) in the sessions that count
   * them; `sessions_reviews_unknown` are from a collector that did not.
   */
  review_runs: number;
  sessions_reviews_unknown: number;
  /** The agents the sessions ran in (`claude-code`, `cursor`, `grok`, `codex`), in name order. */
  tools: string[];
  /** The main model of each session, in name order. Agents that record none add nothing. */
  models: string[];
  /** As last measured, whenever that was: a session that just ended and one from last month together. */
  rewrite: RewriteTotals;
  /** As measured 1, 7 and 30 days after each session ended. */
  kept_1d: KeptAt;
  kept_7d: KeptAt;
  kept_30d: KeptAt;
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
  /** The agent the session ran in: `claude-code`, `cursor`, `grok` or `codex`. */
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
  /** Review runs (`/code-review` and the like). Null when the collector that sent it did not count them. */
  review_runs: number | null;
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

/** Repositories this person stopped submitting (`GET /repos/excluded`). */
export interface ExcludedRepos {
  repos: string[];
  /**
   * How many times this person allowed a repository again. A machine that
   * sees a number it has not seen asks which of its sessions the server
   * still has (`GET /sessions/held`), and sends the others again.
   */
  allowed_again: number;
}

/** The sessions of this person the server has from one machine (`GET /sessions/held?machine=`). */
export interface HeldSessions {
  sessions: { source: string; session_id: string }[];
}

/**
 * Stopping one repository (`PUT /repos/excluded`): sessions of theirs already
 * submitted from it are deleted, and later uploads are not stored.
 */
export interface ExcludedRepo {
  repo: string;
  /** How many of their sessions were deleted. */
  sessions_removed: number;
  /** A path: directories inside it are stopped too. A remote is only itself. */
  covers_folders: boolean;
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
   * agent's). Used for matching; of each, only a hash is stored, to match the
   * lines again when more sessions are held. Without any, every session
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
  /**
   * Its reviews and comments, oldest first: who, when, where, and a link to
   * each on GitHub. Left out by a version of the Action from before these
   * were sent; what the server has is then kept.
   */
  feedback?: PullFeedback[];
  /**
   * How many reviews and comments it has. More than are in `feedback` on a
   * pull request with more than the server takes: the latest are then sent.
   */
  feedback_total?: number;
  /**
   * Who sent the report. Left out, or null, by an Action from before this
   * was sent, and that report is stored with no name. A reporter that is
   * present but does not fit (not an object, or a name that is missing,
   * empty or longer than 50 characters) is stored as `unknown`, another
   * client, and is not read as that older Action. The name of one that
   * does fit is 1 to 50 characters. The version is `X.Y.Z`, each number at
   * most 9 digits, or that with a pre-release suffix (`-` and up to 50 of
   * `0-9`, `A-Z`, `a-z`, `.` or `-`). A version that is neither is left
   * out and the name is still kept. The version is stored only when the
   * name is `sessionly-action`. Another client is not compared with the
   * Action, and neither is a `sessionly-action` version this server cannot
   * read.
   */
  reporter?: { name: string; version?: string };
}

/**
 * A review of a pull request, or a comment on it: who made it, when, on
 * which line, and where it is on GitHub. Never what it says.
 */
export interface PullFeedback {
  /** A review, a comment on a line of the diff, or one in the conversation. */
  kind: "review" | "inline" | "conversation";
  /** Its page on GitHub. */
  url: string | null;
  /** GitHub login of who made it. */
  author: string;
  bot: boolean;
  at: string;
  /** A review's outcome: `approved`, `changes_requested`, `commented` or `dismissed`. */
  state?: string | null;
  /** The file and line a comment on the diff is about. */
  path?: string | null;
  line?: number | null;
  /** A comment on the diff that answers another. */
  reply?: boolean;
}

/** Lines an agent wrote, by which agent and model. */
export interface LinesBy {
  /** The agent: `claude-code`, `cursor`, `grok`, `codex`. */
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

/**
 * What was spent on a pull request: all of what the sessions that
 * contributed lines to it cost, whether or not those lines are still in it.
 * A session is charged to the pull requests it contributed lines to, split
 * between them by the lines it contributed to each at any time, at its
 * opening or in a later push; a line in several counts in the one that had
 * it first (merged first, or of those open, opened first; one closed without
 * merging last), so a later one is charged for what is new in it. Review taking
 * lines out does not lower it.
 * Having lines in a pull request is what makes a session pay for it,
 * whatever branch it began on: a session of an agent that names one branch
 * for all of it, or none, counts whole, so other work it did is charged
 * here too. Where the agent says which branch each turn ran on (Claude
 * Code), what was spent on the pull request's branch and on the one it is
 * based on counts, what was spent on turns that name no branch is shared
 * out by lines, and what was spent on other branches does not count; a pull
 * request on whose own branch such a session spent nothing is charged its
 * share of the whole session by lines, where that is more. It is the cost of
 * those sessions and not of the pull request's whole making: lines that are
 * not put down to a session carry none.
 */
export interface PullCost {
  /** Everything spent on it, review rounds included: the sum of what its sessions are charged here. Null when none of them has a cost figure, or there are none. */
  usd: number | null;
  /** Whether any of those charges is of a cost that is estimated, wholly or in part, or of a session whose split with other pull requests is unsure (see `sessions_unshared`). */
  estimated: boolean;
  /** Sessions that contributed lines to it, now or once, and how many of those have no cost figure or were deleted: `usd` is then a floor. */
  sessions: number;
  sessions_without_cost: number;
  /** How many of them have a cost that leaves requests out (to models without a known price): `usd` is then a floor too. */
  sessions_with_cost_partial: number;
  /**
   * How many of them have lines in several pull requests, in one of which
   * they were kept before which lines they are was: the same ones, perhaps,
   * counted in each. `usd` is then an estimate, until those are matched again.
   */
  sessions_unshared: number;
  /**
   * How many of those have such lines in a pull request that cannot be
   * matched again (see `matchable`): only a new report of it by the Action
   * says which lines they are.
   */
  sessions_unshared_for_good: number;
  /**
   * How many of those without a cost here have one, whose charge is not
   * known yet: after an upgrade the server charges the sessions it held to
   * their pull requests, and until it has, what one is charged here cannot
   * be said. Counted among `sessions_without_cost`.
   */
  sessions_uncounted: number;
  /**
   * What an agent line of it cost: `usd` for what the lines it has now of
   * the sessions charged count as, a line that is in several pull requests
   * counting in the one that had it first. Null when it has none of theirs now,
   * or none that is new in it. A
   * floor when one of those has a cost that leaves requests out.
   */
  per_agent_line_usd: number | null;
  /**
   * What its first version cost: what the sessions with lines among those it
   * was opened with are charged here, all of it. Never more than `usd`: a
   * session that only pushed review fixes is in that and not in this. There
   * when none of those lines is left too. Null on one not reported from the
   * moment it was opened, or last matched before its sessions of then were
   * kept.
   */
  opened_usd: number | null;
  /** Whether a session with lines among those has no cost figure, or one that leaves requests out: `opened_usd` is then a floor. */
  opened_is_floor: boolean;
  /** Whether any of that cost is an estimate, or of a session that is unshared (see `sessions_unshared`). */
  opened_estimated: boolean;
  /** How many of the agent lines it was opened with are still in it, whoever's session wrote them. Null where `opened_usd` is. */
  opened_surviving_lines: number | null;
  /**
   * What an agent line that survived review cost: `opened_usd` for each of
   * them still there, a line it was opened with together with other pull
   * requests counting in part, as its cost does, wherever it survived. Of
   * the sessions with a cost only. Review taking lines out raises it, and
   * lowers no cost. Null when none of those survived in this one.
   */
  per_surviving_line_usd: number | null;
  /** Whether a session with a cost among those leaves requests out: `per_surviving_line_usd` is then a floor. */
  per_surviving_line_is_floor: boolean;
}

/**
 * The review runs (`/code-review` and the like) of a pull request's
 * sessions, before and during review: those of the sessions matched to it,
 * those of a session in its repository that name its number, and those of
 * a session in its repository on its branch that name none (Codex's
 * `/review` never names one), a review-only session too. A run that names another pull request is that
 * one's. Each run counts once. Shown beside the reviews on GitHub, and
 * never added to them.
 */
export interface LocalReviews {
  runs: number;
  /** Of `runs`, those that ran in the cloud (`/ultrareview`, `/code-review ultra`). */
  cloud: number;
  /** Runs by the effort they were given (`xhigh`, `high`); a run given none is in no entry. */
  by_effort: Record<string, number>;
  /** Findings reported, of the runs whose number of them is known. Null when none is. */
  findings: number | null;
  /**
   * What the runs' subagents cost: a floor, without the main thread's own
   * tokens, and already in the sessions' cost (not on top of it). Null when
   * none has a cost; a cloud run's is not known.
   */
  cost_usd: number | null;
  /** Matched sessions that are deleted, or from a collector that did not count review runs: theirs are not known. */
  sessions_unknown: number;
  /**
   * The most other pull requests a matched session that has a run naming
   * none is matched to: such a run is shown on each of them. 0 when none.
   */
  shared_with: number;
  /** Each run, oldest first: the order the pull request was reviewed in. On a pull request's own page only. */
  each?: LocalReviewRun[];
}

/** One review run of a pull request's sessions (see `LocalReviews`), and the session it ran in. */
export interface LocalReviewRun {
  at: string | null;
  /** What was run: "code-review", "ultrareview". */
  command: string;
  effort: string | null;
  /** Where the review itself ran. */
  ran: NonNullable<ReviewRun["ran"]>;
  /** "skill" (the agent ran it), "slash_command" (a person typed it) or "codex_review" (Codex's `/review`). */
  via: NonNullable<ReviewRun["via"]>;
  /** How it went. One that was refused before it began ("denied", "rejected") is not counted and not here. */
  status: NonNullable<ReviewRun["status"]>;
  /** What Codex's `/review` was pointed at: "base_branch", "uncommitted_changes", "commit", "custom". Null for the others. */
  target: string | null;
  /** False for a run that names no pull request, counted here because its session is matched to this one or is on its branch. */
  names_pull: boolean;
  subagents: number;
  /** What its subagents cost: a floor. Null when not known, as for a run in the cloud. */
  cost_usd: number | null;
  findings: number | null;
  machine_id: string;
  source: string;
  session_id: string;
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
  /** Null on a pull request last reported before its sessions were kept. */
  cost: PullCost | null;
  /** Null when no session is matched to it and none names it. */
  local_reviews: LocalReviews | null;
  /** When the Action last reported it. */
  updated_at: string;
  /**
   * When its lines were last matched against the sessions held: at its last
   * report, or later if they were matched again since.
   */
  matched_at: string | null;
  /**
   * Whether its lines can be matched again without a new report. Not so for
   * one last reported before what it is matched by was kept.
   */
  matchable: boolean;
  /**
   * The version of the Sessionly Action that last reported it (`0.2.0`).
   * Null when that report named none, was not from the Action, or named a
   * version this server cannot read.
   */
  reporter_version: string | null;
  /**
   * This pull request was last reported by an older Action. A report from
   * another client is not, and neither is one whose reporter was present
   * but did not fit, nor a `sessionly-action` version this server cannot
   * read. A report that named no one still is.
   */
  reporter_older: boolean;
}

/** A pull request's lines matched again against the sessions held now. */
export interface PullMatch {
  attribution: PullAttribution;
  matched_at: string;
}

/** Several pull requests matched again, some at a time. */
export interface PullMatches {
  /** Matched by this request. */
  matched: number;
  /** Could not be matched by this request, and still among the remaining. */
  failed: number;
  /** Still to be matched: ask again with the same `started` until there are none. */
  remaining: number;
  /** Left as they were: only a new report from the Action can match them. */
  needs_report: number;
  /** When the first request of the run was made; later ones send it back. */
  started: string;
}

/** A file of a pull request: the tracked lines it adds, and how many an agent wrote. */
export interface PullFile {
  path: string;
  lines: number;
  agent_lines: number;
}

/**
 * A session that contributed lines to a pull request: ones it has now, or
 * ones review has taken out since. What is known of the session is null once
 * it has been deleted.
 */
export interface PullSession {
  machine_id: string;
  source: string;
  session_id: string;
  /** Lines of the pull request, as last reported, put down to this session. None when review took them all out. */
  lines: number;
  /** Lines it contributed to the pull request at any time: those, the ones it was opened with, and ones of a push between that are gone since. What its cost is split by. */
  contributed_lines: number;
  /** Line hashes the session uploaded: the lines of it that could be matched to any pull request. Null once it has been deleted, or while they are still to be counted after an upgrade. */
  hashed_lines: number | null;
  /**
   * What it is charged in this pull request: all of what it spent, or its
   * share of that by `contributed_lines` when it contributed to other pull
   * requests too (a line in several counting in the one that had it first). Of a
   * session whose turns name their branches (Claude Code), that is what it
   * spent on the pull request's branch and on the one it is based on, or
   * its share of all of it by lines where it spent nothing on the pull
   * request's own branch and that is more. It does not shrink when
   * lines are taken out. Null where the session has no cost figure, or has
   * been deleted, or is `uncounted`.
   */
  cost_share_usd: number | null;
  /**
   * It has a cost, and what it is charged here is not known yet: after an
   * upgrade the server charges the sessions it held to their pull requests,
   * and has not come to this one.
   */
  uncounted: boolean;
  /**
   * It contributed to other pull requests too, and in one of them which
   * lines they are was not kept: the same ones, perhaps, counted in each.
   * Its share here is then an estimate (see `PullCost.sessions_unshared`).
   */
  unshared: boolean;
  session: Pick<
    SessionRow,
    "owner_email" | "runtime" | "title" | "started_at" | "active_ms" | "cost_usd" | "cost_source" | "primary_model" | "prompts"
  > | null;
}

/**
 * A session's lines in a pull request at one point in its history: which
 * session, and how many of the pull request's lines were put down to it.
 * No line hashes.
 */
export interface PullHistorySession {
  machine_id: string;
  source: string;
  session_id: string;
  lines: number;
}

/**
 * A session named in a change between two reports. `session` is what is
 * known of it now, and null once it has been deleted.
 */
export interface PullHistoryNamedSession extends PullHistorySession {
  session: PullSession["session"] | null;
}

/** A session still matched, whose line count changed. `lines` is the count now. */
export interface PullHistorySessionChange extends PullHistoryNamedSession {
  lines_before: number;
}

/**
 * What changed between one report and the one before it. The first report
 * kept has nothing before it: the before-fields and `reason` are null, and
 * the session lists are empty.
 */
export interface PullHistoryChange {
  lines_before: number | null;
  agent_lines_before: number | null;
  commits_before: number | null;
  /** Sessions matched now that were not before, with their lines. */
  sessions_added: PullHistoryNamedSession[];
  /** Sessions matched before that no longer are. */
  sessions_gone: PullHistoryNamedSession[];
  sessions_changed: PullHistorySessionChange[];
  /**
   * Why the figures moved, in a few words, chosen in this order: new
   * commits (`2 new commits`); fewer commits (`2 commits removed`); sessions
   * uploaded since (`1 session uploaded since: +17 agent lines`); sessions
   * no longer matched; a newer Action (`Action 0.2.0, was 0.1.0`, or
   * `Action 0.2.0` when the one before named no version); a session whose
   * line count changed (`1 session's lines changed: +1 agent lines`);
   * otherwise `matched again, nothing new`. Null on the first report.
   */
  reason: string | null;
}

/**
 * The figures a pull request had at one report, or when it was matched
 * again. Newest first on the page. At most 50 are kept.
 */
export interface PullHistory {
  /** When the figures were worked out. */
  at: string;
  /**
   * What prompted the report: `opened`, `synchronize`, `review`, `closed`,
   * `manual`, or `match` when the lines were matched again on the server.
   */
  event: string;
  commits: number;
  lines: number;
  agent_lines: number;
  /** The sessions matched then, and how many lines of the pull request each had. */
  sessions: PullHistorySession[];
  /**
   * The Action's version on the report that produced these figures. A later
   * report that names a newer one, and moves nothing else, is a later row.
   */
  reporter_version: string | null;
  change: PullHistoryChange;
}

/**
 * A merged pull request's agent lines counted again on the branch it was
 * merged into, 7 or 30 days after: the first count at or after that age.
 * Once made it is kept as it is.
 */
export interface PullAfterMerge {
  checkpoint: "7d" | "30d";
  /** The agent lines it was merged with, of the sessions whose lines are kept. */
  agent_lines: number;
  /** How many of them were in the same files on that branch. */
  surviving: number;
  /** When they were counted, and how long after merging that was: the age, or more. */
  at: string;
  age_seconds: number;
}

/** A merged pull request the Action is asked to count again (`GET /prs/due`). */
export interface PullDue {
  number: number;
  /** The branch it was merged into. */
  base_ref: string | null;
  /** The ages it has reached and has no count for. */
  checkpoints: ("7d" | "30d")[];
  /** The files its agent lines are in: the ones to read on that branch. */
  paths: string[];
}

/** What counting again takes (`PUT /prs/after-merge`): those files as they are on the branch now, as hashes. */
export interface PullAfterMergeReport {
  repo: string;
  number: number;
  /**
   * The ages the files were read for: the ones `GET /prs/due` named. Only
   * these are kept, so an age reached between the reading and the sending is
   * not counted from files read before it.
   */
  checkpoints: ("7d" | "30d")[];
  /** Every path asked for. A file that is gone has no hashes. */
  files: FileHashes[];
}

/**
 * One pull request, with what the list leaves out. `files`, `sessions` and
 * `feedback` are null on a pull request last reported before they were kept.
 */
export interface PullDetail extends PullRow {
  draft: boolean;
  head_ref: string | null;
  base_ref: string | null;
  closed_at: string | null;
  /** Files with tracked lines, most lines first. */
  files: PullFile[] | null;
  /** Most lines first. */
  sessions: PullSession[] | null;
  /** Oldest first. */
  feedback: PullFeedback[] | null;
  /** How many there are on GitHub: more than `feedback` has when only the latest were kept. */
  feedback_total: number | null;
  /**
   * The repository's most recent report from the Action, or that named no
   * reporter, is from an older Action, and none from the last 30 days came
   * from the current Action or a newer one. A pull request another client
   * reported is skipped, including one whose reporter did not fit, and so
   * is one stored before a report said who sent it. A repository with no
   * such report is not old.
   */
  repo_reporter_older: boolean;
  /**
   * The version that most recent report named. Null when it named none, or
   * when the repository has no such report. The repository notice quotes
   * this, not this pull request's version.
   */
  repo_reporter_version: string | null;
  /** The version of the Action this server knows as current. */
  reporter_current: string;
  /** Earlier figures, newest first, each with what changed against the one before it. */
  history: PullHistory[];
  /** Its agent lines 7 and 30 days after merging, the earlier first: those counted so far. */
  after_merge: PullAfterMerge[];
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
  /** Local review runs (see `LocalReviews`), over the `local_reviews_pulls` of its pull requests where they are known. */
  local_reviews: number;
  local_reviews_pulls: number;
}

export interface PullSummary {
  /** Most lines first. */
  by_model: PullsByModel[];
  /**
   * Repositories that have a pull request in the filter and report with an
   * older Action: the most recent report from the Action, or that named no
   * reporter, is old, and none from the last 30 days came from the current
   * Action or a newer one.
   */
  older_actions: string[];
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
    /**
     * What was spent on these pull requests (see `PullCost`): the sum of
     * theirs. Null when none has a cost. Those closed unmerged are in no
     * figure of cost here unless only they are asked for: what was spent on
     * them did not get merged.
     */
    cost_usd: number | null;
    cost_estimated: boolean;
    /**
     * Pull requests whose cost is a floor or not known: some session of
     * theirs has no cost figure or one that leaves requests out, or they
     * have agent lines and were last reported before their sessions were
     * kept. `cost_usd` is then a floor.
     */
    pulls_with_cost_missing: number;
    /** Pull requests closed without merging that have a cost, and are left out of the figures here. */
    pulls_closed_with_cost: number;
    /**
     * The agent lines that survived review of the pull requests reported from
     * the moment they were opened that have a cost, each counted once: a line
     * opened in several of them is one line between them, wherever it
     * survived (`agent_lines_surviving` counts it in each). To two decimals:
     * a line in a pull request left out of these counts only in part.
     */
    agent_lines_surviving_once: number;
    /**
     * Over those pull requests: what the agent lines they were opened with
     * cost (`opened_usd`), for each line `agent_lines_surviving_once` counts.
     * Null when none did.
     */
    per_surviving_line_usd: number | null;
    /** Whether the cost of a session of those lines leaves requests out. */
    per_surviving_line_is_floor: boolean;
    /** Whether any of what those lines cost is an estimate. */
    per_surviving_line_estimated: boolean;
  };
}
