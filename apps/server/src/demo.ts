// One repository's sessions shown in another organisation: a demo anyone may
// be let into, of work that was really done. The sessions stay where they
// were uploaded, with everything they hold. What is copied is made anew from
// what is safe to show (who, when, which models, what it cost, which files
// known to be in the repository, the hashes of their lines), and nothing that
// was typed or run: no prompt, no title, no command, no path outside the
// repository, nor one of it that no pull request reported there names. So
// the organisation they are shown in never holds what must not be seen, and
// nothing that reads from it has to leave anything out.
import { createHash } from "node:crypto";
import {
  parseRepo,
  type AddedLines,
  type Cost,
  type Counts,
  type FileTouched,
  type ModelUsage,
  type PullReport,
  type RewriteMeasurement,
  type Session,
  type Subagent,
  type Upload,
} from "@sessionly/schema";
import type { Principal } from "./auth.ts";
import type { OrgDb } from "./db.ts";
import { IN_WORKTREE, rematchPulls, reportedPaths, type PullFilters } from "./pulls.ts";
import { Conflict, removeUpload, RemovedPerson, storeUpload } from "./sessions.ts";

export interface Demo {
  /** The organisation the sessions are uploaded to. */
  from: string;
  /** The repository, as sessions are filed under it: `github.com/owner/name`. */
  repo: string;
  /** The organisation they are shown in. */
  org: string;
  /** What of the repository is not shown, as `hideFrom` reads SESSIONLY_DEMO_HIDE: names, paths and patterns. */
  hide: string[];
  /** How often the copy is brought up to date. */
  minutes: number;
}

/** One organisation's view of the database, a transaction at a time. */
type Each = <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>;

/**
 * An entry of SESSIONLY_DEMO_HIDE as it is matched: slashes one way, without
 * a leading `/` or `./` or a trailing `/`, and with no empty or `.` folder.
 * Empty when there is nothing left, or when it climbs out with `..`: such
 * an entry could never hide what was meant.
 */
function entryOf(written: string): string {
  const folders = written.trim().replace(/\\/g, "/").split("/").filter((folder) => folder !== "" && folder !== ".");
  return folders.includes("..") ? "" : folders.join("/");
}

const patterns = new Map<string, RegExp>();

/**
 * What one entry hides, as the Action's `ignore` reads it: `*` is anything,
 * `/` too; an entry with a `/` is a path from the repository's root, and one
 * without is a name in any folder. It is tried on the path and on each
 * folder the path is in, so a folder hides everything in it. Letters match
 * in either case, as on a machine whose disk does not tell them apart. One
 * that cannot be matched hides everything: it is not left to hide nothing.
 */
function patternOf(written: string): RegExp {
  let pattern = patterns.get(written);
  if (!pattern) {
    const entry = entryOf(written);
    const body = entry.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    pattern = entry === "" ? /(?:)/ : new RegExp(entry.includes("/") ? `^${body}$` : `(?:^|/)${body}$`, "i");
    patterns.set(written, pattern);
  }
  return pattern;
}

/** Whether a path of the repository, or a folder it is in, is one the entries hide. */
function hidden(file: string, hide: string[]): boolean {
  const folders = file.split("/");
  return folders.some((_, i) => {
    const within = folders.slice(0, i + 1).join("/");
    return hide.some((entry) => patternOf(entry).test(within));
  });
}

/**
 * A path a session names as a path from the repository's root: slashes one
 * way, without `.` or empty folders. Null for one from the home directory or
 * the root, or that climbs out: that is somewhere else on the person's
 * machine. `.` is the repository itself, not a file of it.
 */
function pathOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const plain = path.replace(/\\/g, "/");
  if (/^[/~]|^[A-Za-z]:/.test(plain) || plain.split("/").includes("..")) return null;
  // `./src/a.ts` and `src//a.ts` are `src/a.ts`.
  return plain.split("/").filter((folder) => folder !== "" && folder !== ".").join("/") || null;
}

/**
 * Whether a path a session names is a file of the repository that is not
 * hidden. A hidden path is hidden in a worktree's copy of the repository
 * too, and however its folders are divided: a machine with Windows writes
 * `notes\plan.md`.
 */
export function inRepo(path: string | null | undefined, hide: string[]): path is string {
  const file = pathOf(path);
  if (!file) return false;
  const inWorktree = IN_WORKTREE.exec(file)?.[1];
  return !hidden(file, hide) && !(inWorktree && hidden(inWorktree, hide));
}

