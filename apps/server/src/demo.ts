// One repository's sessions shown in another organisation: a demo anyone may
// be let into, of work that was really done. `importDemo` copies them, and is
// run again (`node src/cli.ts demo import`) to bring them up to date. The
// sessions stay where they were uploaded, with everything they hold. What is
// copied is made anew from
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
  type FileHashes,
  type FileTouched,
  type ModelUsage,
  type PullFeedback,
  type PullFile,
  type PullReport,
  type RewriteMeasurement,
  type Session,
  type Subagent,
  type Upload,
} from "@sessionly/schema";
import type { Principal } from "./auth.ts";
import type { OrgDb } from "./db.ts";
import { holdPull, IN_WORKTREE, rematchPulls, reportedPaths } from "./pulls.ts";
import { Conflict, forgetLines, RemovedPerson, storeUpload } from "./sessions.ts";

export interface Demo {
  /** The organisation the sessions are uploaded to. */
  from: string;
  /** The repository, as sessions are filed under it: `github.com/owner/name`. */
  repo: string;
  /** The organisation they are shown in. */
  org: string;
  /** What of the repository is not shown, as `hideFrom` reads SESSIONLY_DEMO_HIDE: names, paths and patterns. */
  hide: string[];
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
 * Whoever can report pull requests there decides which those are.
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

/**
 * A shown path as it is written in the copy: from the repository's root with
 * slashes one way, as a pull request names it, and in a worktree under no
 * name of the person's (the folder is named after a branch or a task). A
 * known file that is in a folder called `worktrees` is that file.
 */
function pathShown<T extends string | null | undefined>(path: T, rules: Rules): T {
  const file = pathOf(path);
  if (!file || rules.known.has(file)) return (file ?? path) as T;
  return file.replace(/^((?:.*\/)?\.?worktrees)\/[^/]+\//, "$1/worktree/") as T;
}

/** Whether a path a session names is shown: a file of the repository, not hidden, and known to be in it. */
export function showable(path: string | null | undefined, rules: Rules): path is string {
  return inRepo(path, rules.hide) && isKnown(path, rules.known);
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

const fileOf = (f: FileTouched, rules: Rules): FileTouched => ({
  path: pathShown(f.path, rules),
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

const linesOf = (l: AddedLines, rules: Rules): AddedLines => ({ path: pathShown(l.path, rules), model: l.model, hashes: (l.hashes ?? []).map(String) });

/**
 * A tool by its name, but one from an MCP server (`mcp__server__tool`, or
 * `MCP:tool` as Cursor writes it) only as `mcp`: which servers a person has
 * is theirs.
 */
const toolOf = (tool: string | undefined): string | undefined => (tool !== undefined && /^mcp(?:__|:)/i.test(tool) ? "mcp" : tool);

// A branch is named by the person, and one never pushed is theirs alone. Only a cloud session's is shown: it is how
// that session is matched to its pull request (`claimsFor`), and a cloud agent named it.
const rewriteOf = (r: RewriteMeasurement | null | undefined, rules: Rules, cloud: boolean): RewriteMeasurement | null =>
  r
    ? {
        measured_at: r.measured_at,
        branch: cloud ? r.branch : null,
        head: cloud ? r.head : null,
        files_measured: r.files_measured,
        files_rewritten: r.files_rewritten,
        lines_added: r.lines_added,
        lines_surviving: r.lines_surviving,
        files: (r.files ?? [])
          .filter((f) => showable(f.path, rules))
          .map((f) => ({ path: pathShown(f.path, rules), lines_added: f.lines_added, lines_surviving: f.lines_surviving, exists: f.exists })),
      }
    : null;

/** A session as it is shown: of its paths, only those that are `showable`. */
export function shown(upload: Upload, rules: Rules): Upload {
  const s: Session = upload.session ?? {};
  const cloud = s.runtime?.kind === "cloud";
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
      // Where the clone is on the person's machine is theirs, and so is the branch of one that ran there (`rewriteOf`).
      repo: s.repo ? { remote: s.repo.remote ?? null, branch: cloud ? (s.repo.branch ?? null) : null } : null,
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
        file_path: showable(t.file_path, rules) ? pathShown(t.file_path, rules) : null,
        output_bytes: t.output_bytes,
        lines_added: t.lines_added,
        lines_removed: t.lines_removed,
      })),
      files: (s.files ?? []).filter((f) => showable(f.path, rules)).map((f) => fileOf(f, rules)),
      subagents: (s.subagents ?? []).map(subagentOf),
      instruction_files: (s.instruction_files ?? []).filter((path) => showable(path, rules)).map((path) => pathShown(path, rules)),
    },
    rewrite: rewriteOf(upload.rewrite, rules, cloud),
    lines: linesShown(upload.lines ?? [], rules),
    // Counts and times of the whole session, as its cost is: of no file by name.
    checkpoints: upload.checkpoints?.map((c) => ({
      checkpoint: c.checkpoint,
      added: c.added,
      surviving: c.surviving,
      measured_at: c.measured_at,
      age_seconds: c.age_seconds,
    })),
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
  const shownLines = lines.filter((l) => showable(l.path, rules)).map((l) => linesOf(l, rules));
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
  return { ...report, files: filesShown(report.files, hide), feedback: feedbackShown(report.feedback, hide) };
}

const filesShown = <T extends { path: string }>(files: T[], hide: string[]): T[] => files.filter((f) => inRepo(f.path, hide));

const feedbackShown = (feedback: PullFeedback[] | undefined, hide: string[]): PullFeedback[] | undefined =>
  feedback?.map((f) => (f.path == null || inRepo(f.path, hide) ? f : { ...f, path: null, line: null }));

/** A session's lines in a pull request, by file (`pull_sessions`), without the files not shown. */
const matchedShown = (matched: Record<string, string[]> | null, hide: string[]): Record<string, string[]> | null =>
  matched && Object.fromEntries(Object.entries(matched).filter(([path]) => inRepo(path, hide)));

const jsonOf = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Take out of one pull request kept where the repository is shown what is
 * not shown now: its files as first and as last reported, the files of its
 * page, where its comments are, and which of its lines each session wrote.
 * One that had any is left to be matched again (no time it was matched).
 * Whether anything was taken out.
 */
async function hidePull(db: OrgDb, repo: string, number: number, hide: string[], rules: string): Promise<boolean> {
  // As a report holds it: one arriving meanwhile waits, and then keeps the first files as they are after this.
  await holdPull(db, repo, number);
  const [r] = await db.query<{ first_files: unknown; last_files: unknown; detail: unknown; feedback: unknown }>(
    `SELECT first_files, last_files, detail, feedback FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
    [db.orgId, repo, number],
  );
  if (!r) return false;
  const was = {
    first: jsonOf<FileHashes[]>(r.first_files),
    last: jsonOf<FileHashes[]>(r.last_files),
    detail: r.detail == null ? null : jsonOf<{ files?: PullFile[] }>(r.detail),
    feedback: r.feedback == null ? null : jsonOf<PullFeedback[]>(r.feedback),
  };
  const now = {
    first: filesShown(was.first, hide),
    last: filesShown(was.last, hide),
    detail: was.detail && { ...was.detail, files: was.detail.files && filesShown(was.detail.files, hide) },
    feedback: was.feedback && feedbackShown(was.feedback, hide)!,
  };
  const sessions = await db.query<{ machine_id: string; source: string; session_id: string; matched: unknown; opened_matched: unknown }>(
    `SELECT machine_id, source, session_id, matched, opened_matched FROM pull_sessions WHERE org_id = $1 AND repo = $2 AND number = $3`,
    [db.orgId, repo, number],
  );
  let changed = !same(was, now);
  for (const s of sessions) {
    const matched = s.matched == null ? null : jsonOf<Record<string, string[]>>(s.matched);
    const opened = s.opened_matched == null ? null : jsonOf<Record<string, string[]>>(s.opened_matched);
    if (same(matched, matchedShown(matched, hide)) && same(opened, matchedShown(opened, hide))) continue;
    changed = true;
    await db.query(
      `UPDATE pull_sessions SET matched = $7::jsonb, opened_matched = $8::jsonb
       WHERE org_id = $1 AND repo = $2 AND number = $3 AND machine_id = $4 AND source = $5 AND session_id = $6`,
      [db.orgId, repo, number, s.machine_id, s.source, s.session_id, jsonOrNull(matchedShown(matched, hide)), jsonOrNull(matchedShown(opened, hide))],
    );
  }
  await db.query(
    `UPDATE pull_requests SET first_files = $4::jsonb, last_files = $5::jsonb, detail = $6::jsonb, feedback = $7::jsonb,
            shown_rules = $8, matched_at = CASE WHEN $9::boolean THEN NULL ELSE matched_at END
     WHERE org_id = $1 AND repo = $2 AND number = $3`,
    [db.orgId, repo, number, JSON.stringify(now.first), JSON.stringify(now.last), jsonOrNull(now.detail), jsonOrNull(now.feedback), rules, changed],
  );
  return changed;
}

/** As a JSON column takes it: null is no value, not the JSON `null`. */
const jsonOrNull = (value: unknown): string | null => (value == null ? null : JSON.stringify(value));

/**
 * Take out of the pull requests kept where the repository is shown what is
 * not shown now, wherever they were last gone through by other rules (or
 * never): reports are kept without it from the moment it is not shown, but
 * the first report of a pull request is kept for good. The import matches
 * them all again after. How many could not be gone through, which are gone
 * through the next time.
 */
async function hideInPulls(to: Each, hide: string[], log: (err: unknown) => void): Promise<number> {
  const rules = rulesOf(hide);
  const due = await to((db) =>
    db.query<{ repo: string; number: unknown }>(
      `SELECT repo, number FROM pull_requests WHERE org_id = $1 AND shown_rules IS DISTINCT FROM $2 ORDER BY repo, number`,
      [db.orgId, rules],
    ),
  );
  let failed = 0;
  for (const pull of due) {
    try {
      await to((db) => hidePull(db, pull.repo, Number(pull.number), hide, rules));
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  return failed;
}

/** What a pull request's files were taken out by (`shown_rules`): the paths not shown, written as `entryOf` writes them. */
export const rulesOf = (hide: string[]): string =>
  createHash("sha256").update(JSON.stringify(hide.map(entryOf).sort())).digest("hex").slice(0, 16);

/** Whoever a session is filed under, storing their own in the organisation it is shown in. */
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
 * How the organisation it is shown in turns a session down by throwing: a
 * session by that name there is someone's own upload, or its person was
 * removed.
 */
const refused = (err: unknown): boolean => err instanceof Conflict || err instanceof RemovedPerson;

export interface ImportOptions {
  /** SESSIONLY_HASH_KEY, which the pull requests' committers are kept with. */
  key?: string;
  /** Where what goes wrong is said. */
  log?: (err: unknown) => void;
}

export interface Imported {
  /** Sessions copied. */
  copied: number;
  /** Sessions turned down: their person stopped the repository there, or was removed, or one by that name is someone's own there. */
  skipped: number;
  /** Copies from before with no session to copy again. */
  removed: number;
  /** Pull requests matched again. */
  matched: number;
  /** Pull requests that could not be gone through or matched again (said in `log`). */
  failed: number;
}

/**
 * Make the organisation the repository is shown in hold a copy of each of
 * its sessions, made by `shown`, and no other copy: every one from before is
 * removed, and the sessions are copied again, in one transaction. One the
 * organisation turns down is skipped. Only copies are replaced or removed
 * (`sessions.copied`): a session uploaded there is left as it is.
 *
 * First, what is not shown is taken out of the pull requests reported there
 * by other paths not shown (`hideInPulls`); last, the repository's pull
 * requests there are matched again. With none of the repository's sessions
 * where they are uploaded (a name written wrong), nothing is changed.
 */
export async function importDemo(from: Each, to: Each, demo: Pick<Demo, "repo" | "hide">, { key, log = () => {} }: ImportOptions = {}): Promise<Imported> {
  // The repository's name in any case: `GitHub.com/Acme/Shown` is the same one.
  const theirs = await from((db) =>
    db.query<{ owner_email: string; payload: unknown }>(
      `SELECT owner_email, payload FROM sessions WHERE org_id = $1 AND lower(repo) = lower($2) ORDER BY started_at, session_id`,
      [db.orgId, demo.repo],
    ),
  );
  if (theirs.length === 0) throw new Error(`there are no sessions of ${demo.repo} where they are uploaded: nothing was changed`);
  let failed = await hideInPulls(to, demo.hide, log);
  const { copied, skipped, removed } = await to(async (db) => {
    const rules: Rules = { hide: demo.hide, known: new Set(await reportedPaths(db, demo.repo)) };
    const before = await db.query<{ machine_id: string; source: string; session_id: string }>(
      `DELETE FROM sessions WHERE org_id = $1 AND copied RETURNING machine_id, source, session_id`,
      [db.orgId],
    );
    await forgetLines(db, before);
    const keyOf = (s: { machine_id?: string; source?: string; session_id?: string }) => `${s.machine_id}\n${s.source}\n${s.session_id}`;
    const again = new Set<string>();
    let copied = 0;
    let skipped = 0;
    for (const row of theirs) {
      const made = shown(jsonOf<Upload>(row.payload), rules);
      // One turned down undoes only itself.
      await db.query(`SAVEPOINT one`);
      try {
        const { stored } = await storeUpload(db, made, as(db.orgId, row.owner_email), { copy: true });
        await db.query(`RELEASE SAVEPOINT one`);
        if (stored) {
          copied += 1;
          again.add(keyOf(made.session ?? {}));
        } else skipped += 1;
      } catch (err) {
        if (!refused(err)) throw err;
        await db.query(`ROLLBACK TO SAVEPOINT one`);
        skipped += 1;
      }
    }
    return { copied, skipped, removed: before.filter((s) => !again.has(keyOf(s))).length };
  });
  // Every pull request of the repository there, a batch at a time, as the page's own button does it.
  let matched = 0;
  let since: string | undefined;
  for (;;) {
    const some = await rematchPulls(to, { sessions_repo: demo.repo }, since, key, log);
    matched += some.matched;
    failed += some.failed;
    since = some.started;
    if (some.remaining === 0 || some.matched + some.failed === 0) break;
  }
  return { copied, skipped, removed, matched, failed };
}

/** The settings of a demo. */
const SETTINGS = ["SESSIONLY_DEMO_FROM", "SESSIONLY_DEMO_REPO", "SESSIONLY_DEMO_ORG"] as const;
const SAME_ORG =
  "SESSIONLY_DEMO_FROM and SESSIONLY_DEMO_ORG name the same organisation: a repository is shown in another one. " +
  "Nothing is imported, and pull requests reported to it are refused, until it is put right.";

/** A place on someone's machine, not a path of the repository: `~/notes`, `C:\\notes`, `\\\\host\\notes`. */
const onAMachine = (entry: string): boolean => /^~(?:[/\\]|$)|^[A-Za-z]:[/\\]|^\\\\/.test(entry);

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
  const unusable = written.filter((entry) => entryOf(entry) === "" || onAMachine(entry));
  if (unusable.length) {
    return {
      problem:
        `SESSIONLY_DEMO_HIDE: ${unusable.map((entry) => `"${entry}"`).join(", ")} cannot be matched to paths of the repository ` +
        `(an entry is a file name, a path from its root, a folder or a pattern with *, does not climb out with .., ` +
        `and is not a place on a machine such as ~/notes or C:\\notes). ` +
        `Nothing is imported, and pull requests reported to SESSIONLY_DEMO_ORG are refused, until it is put right.`,
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
 * With SESSIONLY_DEMO_HIDE not to be trusted, or SESSIONLY_DEMO_FROM naming
 * the same organisation, reports there are refused.
 */
export function reportsShownIn(env: NodeJS.ProcessEnv): { org: string; hide: string[] } | { org: string; problem: string } | undefined {
  const org = env.SESSIONLY_DEMO_ORG?.trim();
  if (!org) return undefined;
  // Which of the two is wrong cannot be told: neither the work's reports are kept without paths, nor a demo's whole.
  if (org === env.SESSIONLY_DEMO_FROM?.trim()) return { org, problem: SAME_ORG };
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
  if (from === org) return { problem: SAME_ORG };
  const repo = repoOf(written!);
  if (!repo) {
    return { problem: "SESSIONLY_DEMO_REPO is not a repository as sessions are filed under it (github.com/owner/name): showing a repository in another organisation is off." };
  }
  const hide = hideFrom(env.SESSIONLY_DEMO_HIDE);
  if ("problem" in hide) return hide;
  return { from: from!, repo, org: org!, hide: hide.hide };
}
