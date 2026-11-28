// Outcomes on the merge clock: what later commits on a merged pull request's
// base branch did to its lines. The server holds hashes and cannot see the
// branch, so a scheduled run of the Action reads its history with git and
// sends, for each later commit, the lines it removed and added in the files
// asked for, as hashes, with what its message and pull request say of it
// (signal ids, never text). Here those are walked in order against the lines
// each pull request still has there: a commit that removes at least
// `MIN_TOUCH_LINES` of the agents' lines is a revert, a fix or rework, by
// the rules of the sessionly binary (crates/sessionly/src/outcomes.rs). The
// binary follows lines along each history they are in; here a pull request
// has one walk of its lines, in the order commits landed, so where two
// branches change the same lines and are merged, one may count against the
// other's. Of each commit's hashes only the pull request's own lines are
// kept, and where commits moved them (paths); the rest are dropped at once.
import type {
  OutcomeAge,
  OutcomeCommitReport,
  OutcomeKind,
  OutcomesDue,
  OutcomesDueBranch,
  PullOutcomeCommit,
  PullOutcomes,
  PullOutcomesAt,
  PullOutcomesBy,
  PullOutcomesGroup,
  PullOutcomesReport,
  PullOutcomesStored,
  PullOutcomesSummary,
  PullOutcomeWindow,
} from "@sessionly/schema";
import type { OrgDb } from "./db.ts";
import { BadReport, COMMIT_SHA, COMMON_LINE, HASH, holdPull, MAX_FILES, where, type PullFilters } from "./pulls.ts";

/** The ages counted after merging, in days: the binary's `CHECKPOINTS`. */
export const OUTCOME_AGES: readonly [OutcomeAge, number][] = [
  ["1d", 1],
  ["7d", 7],
  ["30d", 30],
];
const DAY = 86_400_000;
const LONGEST = 30 * DAY;

/** A commit must remove at least this many of the agents' lines, not common ones, to count. */
export const MIN_TOUCH_LINES = 2;
/** A commit whose subject begins with "revert" reverts the pull request when it removes this share of its lines still there. */
export const REVERT_SHARE = 0.5;
/** A fix is a likely fix when at least this share of the lines it removed were the agents'. */
export const LIKELY_FIX = 0.5;
/** A commit is the pull request's own when it puts back this many of its lines, or this share of what it adds to its files. */
const LANDING_LINES = 3;
const LANDING_SHARE = 0.5;

/** No more pull requests than this are asked for at once, those read or asked for longest ago first. */
const DUE_AT_ONCE = 50;
/** No more commits than this in one report, and no more pull requests. */
export const MOST_COMMITS = 500;
const MOST_PULLS = 100;
/**
 * No more line hashes than this in one commit (removed, added and moved),
 * and in one report, and no more files and moves in all: what one scan
 * costs to walk grows with them. The Action reads a commit whole only up to
 * 100,000 lines, and sends about 8 MB at a time.
 */
export const MOST_LINES_A_COMMIT = 200_000;
export const MOST_LINES = 500_000;
const MOST_FILES_IN_ALL = 100_000;
/** At most this many commits a branch was read up to for a pull request (`tips`). */
const MOST_TIPS = 20;
/** A pull request number as kept (a Postgres integer). */
const MOST_NUMBER = 2 ** 31 - 1;
/** The longest repository and branch names, in bytes (both are in a key), and paths, in characters. */
const MOST_NAME_BYTES = 1024;
const MOST_PATH = 4096;

/** The signals the Action may send, and those worked out here. */
const SENT_SIGNALS = new Set(["fix_message", "fix_conventional", "revert_subject", "fix_branch", "fix_pr_title", "revert_pr_title", "bug_issue"]);
const FIX_SIGNALS = new Set(["fix_message", "fix_conventional", "fix_branch", "fix_pr_title", "bug_issue"]);

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown): string | null => (value == null ? null : new Date(value as string).toISOString());
const time = (value: unknown): number => new Date(value as string).getTime();

type Lines = Record<string, string[]>;

/** The sessions whose lines in a pull request are kept: those it has lines of (see `KEPT` in after-merge.ts). */
const KEPT = `(jsonb_typeof(s.matched) = 'object' AND s.matched <> '{}'::jsonb)`;

/**
 * Merged pull requests of a repository whose later commits are to be read,
 * by the branch they were merged into: those with agent lines, merged since
 * the organisation's `outcomes_since` (or `since`, which may be earlier: the
 * history is still there), whose 30 days after merging are not all read
 * (720 hours, as `LONGEST`: 30 days of a calendar are 721 where the clocks
 * go back), and whose branch is not gone. Each says from when (`since`,
 * how far it was read, and `tips`, the commits it was read up to); a branch
 * reads from the earliest of its pull requests. No line hashes. Those read
 * or asked for longest ago come first, and those given are marked asked
 * for: one a run cannot read (its branch is not in the checkout, or its
 * reading fails) goes behind the rest, rather than first at every run.
 */