/**
 * What a copy is made by: the paths not shown, and the paths known to be
 * in the repository, which are the files of its pull requests reported
 * where it is shown (`reportedPaths`). A file a session wrote and nobody
 * committed (`.env.local`, a note of the person's own) is in none of them.
 */
export interface Rules {
  hide: string[];
  known: ReadonlySet<string>;
}

/** Whether a file of the repository is one known to be in it, or a worktree's copy of one. */
function isKnown(path: string, known: ReadonlySet<string>): boolean {
  const file = pathOf(path);
  if (!file) return false;
  const inWorktree = IN_WORKTREE.exec(file)?.[1];
  return known.has(file) || (inWorktree !== undefined && known.has(inWorktree));
}

/** Whether a path a session names is shown: a file of the repository, not hidden, and known to be in it. */
export function showable(path: string | null | undefined, rules: Rules): path is string {
  return inRepo(path, rules.hide) && isKnown(path, rules.known);
}

/**
 * Whether a session names a file of the repository that is left out only
 * for not being known to be in it yet: its copy is made again when more
 * are known. Every place a path is shown is looked at.
 */
export function withheld(upload: Upload, rules: Rules): boolean {
  const s: Session = upload.session ?? {};
  const paths = [
    ...(s.files ?? []).map((f) => f.path),
    ...(s.tool_calls ?? []).map((t) => t.file_path),
    ...(upload.rewrite?.files ?? []).map((f) => f.path),
    ...(s.instruction_files ?? []),
    ...(upload.lines ?? []).map((l) => l.path),
  ];
  return paths.some((path) => inRepo(path, rules.hide) && !isKnown(path, rules.known));
}

// Each kind of thing in a session, written out field by field, down to the
// last one: what a later version of the record adds to any of them is not
// shown until it is put here. Nothing is passed on whole.

const costOf = (c: Cost | null | undefined): Cost | null =>
  c
    ? {
        total_usd: c.total_usd,
        source: c.source,
        transcript_estimate_usd: c.transcript_estimate_usd,
        unpriced_requests: c.unpriced_requests,
        untracked_usd: c.untracked_usd,
        prompts_covered: c.prompts_covered,
      }
    : null;

const usageOf = (u: ModelUsage): ModelUsage => ({
  model: u.model,
  requests: u.requests,
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  thinking_tokens: u.thinking_tokens,
  cache_read_tokens: u.cache_read_tokens,
  cache_write_5m_tokens: u.cache_write_5m_tokens,
  cache_write_1h_tokens: u.cache_write_1h_tokens,
  estimated_cost_usd: u.estimated_cost_usd,
});

const countsOf = (c: Counts | undefined): Counts | undefined =>
  c && {
    events: c.events,
    prompts: c.prompts,
    tool_calls: c.tool_calls,
    tool_failures: c.tool_failures,
    permission_requests: c.permission_requests,
    permission_denials: c.permission_denials,
    subagents: c.subagents,
    compactions: c.compactions,
    api_errors: c.api_errors,
    files_read: c.files_read,
    files_changed: c.files_changed,
    lines_added: c.lines_added,
    lines_removed: c.lines_removed,
  };

const fileOf = (f: FileTouched): FileTouched => ({
  path: f.path,
  reads: f.reads,
  writes: f.writes,
  created: f.created,
  lines_added: f.lines_added,
  lines_removed: f.lines_removed,
});

// What a subagent was asked to do is a prompt too. Its type may be the name
// of an agent the person made: the agents' own types are not listed
// anywhere this could tell them from one, so none is shown.
const subagentOf = (a: Subagent): Subagent => ({
  agent_id: a.agent_id,
  agent_type: null,
  description: null,
  started_at: a.started_at,
  ended_at: a.ended_at,
  tool_calls: a.tool_calls,
  requests: a.requests,
  input_tokens: a.input_tokens,
  output_tokens: a.output_tokens,
  estimated_cost_usd: a.estimated_cost_usd,
});

const linesOf = (l: AddedLines): AddedLines => ({ path: l.path, model: l.model, hashes: (l.hashes ?? []).map(String) });

/**
 * A tool by its name, but one from an MCP server (`mcp__server__tool`, or
 * `MCP:tool` as Cursor writes it) only as `mcp`: which servers a person has
 * is theirs.
 */
const toolOf = (tool: string | undefined): string | undefined => (tool !== undefined && /^mcp(?:__|:)/i.test(tool) ? "mcp" : tool);

const rewriteOf = (r: RewriteMeasurement | null | undefined, rules: Rules): RewriteMeasurement | null =>
  r
    ? {
        measured_at: r.measured_at,
        branch: r.branch,
        head: r.head,
        files_measured: r.files_measured,
        files_rewritten: r.files_rewritten,
        lines_added: r.lines_added,
        lines_surviving: r.lines_surviving,
        files: (r.files ?? [])
          .filter((f) => showable(f.path, rules))
          .map((f) => ({ path: f.path, lines_added: f.lines_added, lines_surviving: f.lines_surviving, exists: f.exists })),
      }
    : null;

/** A session as it is shown: of its paths, only those that are `showable`. */
export function shown(upload: Upload, rules: Rules): Upload {
  const s: Session = upload.session ?? {};
  return {
    schema_version: upload.schema_version,
    session: {
      schema_version: s.schema_version,
      source: s.source,
      collector_version: s.collector_version,
      machine_id: s.machine_id,
      captured_by: s.captured_by,
      content: "metadata",
      session_id: s.session_id,
      // Made from the first prompt.
      title: null,
      user: s.user ? { name: s.user.name ?? null, email: s.user.email ?? null } : null,
      // Whether it ran in the cloud, which its pull requests are matched by; not the platform's id for it.
      runtime: s.runtime ? { kind: s.runtime.kind, id: null } : null,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_ms: s.duration_ms,
      active_ms: s.active_ms,
      end_reason: s.end_reason,
      captured_from_start: s.captured_from_start,
      cwd: null,
      // Where the clone is on the person's machine is theirs. The branch is
      // how a cloud session is matched to its pull request (`claimsFor`).
      repo: s.repo ? { remote: s.repo.remote ?? null, branch: s.repo.branch ?? null } : null,
      agent_version: s.agent_version,
      entrypoint: s.entrypoint,
      models: (s.models ?? []).map(String),
      permission_modes: (s.permission_modes ?? []).map(String),
      cost: costOf(s.cost),
      usage: (s.usage ?? []).map(usageOf),
      counts: countsOf(s.counts),
      // When, and how each ended. Of what was typed, not its length even: nor a hash, which a short one is found by.
      prompts: (s.prompts ?? []).map((p) => ({ prompt_id: p.prompt_id, at: p.at, ended_at: p.ended_at, outcome: p.outcome })),
      // Which tool, when, and how it went: not what it was given, nor what it said went wrong.
      tool_calls: (s.tool_calls ?? []).map((t) => ({
        tool_use_id: t.tool_use_id,
        prompt_id: t.prompt_id,
        agent_id: t.agent_id,
        tool: toolOf(t.tool),
        model: t.model,
        at: t.at,
        status: t.status,
        duration_ms: t.duration_ms,
        file_path: showable(t.file_path, rules) ? t.file_path : null,
        output_bytes: t.output_bytes,
        lines_added: t.lines_added,
        lines_removed: t.lines_removed,
      })),
      files: (s.files ?? []).filter((f) => showable(f.path, rules)).map(fileOf),
      subagents: (s.subagents ?? []).map(subagentOf),
      instruction_files: (s.instruction_files ?? []).filter((path) => showable(path, rules)),
    },
    rewrite: rewriteOf(upload.rewrite, rules),
    lines: linesShown(upload.lines ?? [], rules),
  };
}

/**
 * The lines of the files that are shown, and of the others only how many
 * there were. What a session cost a pull request is its cost in the
 * proportion of its lines there to all the lines it hashed (`sharesIn` in
 * pulls.ts): without the others it would cost more here than it did. They
 * are counted as one entry of no path and no model, with an empty string for
 * each line. No line of a pull request has an empty path, and no hash of one
 * is empty, so they are never taken to have written one; and a session's
 * files are its `files`, which this is not in.
 */
function linesShown(lines: AddedLines[], rules: Rules): AddedLines[] {
  const shownLines = lines.filter((l) => showable(l.path, rules)).map(linesOf);
  const others = lines.filter((l) => !showable(l.path, rules)).reduce((sum, l) => sum + (l.hashes ?? []).length, 0);
  return others > 0 ? [...shownLines, { path: "", model: null, hashes: Array<string>(others).fill("") }] : shownLines;
}