export async function outcomesDue(db: OrgDb, repo: string, since: string | null = null): Promise<OutcomesDue> {
  const rows = await db.query(
    `SELECT p.number, p.base_ref, p.merged_at, p.merge_commit_sha, coalesce(p.outcomes_scanned_until, p.merged_at) AS since,
            p.outcomes_held, p.outcomes_tips,
            (SELECT array_agg(DISTINCT k.path ORDER BY k.path)
             FROM pull_sessions s, jsonb_object_keys(CASE WHEN ${KEPT} THEN s.matched ELSE '{}'::jsonb END) AS k(path)
             WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number) AS paths
     FROM pull_requests p JOIN orgs o ON o.id = p.org_id
     WHERE p.org_id = $1 AND p.repo = $2 AND p.state = 'merged' AND p.merged_at IS NOT NULL AND p.base_ref IS NOT NULL
       AND p.merged_at >= least(o.outcomes_since, coalesce($3::timestamptz, o.outcomes_since))
       AND (p.outcomes_scanned_until IS NULL OR p.outcomes_scanned_until < p.merged_at + interval '720 hours')
       AND p.outcomes_gone_at IS NULL
       AND EXISTS (SELECT 1 FROM pull_sessions s WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number AND ${KEPT})
     ORDER BY greatest(coalesce(p.outcomes_scanned_until, p.merged_at), p.outcomes_asked_at), p.number
     LIMIT ${DUE_AT_ONCE}`,
    [db.orgId, repo, since],
  );
  if (rows.length > 0) {
    await db.query(`UPDATE pull_requests SET outcomes_asked_at = clock_timestamp() WHERE org_id = $1 AND repo = $2 AND number = ANY($3::integer[])`, [
      db.orgId, repo, rows.map((row) => num(row.number)),
    ]);
  }
  const branches = new Map<string, OutcomesDueBranch>();
  for (const row of rows) {
    const base = String(row.base_ref);
    const from = iso(row.since)!;
    const until = new Date(time(row.merged_at) + LONGEST).toISOString();
    // Where its lines are now: the files its agents wrote in, and those commits moved them to.
    const paths = new Set<string>((row.paths as string[]) ?? []);
    if (row.outcomes_held != null) {
      for (const [origin, current, , held] of heldOf(row.outcomes_held)) if (held > 0 && paths.has(origin)) paths.add(current);
    }
    const branch = branches.get(base) ?? { base_ref: base, since: from, until, pulls: [] };
    if (from < branch.since) branch.since = from;
    if (until > branch.until) branch.until = until;
    branch.pulls.push({
      number: num(row.number),
      merged_at: iso(row.merged_at)!,
      merge_commit_sha: (row.merge_commit_sha as string) ?? null,
      since: from,
      tips: tipsOf(row.outcomes_tips),
      paths: [...paths].sort(),
    });
    branches.set(base, branch);
  }
  return { branches: [...branches.values()] };
}

/** A scan as the Action sends it, checked; throws `BadReport` saying what is wrong with it. */
export function checkOutcomes(body: unknown): PullOutcomesReport {
  const r = body as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new BadReport(what);
  };
  if (!r || typeof r !== "object") fail("the report is not an object");
  const name = (value: unknown, what: string): string =>
    typeof value !== "string" || value === ""
      ? fail(`${what} is required`)
      : Buffer.byteLength(value) > MOST_NAME_BYTES
        ? fail(`${what} is longer than ${MOST_NAME_BYTES} bytes`)
        : value;
  const repo = name(r.repo, "repo").replace(/\/+$/, "");
  const base = name(r.base_ref, "base_ref");
  const when = (value: unknown, what: string): string =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fail(`${what} is not a time`);
  const number = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MOST_NUMBER;
  const numbers = (value: unknown, what: string): number[] =>
    Array.isArray(value) && value.length <= MOST_PULLS && value.every(number)
      ? [...new Set(value as number[])]
      : fail(`${what} must be a list of at most ${MOST_PULLS} pull request numbers`);
  // Counted as they are checked: a commit's, and the report's.
  let lines = 0;
  let inCommit = 0;
  let files = 0;
  const hashes = (value: unknown, what: string): string[] => {
    if (!Array.isArray(value) || !value.every((h) => typeof h === "string" && HASH.test(h))) fail(`${what} must be hashes of 16 hex digits`);
    inCommit += (value as string[]).length;
    if (inCommit > MOST_LINES_A_COMMIT) fail(`a commit can list at most ${MOST_LINES_A_COMMIT} line hashes`);
    if ((lines += (value as string[]).length) > MOST_LINES) fail(`a report can list at most ${MOST_LINES} line hashes`);
    return value as string[];
  };
  const path = (value: unknown, what: string): string =>
    typeof value === "string" && value !== "" && value.length <= MOST_PATH ? value : fail(`${what} needs a path of at most ${MOST_PATH} characters`);
  // Null, none and left out are one: not known. Left out is told apart only for `from`.
  const tips = (value: unknown): string[] | null =>
    value == null
      ? null
      : Array.isArray(value) && value.length <= MOST_TIPS && value.every((sha) => typeof sha === "string" && COMMIT_SHA.test(sha))
        ? value.length > 0 ? [...new Set(value as string[])] : null
        : fail(`tips must be at most ${MOST_TIPS} commit SHAs`);
  const read = (value: unknown): string[] =>
    Array.isArray(value) && value.length <= MOST_FILES_IN_ALL
      ? value.map((p) => path(p, "each of a pull's paths"))
      : fail(`a pull's paths must be a list of at most ${MOST_FILES_IN_ALL}`);
  const pulls = Array.isArray(r.pulls) && r.pulls.length <= MOST_PULLS ? r.pulls : fail(`pulls must be a list of at most ${MOST_PULLS}`);
  const commits = Array.isArray(r.commits) ? r.commits : fail("commits must be a list");
  if (commits.length > MOST_COMMITS) fail(`a report can list at most ${MOST_COMMITS} commits`);
  return {
    repo,
    base_ref: base,
    tip: typeof r.tip === "string" && COMMIT_SHA.test(r.tip) ? r.tip : null,
    scanned_until: when(r.scanned_until, "scanned_until"),
    pulls: (pulls as Record<string, unknown>[]).map((p) => {
      if (!p || !number(p.number)) fail("each pull needs a number");
      const sha = p.merge_commit_sha;
      if (sha != null && !(typeof sha === "string" && COMMIT_SHA.test(sha))) fail("merge_commit_sha must be a commit SHA");
      return {
        number: p.number as number,
        merge_commit_sha: (sha as string) ?? null,
        found: p.found === true,
        ...("from" in p ? { from: tips(p.from) } : {}),
        tips: tips(p.tips),
        ...(p.paths != null ? { paths: read(p.paths) } : {}),
      };
    }),
    gone: numbers(r.gone ?? [], "gone"),
    commits: (commits as Record<string, unknown>[]).map((c): OutcomeCommitReport => {
      if (!c || typeof c.sha !== "string" || !COMMIT_SHA.test(c.sha)) fail("each commit needs a SHA");
      const changed = Array.isArray(c.files) ? c.files : fail("each commit needs files");
      if (changed.length > MAX_FILES) fail(`a commit can list at most ${MAX_FILES} files`);
      const moves = c.moves == null ? [] : Array.isArray(c.moves) ? c.moves : fail("moves must be a list");
      if (moves.length > MAX_FILES) fail(`a commit can list at most ${MAX_FILES} moves`);
      if ((files += changed.length + moves.length) > MOST_FILES_IN_ALL) fail(`a report can list at most ${MOST_FILES_IN_ALL} files and moves in all`);
      const reverts = (c.reverts ?? {}) as Record<string, unknown>;
      const shas = reverts.shas ?? [];
      if (!Array.isArray(shas) || shas.length > 20 || !shas.every((s) => typeof s === "string" && /^[0-9a-f]{7,64}$/.test(s))) {
        fail("reverts.shas must be at most 20 SHAs of 7 to 64 hex digits");
      }
      const signals = Array.isArray(c.signals) ? c.signals : fail("signals must be a list");
      if (!signals.every((s) => typeof s === "string" && SENT_SIGNALS.has(s))) fail(`signals must be among ${[...SENT_SIGNALS].join(", ")}`);
      const total = c.removed_total;
      if (total != null && !(typeof total === "number" && Number.isFinite(total) && total >= 0)) fail("removed_total must be a number of lines");
      inCommit = 0;
      return {
        sha: c.sha as string,
        // Its link is made here, from the repository and the SHA: one sent is not shown.
        url: commitUrl(repo, c.sha as string),
        landed_at: when(c.landed_at, "landed_at"),
        pulls: numbers(c.pulls ?? [], "pulls"),
        after: numbers(c.after ?? [], "after"),
        signals: [...new Set(signals as string[])],
        reverts: { shas: [...new Set(shas as string[])], pulls: numbers(reverts.pulls ?? [], "reverts.pulls") },
        reapply: c.reapply === true,
        removed_total: (total as number) ?? null,
        files: (changed as Record<string, unknown>[]).map((f) => ({
          path: path(f?.path, "each file"),
          removed: hashes(f.removed ?? [], "removed"),
          added: hashes(f.added ?? [], "added"),
        })),
        moves: (moves as Record<string, unknown>[]).map((m) => ({
          from: path(m?.from, "each move"),
          to: path(m.to, "each move"),
          hashes: hashes(m.hashes ?? [], "a move's hashes"),
        })),
      };
    }),
  };
}

/** A commit's page, for a repository named as the Action names it (`github.com/owner/name`); null for one named otherwise. */
export function commitUrl(repo: string, sha: string): string | null {
  return /^[a-z0-9.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+$/i.test(repo) ? `https://${repo}/commit/${sha}` : null;
}

/**
 * A pull request's lines on its base branch as a walk of later commits
 * leaves them: for each line, the file it was written in (`origin`, where
 * its sessions' lines are matched), the file it is in now, its hash, how
 * many copies are there, and the most there can be (what was merged, and
 * what moved there since).
 */
type HeldLine = [origin: string, current: string, hash: string, held: number, wrote: number];

/** The commits a pull request was read up to, as kept: null for none known. */
function tipsOf(value: unknown): string[] | null {
  const tips = json<unknown>(value);
  return Array.isArray(tips) && tips.length > 0 ? tips.map(String) : null;
}

const sameTips = (a: string[] | null, b: string[] | null) => {
  const these = new Set(a ?? []);
  return these.size === new Set(b ?? []).size && (b ?? []).every((sha) => these.has(sha));
};

function heldOf(value: unknown): HeldLine[] {
  const lines = json<{ lines?: HeldLine[] }>(value)?.lines;
  return Array.isArray(lines) ? lines : [];
}

/** Its lines as merged: every line it adds (`last_files`), each in its own file. */
function mergedLines(files: { path: string; hashes: string[] }[]): HeldLine[] {
  const counts = new Map<string, HeldLine>();
  for (const file of files ?? []) {
    for (const hash of file.hashes ?? []) {
      const key = `${file.path}\n${hash}`;
      const line = counts.get(key) ?? [file.path, file.path, hash, 0, 0];
      line[3] += 1;
      line[4] += 1;
      counts.set(key, line);
    }
  }
  return [...counts.values()];
}

const countsOf = (hashes: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return counts;
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * A pull request's lines as a walk changes them, found by the file they are
 * in now and their hash, or by the file alone. `agent` is how many of them
 * are the agents', as they change: a line's share of copies its sessions
 * have (`share`, by the file it was written in and its hash).
 */
class Holding {
  readonly lines: HeldLine[] = [];
  agent = 0;
  private readonly byLine = new Map<string, HeldLine[]>();
  private readonly byFile = new Map<string, HeldLine[]>();
  private readonly share: Map<string, number>;

  constructor(lines: HeldLine[], share: Map<string, number>) {
    this.share = share;
    for (const line of lines) this.add(line);
  }

  private shareOf(line: HeldLine): number {
    return this.share.get(`${line[0]}\n${line[2]}`) ?? 0;
  }

  add(line: HeldLine): void {
    this.lines.push(line);
    push(this.byLine, `${line[1]}\n${line[2]}`, line);
    push(this.byFile, line[1], line);
    this.agent += line[3] * this.shareOf(line);
  }

  /** A line now has `held` copies there. */
  set(line: HeldLine, held: number): void {
    this.agent += (held - line[3]) * this.shareOf(line);
    line[3] = held;
  }

  holds(path: string): boolean {
    return this.byFile.has(path);
  }

  find(origin: string, current: string, hash: string): HeldLine | undefined {
    return this.byLine.get(`${current}\n${hash}`)?.find((line) => line[0] === origin);
  }

  /**
   * Each line in `path` that `counts` has, in the order they are held, with
   * how many of it are left once those before it took theirs; `take` says
   * how many it took. Whichever is fewer is gone through, the lines held
   * there or those counted, so a commit costs no more than either.
   */
  each(path: string, counts: Map<string, number>, take: (line: HeldLine, left: number) => number): void {
    const there = this.byFile.get(path);
    if (!there || counts.size === 0) return;
    const taken = new Map<string, number>();
    const offer = (line: HeldLine, n: number) => {
      const before = taken.get(line[2]) ?? 0;
      if (before < n) taken.set(line[2], before + take(line, n - before));
    };
    if (there.length < counts.size) {
      for (const line of there) {
        const n = counts.get(line[2]);
        if (n) offer(line, n);
      }
    } else {
      for (const [hash, n] of counts) for (const line of this.byLine.get(`${path}\n${hash}`) ?? []) offer(line, n);
    }
  }
}

/** A commit as it is walked: its hashes counted once, for all the pull requests of the report. */
interface Counted {
  files: { path: string; removed: Map<string, number>; added: Map<string, number>; adding: number }[];
  moves: { from: string; to: string; hashes: Map<string, number> }[];
}

const counted = (commit: OutcomeCommitReport): Counted => ({
  files: commit.files.map((f) => ({ path: f.path, removed: countsOf(f.removed), added: countsOf(f.added), adding: f.added.length })),
  moves: (commit.moves ?? []).filter((m) => m.from !== m.to).map((m) => ({ from: m.from, to: m.to, hashes: countsOf(m.hashes) })),
});

/** What one commit did to a pull request's lines, if it is not its own. */
interface Touch {
  /** The pull request's lines it removed, by the file they were written in. */
  removed: Lines;
  lines: number;
  /** Of those, the agents' (shared copies split); and the agents' lines there just before. */
  agent: number;
  before: number;
}

/**
 * Walk one commit over a pull request's lines (`held`, changed in place),
 * as the binary walks one over a session's: lines it moved go with it to
 * their new file; lines it removes go; lines it adds that the pull request
 * had and lost come back, no more than it had. A commit that puts back
 * enough of them is its own (a reland), not a touch: only what it adds
 * beyond what is still there counts for that. Null for its own.
 */
function walk(held: Holding, commit: Counted, own: boolean): Touch | null {
  for (const move of commit.moves) {
    held.each(move.from, move.hashes, (line, left) => {
      const taken = Math.min(left, line[3]);
      if (taken <= 0) return 0;
      held.set(line, line[3] - taken);
      line[4] -= taken;
      const there = held.find(line[0], move.to, line[2]);
      if (there) {
        held.set(there, there[3] + taken);
        there[4] += taken;
      } else held.add([line[0], move.to, line[2], taken, taken]);
      return taken;
    });
  }
  const before = held.agent;
  // What it adds that the pull request lost: before it removes anything.
  let mine = 0;
  let added = 0;
  const putBack: [HeldLine, number][] = [];
  for (const file of commit.files) {
    if (!held.holds(file.path)) continue;
    added += file.adding;
    held.each(file.path, file.added, (line, left) => {
      const back = Math.min(left, line[4] - line[3]);
      if (back <= 0) return 0;
      mine += back;
      putBack.push([line, back]);
      return back;
    });
  }
  // By file in a map: a file may be called `constructor`, which every object has already.
  const removed = new Map<string, string[]>();
  let lines = 0;
  for (const file of commit.files) {
    held.each(file.path, file.removed, (line, left) => {
      const taken = Math.min(left, line[3]);
      if (taken <= 0) return 0;
      held.set(line, line[3] - taken);
      lines += taken;
      const list = removed.get(line[0]) ?? [];
      for (let i = 0; i < taken; i += 1) list.push(line[2]);
      removed.set(line[0], list);
      return taken;
    });
  }
  const agent = before - held.agent;
  for (const [line, back] of putBack) held.set(line, Math.min(line[4], line[3] + back));
  const reland = mine >= LANDING_LINES || (mine >= MIN_TOUCH_LINES && added > 0 && mine / added >= LANDING_SHARE);
  return own || reland ? null : { removed: Object.fromEntries(removed), lines, agent, before };
}

/**
 * What a touching commit is to the pull request: a revert when it names
 * the commit the pull request was merged as (`revert_sha`) or its pull
 * request says it reverts this one (`revert_pull`), or when it says it is a
 * revert and takes at least `REVERT_SHARE` of the agents' lines still there
 * (`revert_bulk`); a fix with a fix signal; rework otherwise. A commit that
 * reverts a revert (`reapply`) reverts nothing, but by its pull request.
 */
export function classify(
  commit: Pick<OutcomeCommitReport, "signals" | "reverts" | "reapply">,
  pull: { number: number; merge_commit_sha: string | null },
  touch: Pick<Touch, "agent" | "before">,
): { kind: OutcomeKind; signals: string[] } {
  const signals: string[] = [];
  const sha = pull.merge_commit_sha;
  if (!commit.reapply && sha && commit.reverts.shas.some((named) => sha.startsWith(named))) signals.push("revert_sha");
  // What its pull request says (GitHub's Revert button) is so whatever a chain of reverts makes of it.
  if (commit.reverts.pulls.includes(pull.number)) signals.push("revert_pull");
  const says = !commit.reapply && (commit.signals.includes("revert_subject") || commit.signals.includes("revert_pr_title"));
  // (Rounded: the agents' lines are sums of shares.)
  if (says && touch.before > 0 && Math.round((touch.agent / touch.before) * 1e9) / 1e9 >= REVERT_SHARE) signals.push("revert_bulk");
  const reverted = signals.length > 0;
  signals.push(...commit.signals.filter((s) => FIX_SIGNALS.has(s)));
  const kind: OutcomeKind = reverted ? "revert" : signals.some((s) => FIX_SIGNALS.has(s)) ? "fix" : "rework";
  return { kind, signals };
}

/**
 * How much of each of a pull request's lines, by the file it was written in
 * and its hash, is the agents': the copies its sessions have, of the most of
 * the pull request's own and theirs (as `split` shares them out).
 */
function agentShares(matched: (Lines | null)[], files: { path: string; hashes: string[] }[] | null): Map<string, number> {
  const agents = new Map<string, number>();
  for (const lines of matched) {
    for (const [path, hashes] of Object.entries(lines ?? {})) {
      if (!Array.isArray(hashes)) continue;
      for (const hash of hashes) agents.set(`${path}\n${hash}`, (agents.get(`${path}\n${hash}`) ?? 0) + 1);
    }
  }
  const all = new Map<string, number>();
  for (const file of files ?? []) for (const hash of file.hashes ?? []) all.set(`${file.path}\n${hash}`, (all.get(`${file.path}\n${hash}`) ?? 0) + 1);
  return new Map([...agents].map(([key, k]) => [key, k / Math.max(k, all.get(key) ?? 0)]));
}

/**
 * Keep what one scan of a base branch says of each pull request it was read
 * for: each in a transaction of its own (`each`), so no report holds the
 * locks of every pull request of a branch at once. For a pull request, the
 * commits that landed after it was last read and by `scanned_until` (no
 * later than now), and in its 30 days, are walked in the order sent; one
 * that comes before its merge commit in the history, when that was found,
 * did not see its lines (and one after it may have landed the moment it was
 * merged). One matched since with lines in a file the run did not read
 * (`paths`) is left as it is. A commit kept once is not changed, but for a
 * later revert of it (`relands`).
 */
export async function storeOutcomes(
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  report: PullOutcomesReport,
  now = Date.now(),
): Promise<PullOutcomesStored> {
  const stored: PullOutcomesStored["stored"] = [];
  const read = Math.min(time(report.scanned_until), now);
  // Counted once, for every pull request walked.
  const commits = report.commits.map((commit) => ({ commit, landed: time(commit.landed_at), lines: counted(commit) }));
  for (const asked of report.pulls) {
    const kept = await each(async (db) => {
      await holdPull(db, report.repo, asked.number);
      const [pull] = await db.query(
        `SELECT state, base_ref, merged_at, merge_commit_sha, outcomes_scanned_until, outcomes_held, outcomes_tips, last_files
         FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
        [db.orgId, report.repo, asked.number],
      );
      if (!pull || pull.state !== "merged" || pull.merged_at == null || pull.base_ref !== report.base_ref) return [];
      // Read from other tips than it has now: another run moved it meanwhile, and this one says nothing of it.
      if (asked.from !== undefined && !sameTips(asked.from, tipsOf(pull.outcomes_tips))) return [];
      const matched = await db.query(
        `SELECT s.matched FROM pull_sessions s WHERE s.org_id = $1 AND s.repo = $2 AND s.number = $3 AND ${KEPT}`,
        [db.orgId, report.repo, asked.number],
      );
      // Matched meanwhile with lines in a file the run did not read: it says nothing of that file, and leaves it as it is.
      const paths = asked.paths && new Set(asked.paths);
      if (paths && matched.some((row) => Object.keys(json<Lines | null>(row.matched) ?? {}).some((path) => !paths.has(path)))) return [];
      const merged = time(pull.merged_at);
      const since = pull.outcomes_scanned_until == null ? merged : time(pull.outcomes_scanned_until);
      const until = Math.min(read, merged + LONGEST);
      if (until <= since) return [];
      // Read the first time, a commit of the moment it was merged is later when the history says so (`after`).
      const from = pull.outcomes_scanned_until == null && asked.found ? merged - 1 : since;
      const mergeSha = (pull.merge_commit_sha as string) ?? asked.merge_commit_sha ?? null;
      const files = json<{ path: string; hashes: string[] }[] | null>(pull.last_files);
      const shares = agentShares(matched.map((row) => json<Lines | null>(row.matched)), files);
      const held = new Holding(pull.outcomes_held == null ? mergedLines(files ?? []) : heldOf(pull.outcomes_held), shares);
      const out: PullOutcomesStored["stored"] = [];
      const reverts = new Set(
        (await db.query(`SELECT sha FROM pull_outcome_commits WHERE org_id = $1 AND repo = $2 AND number = $3 AND kind = 'revert' AND relands IS NULL`, [
          db.orgId, report.repo, asked.number,
        ])).map((row) => String(row.sha)),
      );
      for (const { commit, landed, lines } of commits) {
        if (landed <= from || landed > until || landed < merged) continue;
        // Not after the commit it was merged as: its lines were not there to change.
        if (asked.found && !(commit.after ?? []).includes(asked.number)) continue;
        const own = commit.pulls.includes(asked.number) || commit.sha === mergeSha;
        const touch = walk(held, lines, own);
        if (touch && touch.lines >= MIN_TOUCH_LINES) {
          const { kind, signals } = classify(commit, { number: asked.number, merge_commit_sha: mergeSha }, touch);
          const [row] = await db.query(
            `INSERT INTO pull_outcome_commits (org_id, repo, number, sha, kind, signals, landed_at, url, by_pull, removed, removed_total)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11)
             ON CONFLICT (org_id, repo, number, sha) DO NOTHING
             RETURNING sha, kind`,
            [
              db.orgId, report.repo, asked.number, commit.sha, kind, JSON.stringify(signals), commit.landed_at,
              commit.url ?? null, commit.pulls.find((n) => n !== asked.number) ?? null, JSON.stringify(touch.removed), commit.removed_total ?? null,
            ],
          );
          if (row) out.push({ number: asked.number, sha: String(row.sha), kind: row.kind as OutcomeKind });
          if (kind === "revert") reverts.add(commit.sha);
        }
        // A revert of a revert kept here: the lines came back. (Asked only of one that names a revert kept.)
        if (commit.reverts.shas.some((named) => [...reverts].some((sha) => sha.startsWith(named)))) {
          await db.query(
            `UPDATE pull_outcome_commits SET relands = $4, relanded_at = $5
             WHERE org_id = $1 AND repo = $2 AND number = $3 AND kind = 'revert' AND relands IS NULL AND sha <> $4 AND landed_at <= $5
               AND EXISTS (SELECT 1 FROM unnest($6::text[]) AS n(sha) WHERE pull_outcome_commits.sha LIKE n.sha || '%')`,
            [db.orgId, report.repo, asked.number, commit.sha, commit.landed_at, commit.reverts.shas],
          );
        }
      }
      await db.query(
        `UPDATE pull_requests SET outcomes_scanned_until = $4, outcomes_held = $5::jsonb, outcomes_tips = $7::jsonb,
           merge_commit_sha = coalesce(merge_commit_sha, $6)
         WHERE org_id = $1 AND repo = $2 AND number = $3`,
        [
          db.orgId, report.repo, asked.number, new Date(until).toISOString(), JSON.stringify({ lines: held.lines.filter((l) => l[4] > 0) }),
          asked.merge_commit_sha, asked.tips ? JSON.stringify(asked.tips) : null,
        ],
      );
      return out;
    });
    stored.push(...kept);
  }
  // Merged into a branch that is gone: not asked for again. How far each was read stays: not reached, rather than reached with nothing.
  if ((report.gone ?? []).length > 0) {
    await each((db) =>
      db.query(
        `UPDATE pull_requests SET outcomes_gone_at = coalesce(outcomes_gone_at, clock_timestamp())
         WHERE org_id = $1 AND repo = $2 AND base_ref = $3 AND state = 'merged' AND number = ANY($4::integer[])`,
        [db.orgId, report.repo, report.base_ref, report.gone],
      ),
    );
  }
  // The tip a run read to stays the branch's until a run reads further: one that read less and ended later says nothing of it.
  const scanned = new Date(read).toISOString();
  await each((db) =>
    db.query(
      `INSERT INTO repo_outcome_scans (org_id, repo, branch, scanned_until, tip) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, repo, branch) DO UPDATE SET
         scanned_until = greatest(repo_outcome_scans.scanned_until, EXCLUDED.scanned_until),
         tip = CASE WHEN EXCLUDED.scanned_until >= repo_outcome_scans.scanned_until THEN coalesce(EXCLUDED.tip, repo_outcome_scans.tip)
                    ELSE repo_outcome_scans.tip END,
         updated_at = clock_timestamp()`,
      [db.orgId, report.repo, report.base_ref, scanned, report.tip ?? null],
    ),
  );
  return { stored, scanned_until: scanned };
}

/** A session with lines in a pull request, and which group it is in for each `by`. */
interface Holder {
  machine_id: string;
  source: string;
  session_id: string;
  model: string;
  user: string;
  /** How many lines it has there. */
  lines: number;
  /** Which, by file: only of a pull request with later commits kept, the only ones split. */
  matched: Lines | null;
}

/** A kept commit, split over the sessions as they are matched now. */
interface Split extends PullOutcomeCommit {
  /** Agent lines by session key. */
  shares: Map<string, number>;
}

const holderKey = (s: { machine_id: string; source: string; session_id: string }) => `${s.machine_id}\n${s.source}\n${s.session_id}`;

/** What a pull request's commits are split by: its sessions' copies of each line, and its own, by file and hash; and its common lines. */
interface Copies {
  /** Which sessions (by their place in `holders`) have copies, and how many. */
  held: Map<string, [number, number][]>;
  merged: Map<string, number>;
  common: Set<string>;
}

function copiesOf(holders: Holder[], files: { path: string; hashes: string[] }[] | null, common: Lines | null): Copies {
  const held = new Map<string, [number, number][]>();
  holders.forEach((h, i) => {
    for (const [path, hashes] of Object.entries(h.matched ?? {})) {
      if (!Array.isArray(hashes)) continue;
      for (const [hash, k] of countsOf(hashes)) push(held, `${path}\n${hash}`, [i, k] as [number, number]);
    }
  });
  const merged = new Map<string, number>();
  for (const file of files ?? []) for (const hash of file.hashes ?? []) merged.set(`${file.path}\n${hash}`, (merged.get(`${file.path}\n${hash}`) ?? 0) + 1);
  const shared = new Set<string>();
  for (const [path, hashes] of Object.entries(common ?? {})) if (Array.isArray(hashes)) for (const hash of hashes) shared.add(`${path}\n${hash}`);
  return { held, merged, common: shared };
}

/**
 * Split a commit's removed lines over the sessions that hold copies of them
 * in the pull request: a session with `k` of the `T` copies the pull request
 * has of a line (its agents' and not) gets `m * k / T` of the `m` removed.
 * Lines then add up across sessions, and a removal of a line a person also
 * wrote is not all put on the agent. It counts when it removed at least
 * `MIN_TOUCH_LINES` agent copies of lines that are not common ones: lines
 * `COMMON_LINE` sessions or more wrote in that file, as the pull request
 * was last matched (`common_lines`).
 */
function split(row: Record<string, unknown>, holders: Holder[], copies: Copies): Split {
  const removed = json<Lines>(row.removed) ?? {};
  const shares = new Map<string, number>();
  let lines = 0;
  let agent = 0;
  let notCommon = 0;
  // Agent copies it removed, common or not: the likely-fix share, as the binary's `strength`.
  let copied = 0;
  for (const [path, hashes] of Object.entries(removed)) {
    if (!Array.isArray(hashes)) continue;
    for (const [hash, m] of countsOf(hashes)) {
      lines += m;
      const key = `${path}\n${hash}`;
      const having = copies.held.get(key) ?? [];
      const sum = having.reduce((n, [, k]) => n + k, 0);
      if (sum === 0) continue;
      const all = Math.max(sum, copies.merged.get(key) ?? 0);
      for (const [i, k] of having) {
        const share = Math.min(k, (m * k) / all);
        const who = holderKey(holders[i]!);
        shares.set(who, (shares.get(who) ?? 0) + share);
        agent += share;
      }
      copied += Math.min(m, sum);
      if (!copies.common.has(key)) notCommon += Math.min(m, sum);
    }
  }
  const total = row.removed_total == null ? null : num(row.removed_total);
  const kind = row.kind as OutcomeKind;
  const counted = notCommon >= MIN_TOUCH_LINES;
  return {
    sha: String(row.sha),
    url: (row.url as string) ?? null,
    kind,
    signals: json<string[]>(row.signals) ?? [],
    landed_at: iso(row.landed_at)!,
    by_pull: row.by_pull == null ? null : num(row.by_pull),
    lines,
    agent_lines: agent,
    counted,
    likely: kind === "fix" && counted && total != null && total > 0 && Math.min(1, copied / total) >= LIKELY_FIX,
    relanded_at: iso(row.relanded_at),
    sessions: holders
      .filter((h) => (shares.get(holderKey(h)) ?? 0) > 0)
      .map((h) => ({ machine_id: h.machine_id, source: h.source, session_id: h.session_id, lines: shares.get(holderKey(h))! })),
    shares,
  };
}

const UNKNOWN = "not known";

/**
 * Whether a merged pull request's later commits can be read: it has a base
 * branch, and it was merged since the organisation's `outcomes_since` (or
 * was read anyway, asked for with `since`), and its branch is not gone
 * (`gone`). Those that cannot are in no figure, not even among those to reach.
 */
const READABLE = `(p.base_ref IS NOT NULL AND p.outcomes_gone_at IS NULL
  AND (p.outcomes_scanned_until IS NOT NULL OR p.merged_at >= (SELECT o.outcomes_since FROM orgs o WHERE o.id = p.org_id)))`;

/**
 * The pull requests chosen, merged, with their sessions' lines and their
 * kept commits, split. Which line each session has, and the pull request's
 * own, are read only of those with commits kept: the others need only how
 * many. (Each session a row: one value of all of them is slow to build.)
 */
async function readOutcomes(db: OrgDb, chosen: { sql: string; params: unknown[] }) {
  const changed = `EXISTS (SELECT 1 FROM pull_outcome_commits c WHERE c.org_id = r.org_id AND c.repo = r.repo AND c.number = r.number)`;
  const pulls = await db.query(
    `SELECT p.repo, p.number, p.merged_at, p.outcomes_scanned_until, ${READABLE} AS readable,
            CASE WHEN p.changed THEN p.last_files END AS last_files, CASE WHEN p.changed THEN p.common_lines END AS common_lines
     FROM (SELECT r.*, ${changed} AS changed FROM pull_requests r ${chosen.sql}) p
     WHERE p.state = 'merged' AND p.merged_at IS NOT NULL
     ORDER BY p.merged_at, p.repo, p.number`,
    chosen.params,
  );
  const holders = await db.query(
    `SELECT s.repo, s.number, s.machine_id, s.source, s.session_id,
            coalesce(x.primary_model, '${UNKNOWN}') AS model, coalesce(x.owner_email, '${UNKNOWN}') AS owner,
            (SELECT coalesce(sum(CASE WHEN jsonb_typeof(v) = 'array' THEN jsonb_array_length(v) ELSE 0 END), 0)
             FROM jsonb_each(s.matched) AS e(k, v)) AS lines,
            CASE WHEN p.changed THEN s.matched END AS matched
     FROM pull_sessions s
       JOIN (SELECT r.repo, r.number, ${changed} AS changed FROM pull_requests r ${chosen.sql}) p USING (repo, number)
       LEFT JOIN sessions x ON x.org_id = s.org_id AND x.machine_id = s.machine_id AND x.source = s.source AND x.session_id = s.session_id
     WHERE s.org_id = $1 AND ${KEPT}
     ORDER BY s.machine_id, s.source, s.session_id`,
    chosen.params,
  );
  const commits = await db.query(
    `SELECT c.repo, c.number, c.sha, c.kind, c.signals, c.landed_at, c.url, c.by_pull, c.removed, c.removed_total, c.relanded_at
     FROM pull_outcome_commits c JOIN (SELECT repo, number FROM pull_requests ${chosen.sql}) p USING (repo, number)
     WHERE c.org_id = $1
     ORDER BY c.landed_at, c.sha`,
    chosen.params,
  );
  const holding = new Map<string, Holder[]>();
  for (const h of holders) {
    push(holding, `${h.repo}\n${h.number}`, {
      machine_id: String(h.machine_id),
      source: String(h.source),
      session_id: String(h.session_id),
      model: String(h.model),
      user: String(h.owner),
      lines: num(h.lines),
      matched: h.matched == null ? null : json<Lines>(h.matched),
    });
  }
  const byPull = new Map<string, Record<string, unknown>[]>();
  for (const row of commits) push(byPull, `${row.repo}\n${row.number}`, row);
  return pulls.map((p) => {
    const its = holding.get(`${p.repo}\n${p.number}`) ?? [];
    const kept = byPull.get(`${p.repo}\n${p.number}`) ?? [];
    const copies = kept.length > 0 ? copiesOf(its, json(p.last_files), json(p.common_lines)) : null;
    return {
      repo: String(p.repo),
      number: num(p.number),
      merged_at: time(p.merged_at),
      scanned_until: p.outcomes_scanned_until == null ? null : time(p.outcomes_scanned_until),
      readable: p.readable === true,
      holders: its,
      commits: kept.map((row) => split(row, its, copies!)),
    };
  });
}

type Read = Awaited<ReturnType<typeof readOutcomes>>[number];

/** Whether an age has passed for a pull request and its branch was read up to it. */
const reachedAt = (pull: Read, days: number, now: number) =>
  now >= pull.merged_at + days * DAY && pull.scanned_until != null && pull.scanned_until >= pull.merged_at + days * DAY;

/** The commits that count at an age: landed within it. */
const within = (pull: Read, days: number) => pull.commits.filter((c) => c.counted && time(c.landed_at) <= pull.merged_at + days * DAY);

/** Reverted by then, and not relanded by then. */
const revertedBy = (commits: Split[], end: number) =>
  commits.some((c) => c.kind === "revert" && (c.relanded_at == null || time(c.relanded_at) > end));

function windowOf(pull: Read, days: number, now: number): PullOutcomeWindow {
  const inside = within(pull, days);
  const sum = (kind: OutcomeKind) => inside.filter((c) => c.kind === kind).reduce((n, c) => n + c.agent_lines, 0);
  return {
    reached: reachedAt(pull, days, now),
    reverted: revertedBy(inside, pull.merged_at + days * DAY),
    revert_commits: inside.filter((c) => c.kind === "revert").length,
    agent_lines_reverted: sum("revert"),
    fix_commits: inside.filter((c) => c.kind === "fix").length,
    likely_fix_commits: inside.filter((c) => c.likely).length,
    agent_lines_fixed: sum("fix"),
    rework_commits: inside.filter((c) => c.kind === "rework").length,
    agent_lines_reworked: sum("rework"),
  };
}

/** What later commits did to one merged pull request's lines; null for one not merged. */
export async function outcomesOf(db: OrgDb, repo: string, number: number, now = Date.now()): Promise<PullOutcomes | null> {
  const [pull] = await readOutcomes(db, {
    sql: `WHERE org_id = $1 AND repo = $2 AND number = $3`,
    params: [db.orgId, repo, number],
  });
  if (!pull) return null;
  return {
    scanned_until: pull.scanned_until == null ? null : new Date(pull.scanned_until).toISOString(),
    windows: Object.fromEntries(OUTCOME_AGES.map(([age, days]) => [age, windowOf(pull, days, now)])) as Record<OutcomeAge, PullOutcomeWindow>,
    commits: pull.commits.map(({ shares: _, ...commit }) => commit),
  };
}

const blank = (): PullOutcomesAt => ({
  pulls_reached: 0,
  pulls_total: 0,
  agent_lines: 0,
  pulls_reverted: 0,
  revert_commits: 0,
  agent_lines_reverted: 0,
  fix_commits: 0,
  likely_fix_commits: 0,
  agent_lines_fixed: 0,
  sessions_fixed: 0,
  rework_commits: 0,
  agent_lines_reworked: 0,
});

/** The filters of `/prs/outcomes/summary`: those of the list, and which sessions' lines. */
export interface OutcomeFilters extends PullFilters {
  tool?: string;
  model?: string;
  user?: string;
}

/** At one age, what a sum has counted already: a commit (by repository and SHA) or a session counts once in it. */
interface Seen {
  commits: Record<OutcomeKind, Set<string>>;
  likely: Set<string>;
  fixed: Set<string>;
}

interface Sums {
  ages: Record<OutcomeAge, PullOutcomesAt>;
  seen: Record<OutcomeAge, Seen>;
  lines: number;
}

const seen = (): Seen => ({ commits: { revert: new Set(), fix: new Set(), rework: new Set() }, likely: new Set(), fixed: new Set() });
const sums = (): Sums => ({ ages: { "1d": blank(), "7d": blank(), "30d": blank() }, seen: { "1d": seen(), "7d": seen(), "30d": seen() }, lines: 0 });

/**
 * Merged pull requests' outcomes summed by tool, model, person, repository
 * or day merged, at each age, of the pull requests that reached it, out of
 * those that can be read (`READABLE`). A session is in one group; a pull
 * request is in each group one of its sessions is in. Lines are split by
 * session, so they add up across groups; a commit, a pull request or a
 * session counts once in each group whose lines it changed, and once in the
 * total, however many pull requests a commit changed. The model is the
 * session's main one.
 */
export async function summarizeOutcomes(db: OrgDb, by: PullOutcomesBy, filters: OutcomeFilters, now = Date.now()): Promise<PullOutcomesSummary> {
  const pulls = await readOutcomes(db, where(db.orgId, { repo: filters.repo, state: "merged", since: filters.since }));
  const keyOf = (pull: Read, h: Holder): string =>
    by === "tool" ? h.source : by === "model" ? h.model : by === "user" ? h.user : by === "repo" ? pull.repo : new Date(pull.merged_at).toISOString().slice(0, 10);
  const wanted = (h: Holder) =>
    (!filters.tool || h.source === filters.tool) && (!filters.model || h.model === filters.model) && (!filters.user || h.user === filters.user);
  const groups = new Map<string, Sums>();
  const total = sums();
  const add = (into: Sums, pull: Read, holders: Holder[]) => {
    const keys = new Set(holders.map(holderKey));
    const lines = holders.reduce((n, h) => n + h.lines, 0);
    into.lines += lines;
    for (const [age, days] of OUTCOME_AGES) {
      const at = into.ages[age];
      const counted = into.seen[age];
      at.pulls_total += 1;
      if (!reachedAt(pull, days, now)) continue;
      at.pulls_reached += 1;
      at.agent_lines += lines;
      // The commits that changed these sessions' lines, and how many of them.
      const mine = within(pull, days)
        .map((c) => ({ c, lines: [...c.shares].filter(([key]) => keys.has(key)).reduce((n, [, l]) => n + l, 0) }))
        .filter(({ lines: l }) => l > 0);
      for (const { c, lines: l } of mine) {
        const id = `${pull.repo}\n${c.sha}`;
        counted.commits[c.kind].add(id);
        if (c.kind === "revert") at.agent_lines_reverted += l;
        else if (c.kind === "fix") {
          at.agent_lines_fixed += l;
          if (c.likely) counted.likely.add(id);
          for (const [key, share] of c.shares) if (keys.has(key) && share > 0) counted.fixed.add(key);
        } else at.agent_lines_reworked += l;
      }
      if (revertedBy(mine.map(({ c }) => c), pull.merged_at + days * DAY)) at.pulls_reverted += 1;
    }
  };
  for (const pull of pulls) {
    if (!pull.readable) continue;
    const holders = pull.holders.filter(wanted);
    if (holders.length === 0) continue;
    const byKey = new Map<string, Holder[]>();
    for (const h of holders) push(byKey, keyOf(pull, h), h);
    for (const [key, some] of byKey) {
      const into = groups.get(key) ?? sums();
      add(into, pull, some);
      groups.set(key, into);
    }
    add(total, pull, holders);
  }
  const out = (into: Sums): Omit<PullOutcomesGroup, "key"> => {
    const at = (age: OutcomeAge): PullOutcomesAt => {
      const counted = into.seen[age];
      return {
        ...into.ages[age],
        revert_commits: counted.commits.revert.size,
        fix_commits: counted.commits.fix.size,
        likely_fix_commits: counted.likely.size,
        sessions_fixed: counted.fixed.size,
        rework_commits: counted.commits.rework.size,
      };
    };
    return { outcomes_1d: at("1d"), outcomes_7d: at("7d"), outcomes_30d: at("30d") };
  };
  const sorted = [...groups].sort(([a, x], [b, y]) => (by === "day" ? a.localeCompare(b) : y.lines - x.lines || a.localeCompare(b)));
  return { groups: sorted.map(([key, into]) => ({ key, ...out(into) })), total: out(total) };
}