/**
 * A pull request's report as it is kept where the repository is shown:
 * without the files that are not shown, and with no word of where a comment
 * on one of them is. The Action reports every file; this is where the ones
 * not shown stop.
 */
export function shownReport(report: PullReport, hide: string[]): PullReport {
  return {
    ...report,
    files: report.files.filter((f) => inRepo(f.path, hide)),
    feedback: report.feedback?.map((f) => (f.path == null || inRepo(f.path, hide) ? f : { ...f, path: null, line: null })),
  };
}

/**
 * The rules a copy was made by: what is left out here, and the paths not
 * shown. A copy made by others is made again. Raise the number when `shown`
 * leaves out more than it did.
 */
const SHOWN_VERSION = 2;
export const rulesOf = (hide: string[]): string =>
  createHash("sha256").update(JSON.stringify([SHOWN_VERSION, hide.map(entryOf).sort()])).digest("hex").slice(0, 16);

/** The paths known to be in the repository, as a short hash: a copy made against others may show more now. */
const knownOf = (paths: string[]): string => createHash("sha256").update(JSON.stringify([...paths].sort())).digest("hex").slice(0, 16);

/**
 * A session where it is uploaded: under whom, when it was last stored (to
 * the microsecond, as text), when it started, and the branch of one that ran
 * in the cloud.
 */
interface Theirs {
  machine_id: string;
  source: string;
  session_id: string;
  owner_email: string;
  sent: string;
  started: string | null;
  cloud_branch: string | null;
}

const THEIRS = `machine_id, source, session_id, owner_email, updated_at::text AS sent, started_at::text AS started,
                CASE WHEN runtime = 'cloud' THEN branch END AS cloud_branch`;

/**
 * What was sent of one to where it is shown: by which rules, against which
 * known paths and whether it left one out for not being known, whether a
 * copy of it was kept there, and under whom the session is there now (null
 * when it is not). Whose it is is read from the session itself, so the note
 * keeps no address of its own, and goes nowhere a person's removal does not
 * reach.
 */
interface Sent {
  machine_id: string;
  source: string;
  session_id: string;
  sent_at: string;
  rules: string;
  known: string;
  withheld: boolean;
  stored: boolean;
  here: string | null;
  removed: boolean;
  /** Turned down more than `DECLINED_HOURS` ago. */
  declined_long_ago: boolean;
  /** How often its person had allowed a repository again there when it was turned down. */
  allowed_again: unknown;
}

/** How long one turned down is left before it is offered again, when nothing else says it may be taken now. */
const DECLINED_HOURS = 24;

const SENT = `SELECT k.machine_id, k.source, k.session_id, k.sent_at, k.rules, k.known, k.withheld, k.stored,
                     s.owner_email AS here, k.removed_at IS NOT NULL AS removed, k.allowed_again,
                     coalesce(k.declined_at < now() - interval '${DECLINED_HOURS} hours', false) AS declined_long_ago
              FROM shown_sessions k
              LEFT JOIN sessions s ON s.org_id = k.org_id AND s.machine_id = k.machine_id AND s.source = k.source
                AND s.session_id = k.session_id
              WHERE k.org_id = $1`;

const keyOf = (s: { machine_id: string; source: string; session_id: string }): string => `${s.machine_id}\n${s.source}\n${s.session_id}`;

/** Whoever a session is filed under, storing or removing their own in the organisation it is shown in. */
const as = (orgId: string, email: string): Principal => ({
  orgId,
  email,
  name: null,
  role: "member",
  tokenId: null,
  userId: null,
  signedIn: false,
  owner: false,
});

/**
 * How the organisation it is shown in turns a session down by throwing: it
 * is someone else's there, or its person was removed.
 */
const refused = (err: unknown): boolean => err instanceof Conflict || err instanceof RemovedPerson;

/** How long a session that was removed is remembered to have been: by then every pull request has been matched since. */
const REMEMBERED_DAYS = 7;

/**
 * Copies in a row that found none of the repository's sessions where they
 * are uploaded before what was sent of it is removed. A name that matches
 * nothing (a repository named wrong, or one moved) would otherwise empty
 * the demo at once; a repository whose sessions were all taken back is
 * emptied an hour or so later instead, at the default 30 minutes. The count
 * is kept in the database, so a server started again does not start it again.
 */
export const EMPTY_COPIES = 3;

export interface CopyOptions {
  /** SESSIONLY_HASH_KEY, which the pull requests' committers are kept with. */
  key?: string;
  /** Where what goes wrong, and what is held back, is said. */
  log?: (err: unknown) => void;
}

export interface Copied {
  copied: number;
  kept: number;
  removed: number;
  failed: number;
  matched: number;
}

/**
 * One more copy in a row that found none of the repository's sessions, or
 * the count back to none when this one found some: how many there are now.
 */
async function countEmpty(db: OrgDb, none: boolean): Promise<number> {
  if (!none) {
    await db.query(`DELETE FROM shown_empty_copies WHERE org_id = $1`, [db.orgId]);
    return 0;
  }
  const [row] = await db.query<{ copies: unknown }>(
    `INSERT INTO shown_empty_copies (org_id, copies) VALUES ($1, 1)
     ON CONFLICT (org_id) DO UPDATE SET copies = shown_empty_copies.copies + 1 RETURNING copies`,
    [db.orgId],
  );
  return Number(row?.copies ?? 1);
}

/**
 * Match again the pull requests the filters choose that a copy or a removal
 * may have changed since they were last matched (`shown_changed`), some at a
 * time, as the page's own button does it, until none is left or none gets
 * further. That goes by what is kept, so one this could not get to (the
 * server stopped) is matched the next time.
 */
async function matchAgain(to: Each, filters: PullFilters, key: string | undefined, log: (err: unknown) => void): Promise<{ matched: number; failed: number }> {
  let matched = 0;
  let failed = 0;
  for (;;) {
    const some = await rematchPulls(to, { ...filters, shown_changed: true }, undefined, key, log);
    matched += some.matched;
    failed += some.failed;
    if (some.remaining === 0 || some.matched === 0) return { matched, failed };
  }
}

/**
 * Bring the organisation the repository is shown in up to date: sessions
 * that are new, were stored again since they were sent, were sent by other
 * rules or are not there any more are copied, and ones that are gone (taken
 * back, their repository stopped, the repository shown another now) are
 * removed there too. Each is stored like an upload, in a transaction of its
 * own, so one that fails is said (`log`) and leaves the others.
 *
 * A path is shown only when it is known to be in the repository: a file of
 * one of its pull requests reported there. Those are read once a copy, and
 * a session that left one out for not being known is copied again once more
 * are known.
 *
 * One the organisation turned down (its person stopped the repository
 * there, or was removed, or it is someone else's there) is noted as such,
 * and offered again when it changes, when its person has allowed a
 * repository again there since, or a day later. When it was to replace a
 * copy made by other rules, that copy is removed: it shows what these may
 * hide. One to replace a copy by the same rules leaves that copy as it is.
 *
 * `from` is null when the organisation they are uploaded to is gone:
 * everything sent from it is removed. When it is there and has none of the
 * repository's sessions, what was sent is left until it has had none on
 * `EMPTY_COPIES` copies in a row.
 *
 * Then the pull requests of the repository there that a copy or a removal
 * may have changed since they were last matched are matched again
 * (`matchAgain`): a report of one comes before the sessions that wrote it,
 * which are copied later.
 *
 * Only sessions this sent are ever removed where they are shown.
 */
export async function copyRepo(
  from: Each | null,
  to: Each,
  demo: Pick<Demo, "repo" | "hide">,
  { key, log = () => {} }: CopyOptions = {},
): Promise<Copied> {
  const rules = rulesOf(demo.hide);
  // The repository's name in any case: `GitHub.com/Acme/Shown` is the same one.
  const theirs = from
    ? await from((db) => db.query<Theirs>(`SELECT ${THEIRS} FROM sessions WHERE org_id = $1 AND lower(repo) = lower($2)`, [db.orgId, demo.repo]))
    : [];
  const there = await to(async (db) => ({
    paths: await reportedPaths(db, demo.repo),
    sent: await db.query<Sent>(SENT, [db.orgId]),
    allowed: await db.query<{ owner_email: string; times: unknown }>(`SELECT owner_email, times FROM repos_allowed_again WHERE org_id = $1`, [db.orgId]),
  }));
  const known = knownOf(there.paths);
  const by: Rules = { hide: demo.hide, known: new Set(there.paths) };
  const sent = new Map(there.sent.map((s) => [keyOf(s), s]));
  const allowedAgain = new Map(there.allowed.map((row) => [row.owner_email, Number(row.times)]));
  const timesOf = (s: Theirs) => allowedAgain.get(s.owner_email) ?? 0;
  // What was sent is what is there, by these rules, under the same person and with every path known now that
  // it names; or was turned down as it is, and nothing since says it would be taken now: nothing to do.
  const current = (had: Sent, s: Theirs) =>
    !had.removed &&
    had.sent_at === s.sent &&
    had.rules === rules &&
    !(had.withheld && had.known !== known) &&
    (had.stored ? had.here === s.owner_email : !had.declined_long_ago && Number(had.allowed_again) === timesOf(s));
  // Whether a copy is kept is what is there after this, and was this one's to begin with. When what is
  // there changed is what says which pull requests are to be matched again; a removal noted before is kept in it.
  const note = async (db: OrgDb, s: Theirs, made: { ours: boolean; copied: boolean; withheld: boolean }) => {
    const which = [db.orgId, s.machine_id, s.source, s.session_id];
    const [here] = await db.query<{ is: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM sessions WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4) AS is`,
      which,
    );
    const stored = made.ours && here?.is === true;
    await db.query(
      `INSERT INTO shown_sessions (org_id, machine_id, source, session_id, sent_at, rules, known, withheld, stored,
                                   started_at, cloud_branch, copied_at, declined_at, allowed_again)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::boolean, $9::boolean, $10::timestamptz, $11, clock_timestamp(),
               CASE WHEN $9::boolean THEN NULL ELSE clock_timestamp() END, $12)
       ON CONFLICT (org_id, machine_id, source, session_id) DO UPDATE
       SET sent_at = EXCLUDED.sent_at, rules = EXCLUDED.rules, known = EXCLUDED.known, withheld = EXCLUDED.withheld,
           stored = EXCLUDED.stored, started_at = EXCLUDED.started_at, cloud_branch = EXCLUDED.cloud_branch,
           copied_at = CASE WHEN $13::boolean OR shown_sessions.stored <> EXCLUDED.stored THEN clock_timestamp()
                            ELSE greatest(shown_sessions.copied_at, coalesce(shown_sessions.removed_at, shown_sessions.copied_at)) END,
           removed_at = NULL, declined_at = EXCLUDED.declined_at, allowed_again = EXCLUDED.allowed_again`,
      [...which, s.sent, rules, known, made.withheld, stored, s.started, s.cloud_branch, timesOf(s), made.copied],
    );
  };
  // Filed under another person since: theirs now, and not a copy beside the old one.
  const moved = async (db: OrgDb, had: Sent | undefined, owner: string): Promise<boolean> =>
    had?.stored === true && had.here !== null && had.here !== owner && (await removeUpload(db, as(db.orgId, had.here), had));
  // A copy by other rules, where none by these is to be had.
  const outdated = async (db: OrgDb, had: Sent | undefined): Promise<boolean> =>
    had?.stored === true && had.rules !== rules && had.here !== null && (await removeUpload(db, as(db.orgId, had.here), had));
  let copied = 0;
  let kept = 0;
  let removed = 0;
  let failed = 0;
  const count = (done: "copied" | "kept" | "removed") => {
    if (done === "copied") copied += 1;
    else if (done === "kept") kept += 1;
    else removed += 1;
  };
  for (const s of theirs) {
    const had = sent.get(keyOf(s));
    sent.delete(keyOf(s));
    if (had && current(had, s)) continue;
    // Not to be kept when it was made by other rules and this one is turned down.
    const keeps = had?.stored === true && had.rules === rules;
    let row: (Theirs & { payload: unknown }) | undefined;
    let unknown = false;
    try {
      // With when it was stored, as this statement saw it: one stored again a moment later has another time, and is sent the next time.
      [row] = await from!((db) =>
        db.query<Theirs & { payload: unknown }>(
          `SELECT ${THEIRS}, payload FROM sessions
           WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4 AND lower(repo) = lower($5)`,
          [db.orgId, s.machine_id, s.source, s.session_id, demo.repo],
        ),
      );
      // Gone in the moment since: the next time removes it here.
      if (!row) continue;
      const theirRow = row;
      const upload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Upload;
      unknown = withheld(upload, by);
      const made = shown(upload, by);
      const withheldHere = unknown;
      count(
        await to(async (db) => {
          const went = await moved(db, had, theirRow.owner_email);
          const { stored } = await storeUpload(db, made, as(db.orgId, theirRow.owner_email));
          const dropped = !stored && (await outdated(db, had));
          // Noted whether or not it was stored: one the organisation would not take is offered again only when that may have changed.
          await note(db, theirRow, { ours: stored || keeps, copied: stored, withheld: withheldHere });
          return stored ? "copied" : went || dropped ? "removed" : "kept";
        }),
      );
    } catch (err) {
      if (row && refused(err)) {
        // Turned down, and all of it undone: noted on its own, so that it is not offered again and again.
        const theirRow = row;
        const withheldHere = unknown;
        try {
          count(
            await to(async (db) => {
              const went = await moved(db, had, theirRow.owner_email);
              const dropped = await outdated(db, had);
              await note(db, theirRow, { ours: keeps, copied: false, withheld: withheldHere });
              return went || dropped ? "removed" : "kept";
            }),
          );
          continue;
        } catch (noting) {
          err = noting;
        }
      }
      failed += 1;
      log(err);
    }
  }
  // What is left was sent once and is in the repository no more.
  const left = [...sent.values()].filter((gone) => !gone.removed);
  const none = from !== null && theirs.length === 0 && left.some((gone) => gone.stored && gone.here !== null);
  const empty = await to((db) => countEmpty(db, none));
  const holding = none && empty < EMPTY_COPIES;
  if (holding) {
    log(
      `there are no sessions of ${demo.repo} where they are uploaded: what was copied of it is left as it is, ` +
        `and removed if there are none on ${EMPTY_COPIES} copies in a row (${empty} so far).`,
    );
  }
  for (const gone of holding ? [] : left) {
    try {
      if (await to((db) => removeSent(db, gone))) removed += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  await to((db) => db.query(`DELETE FROM shown_sessions WHERE org_id = $1 AND removed_at < now() - $2 * interval '1 day'`, [db.orgId, REMEMBERED_DAYS]));
  const again = await matchAgain(to, { sessions_repo: demo.repo }, key, log);
  return { copied, kept, removed, failed: failed + again.failed, matched: again.matched };
}

/**
 * Remove one session this sent, if a copy of it is there. That it was there,
 * and when it went, is all that is kept a while; one that never was is forgotten.
 */
async function removeSent(db: OrgDb, gone: Sent): Promise<boolean> {
  const went = gone.stored && gone.here !== null && (await removeUpload(db, as(db.orgId, gone.here), gone));
  const which = [db.orgId, gone.machine_id, gone.source, gone.session_id];
  if (went) {
    await db.query(`UPDATE shown_sessions SET removed_at = clock_timestamp() WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`, which);
  } else {
    await db.query(`DELETE FROM shown_sessions WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`, which);
  }
  return went;
}

/**
 * Take back everything this sent to an organisation no repository is shown
 * in any more (another one is named now, or none): each copy is removed, the
 * pull requests there that were matched with them are matched again, and
 * then what was noted of them is forgotten. The notes go last, and only
 * when nothing failed, so that one cut short is finished the next time.
 */
export async function unshow(to: Each, { key, log = () => {} }: CopyOptions = {}): Promise<{ removed: number; failed: number; matched: number }> {
  const sent = await to((db) => db.query<Sent>(SENT, [db.orgId]));
  let removed = 0;
  let failed = 0;
  for (const gone of sent.filter((s) => !s.removed)) {
    try {
      if (await to((db) => removeSent(db, gone))) removed += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  const again = await matchAgain(to, {}, key, log);
  if (failed + again.failed === 0) {
    await to(async (db) => {
      await db.query(`DELETE FROM shown_sessions WHERE org_id = $1`, [db.orgId]);
      await db.query(`DELETE FROM shown_empty_copies WHERE org_id = $1`, [db.orgId]);
    });
  }
  return { removed, failed: failed + again.failed, matched: again.matched };
}

/** The settings of a demo, and the default of the one that has one. */
const SETTINGS = ["SESSIONLY_DEMO_FROM", "SESSIONLY_DEMO_REPO", "SESSIONLY_DEMO_ORG"] as const;
const EVERY_MINUTES = 30;

/**
 * SESSIONLY_DEMO_HIDE as entries: separated by commas or new lines, a blank
 * one being no entry. Each is a file name, a path from the repository's
 * root, a folder, or a pattern with `*`, with a leading `/` or `./` taken
 * off (see `patternOf`). One that is nothing once that and a trailing `/`
 * are taken off (`/`, `.`), or that climbs out with `..`, could only hide
 * nothing, or not what was meant: the whole setting is then not used.
 */
export function hideFrom(text: string | undefined): { hide: string[] } | { problem: string } {
  const written = (text ?? "").split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  const unusable = written.filter((entry) => entryOf(entry) === "");
  if (unusable.length) {
    return {
      problem:
        `SESSIONLY_DEMO_HIDE: ${unusable.map((entry) => `"${entry}"`).join(", ")} cannot be matched to paths of the repository ` +
        `(an entry is a file name, a path from its root, a folder or a pattern with *, and does not climb out with ..). ` +
        `The repository is not shown, and pull requests reported to SESSIONLY_DEMO_ORG are refused, until it is put right.`,
    };
  }
  return { hide: written.map(entryOf) };
}

/**
 * A repository named as sessions are filed under it (`github.com/owner/name`),
 * however it is written: as the collector makes the name of a remote
 * (crates/sessionly/src/git.rs), without the scheme, the credentials, the
 * port or `.git`, and as `parseRepo` writes one, without a trailing slash;
 * and with the host in small letters. Null for one that is not a remote: a
 * folder, or nothing.
 */
export function repoOf(text: string): string | null {
  const parsed = parseRepo(text);
  if (!parsed.ok || parsed.name.coversFolders) return null;
  let name = parsed.name.repo;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(name);
  if (scheme) name = name.slice(scheme[0].length);
  else name = name.replace(/^([^/:]+):(?!\/)/, "$1/");
  const [authority = "", ...path] = name.split("/");
  const host = authority.slice(authority.lastIndexOf("@") + 1).split(":")[0]!.toLowerCase();
  const rest = path.join("/").replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !rest || /\s/.test(`${host}/${rest}`)) return null;
  return `${host}/${rest}`;
}

/**
 * Where pull request reports are kept without the paths not shown: in
 * SESSIONLY_DEMO_ORG whenever it is set, whatever else is wrong with the
 * settings, so that a mistake in one of them never lets a report in whole.
 * With SESSIONLY_DEMO_HIDE not to be trusted, reports there are refused.
 */
export function reportsShownIn(env: NodeJS.ProcessEnv): { org: string; hide: string[] } | { org: string; problem: string } | undefined {
  const org = env.SESSIONLY_DEMO_ORG?.trim();
  if (!org) return undefined;
  const hide = hideFrom(env.SESSIONLY_DEMO_HIDE);
  return "problem" in hide ? { org, problem: hide.problem } : { org, hide: hide.hide };
}

/**
 * The demo the settings ask for: undefined if they ask for none, and what is
 * wrong with them otherwise. All three of where from, which repository and
 * where to are needed, and the two organisations are not the same one: what
 * is shown is made without most of what a session holds, and would replace
 * the session itself.
 */
export function demoFrom(env: NodeJS.ProcessEnv): Demo | { problem: string } | undefined {
  const [from, written, org] = SETTINGS.map((name) => env[name]?.trim() ?? "");
  const set = SETTINGS.filter((name) => env[name]?.trim());
  if (set.length === 0) return undefined;
  if (set.length < SETTINGS.length) {
    return { problem: `Only ${set.join(" and ")} of ${SETTINGS.join(", ")} ${set.length === 1 ? "is" : "are"} set: showing a repository in another organisation needs all three, and is off.` };
  }
  if (from === org) return { problem: "SESSIONLY_DEMO_FROM and SESSIONLY_DEMO_ORG name the same organisation: a repository is shown in another one, and this is off." };
  const repo = repoOf(written!);
  if (!repo) {
    return { problem: "SESSIONLY_DEMO_REPO is not a repository as sessions are filed under it (github.com/owner/name): showing a repository in another organisation is off." };
  }
  const hide = hideFrom(env.SESSIONLY_DEMO_HIDE);
  if ("problem" in hide) return hide;
  const minutes = Number(env.SESSIONLY_DEMO_MINUTES?.trim() || EVERY_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    return { problem: "SESSIONLY_DEMO_MINUTES is not a whole number of minutes from 1 to 1440: showing a repository in another organisation is off." };
  }
  return { from: from!, repo, org: org!, hide: hide.hide, minutes };
}
