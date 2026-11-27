// Outcomes on the merge clock: what later commits on a merged pull request's
// base branch did to its lines. The server holds hashes and cannot see the
// branch, so a scheduled run of the Action reads its history with git and
// sends, for each later commit, the lines it removed and added in the files
// asked for, as hashes, with what its message and pull request say of it
// (signal ids, never text). Here those are walked in order against the lines
// each pull request still has there: a commit that removes at least
// `MIN_TOUCH_LINES` of the agents' lines is a revert, a fix or rework, by
// the same rules as the sessionly binary's (crates/sessionly/src/outcomes.rs).
// Of each commit's hashes only the pull request's own lines are kept; the
// rest are dropped at once.
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

/** No more pull requests than this are asked for at once, the longest unread first. */
const DUE_AT_ONCE = 50;
/** No more commits than this in one report, and no more pull requests. */
export const MOST_COMMITS = 500;
const MOST_PULLS = 100;

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
 * history is still there), whose 30 days after merging are not all read.
 * Each says from when (`since`, how far it was read); a branch reads from
 * the earliest of its pull requests. No line hashes.
 */
export async function outcomesDue(db: OrgDb, repo: string, since: string | null = null): Promise<OutcomesDue> {
  const rows = await db.query(
    `SELECT p.number, p.base_ref, p.merged_at, p.merge_commit_sha, coalesce(p.outcomes_scanned_until, p.merged_at) AS since,
            p.outcomes_held,
            (SELECT array_agg(DISTINCT k.path ORDER BY k.path)
             FROM pull_sessions s, jsonb_object_keys(CASE WHEN ${KEPT} THEN s.matched ELSE '{}'::jsonb END) AS k(path)
             WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number) AS paths
     FROM pull_requests p JOIN orgs o ON o.id = p.org_id
     WHERE p.org_id = $1 AND p.repo = $2 AND p.state = 'merged' AND p.merged_at IS NOT NULL AND p.base_ref IS NOT NULL
       AND p.merged_at >= least(o.outcomes_since, coalesce($3::timestamptz, o.outcomes_since))
       AND (p.outcomes_scanned_until IS NULL OR p.outcomes_scanned_until < p.merged_at + interval '30 days')
       AND EXISTS (SELECT 1 FROM pull_sessions s WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number AND ${KEPT})
     ORDER BY coalesce(p.outcomes_scanned_until, p.merged_at), p.number
     LIMIT ${DUE_AT_ONCE}`,
    [db.orgId, repo, since],
  );
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
  if (typeof r.repo !== "string" || r.repo === "") fail("repo is required");
  if (typeof r.base_ref !== "string" || r.base_ref === "") fail("base_ref is required");
  const when = (value: unknown, what: string): string =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fail(`${what} is not a time`);
  const numbers = (value: unknown, what: string): number[] =>
    Array.isArray(value) && value.length <= MOST_PULLS && value.every((n) => Number.isInteger(n) && n >= 1)
      ? [...new Set(value as number[])]
      : fail(`${what} must be a list of at most ${MOST_PULLS} pull request numbers`);
  const hashes = (value: unknown, what: string): string[] =>
    Array.isArray(value) && value.every((h) => typeof h === "string" && HASH.test(h)) ? (value as string[]) : fail(`${what} must be hashes of 16 hex digits`);
  const path = (value: unknown, what: string): string => (typeof value === "string" && value !== "" ? value : fail(`${what} needs a path`));
  const pulls = Array.isArray(r.pulls) && r.pulls.length <= MOST_PULLS ? r.pulls : fail(`pulls must be a list of at most ${MOST_PULLS}`);
  const commits = Array.isArray(r.commits) ? r.commits : fail("commits must be a list");
  if (commits.length > MOST_COMMITS) fail(`a report can list at most ${MOST_COMMITS} commits`);
  return {
    repo: (r.repo as string).replace(/\/+$/, ""),
    base_ref: r.base_ref as string,
    tip: typeof r.tip === "string" && COMMIT_SHA.test(r.tip) ? r.tip : null,
    scanned_until: when(r.scanned_until, "scanned_until"),
    pulls: (pulls as Record<string, unknown>[]).map((p) => {
      if (!p || !Number.isInteger(p.number) || (p.number as number) < 1) fail("each pull needs a number");
      const sha = p.merge_commit_sha;
      if (sha != null && !(typeof sha === "string" && COMMIT_SHA.test(sha))) fail("merge_commit_sha must be a commit SHA");
      return { number: p.number as number, merge_commit_sha: (sha as string) ?? null, found: p.found === true };
    }),
    commits: (commits as Record<string, unknown>[]).map((c): OutcomeCommitReport => {
      if (!c || typeof c.sha !== "string" || !COMMIT_SHA.test(c.sha)) fail("each commit needs a SHA");
      const files = Array.isArray(c.files) ? c.files : fail("each commit needs files");
      if (files.length > MAX_FILES) fail(`a commit can list at most ${MAX_FILES} files`);
      const moves = c.moves == null ? [] : Array.isArray(c.moves) ? c.moves : fail("moves must be a list");
      if (moves.length > MAX_FILES) fail(`a commit can list at most ${MAX_FILES} moves`);
      const reverts = (c.reverts ?? {}) as Record<string, unknown>;
      const shas = reverts.shas ?? [];
      if (!Array.isArray(shas) || shas.length > 20 || !shas.every((s) => typeof s === "string" && /^[0-9a-f]{7,64}$/.test(s))) {
        fail("reverts.shas must be at most 20 SHAs of 7 to 64 hex digits");
      }
      const signals = Array.isArray(c.signals) ? c.signals : fail("signals must be a list");
      if (!signals.every((s) => typeof s === "string" && SENT_SIGNALS.has(s))) fail(`signals must be among ${[...SENT_SIGNALS].join(", ")}`);
      const total = c.removed_total;
      if (total != null && !(typeof total === "number" && Number.isFinite(total) && total >= 0)) fail("removed_total must be a number of lines");
      const url = typeof c.url === "string" && /^https:\/\/[^\s]{1,500}$/.test(c.url) ? c.url : null;
      return {
        sha: c.sha as string,
        url,
        landed_at: when(c.landed_at, "landed_at"),
        pulls: numbers(c.pulls ?? [], "pulls"),
        after: numbers(c.after ?? [], "after"),
        signals: [...new Set(signals as string[])],
        reverts: { shas: [...new Set(shas as string[])], pulls: numbers(reverts.pulls ?? [], "reverts.pulls") },
        reapply: c.reapply === true,
        removed_total: (total as number) ?? null,
        files: (files as Record<string, unknown>[]).map((f) => ({
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

/**
 * A pull request's lines on its base branch as a walk of later commits
 * leaves them: for each line, the file it was written in (`origin`, where
 * its sessions' lines are matched), the file it is in now, its hash, how
 * many copies are there, and the most there can be (what was merged, and
 * what moved there since).
 */
type HeldLine = [origin: string, current: string, hash: string, held: number, wrote: number];

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

/** What one commit did to a pull request's lines, if it is not its own. */
interface Touch {
  /** The pull request's lines it removed, by the file they were written in. */
  removed: Lines;
  lines: number;
  /** Its lines there just before. */
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
function walk(held: HeldLine[], commit: OutcomeCommitReport, own: boolean): Touch | null {
  const at = (current: string, hash: string) => held.filter((line) => line[1] === current && line[2] === hash);
  for (const move of commit.moves ?? []) {
    for (const [hash, n] of countsOf(move.hashes)) {
      let left = n;
      for (const line of at(move.from, hash)) {
        const taken = Math.min(left, line[3]);
        if (taken <= 0) continue;
        left -= taken;
        line[3] -= taken;
        line[4] -= taken;
        const there = held.find((l) => l[0] === line[0] && l[1] === move.to && l[2] === hash);
        if (there) {
          there[3] += taken;
          there[4] += taken;
        } else held.push([line[0], move.to, hash, taken, taken]);
      }
    }
  }
  const before = held.reduce((sum, line) => sum + line[3], 0);
  // What it adds that the pull request lost: before it removes anything.
  let mine = 0;
  let added = 0;
  const putBack: [HeldLine, number][] = [];
  const paths = new Set(held.map((line) => line[1]));
  for (const file of commit.files) {
    if (!paths.has(file.path)) continue;
    for (const [hash, n] of countsOf(file.added)) {
      added += n;
      let left = n;
      for (const line of at(file.path, hash)) {
        const back = Math.min(left, line[4] - line[3]);
        if (back <= 0) continue;
        left -= back;
        mine += back;
        putBack.push([line, back]);
      }
    }
  }
  const removed: Lines = {};
  let lines = 0;
  for (const file of commit.files) {
    for (const [hash, n] of countsOf(file.removed)) {
      let left = n;
      for (const line of at(file.path, hash)) {
        const taken = Math.min(left, line[3]);
        if (taken <= 0) continue;
        left -= taken;
        line[3] -= taken;
        lines += taken;
        (removed[line[0]] ??= []).push(...Array<string>(taken).fill(hash));
      }
    }
  }
  for (const [line, back] of putBack) line[3] = Math.min(line[4], line[3] + back);
  const reland = mine >= LANDING_LINES || (mine >= MIN_TOUCH_LINES && added > 0 && mine / added >= LANDING_SHARE);
  return own || reland ? null : { removed, lines, before };
}

/**
 * What a touching commit is to the pull request: a revert when it names
 * the commit the pull request was merged as (`revert_sha`) or its pull
 * request says it reverts this one (`revert_pull`), or when it says it is a
 * revert and takes at least `REVERT_SHARE` of the lines still there
 * (`revert_bulk`); a fix with a fix signal; rework otherwise. A commit that
 * reverts a revert reverts nothing.
 */
export function classify(
  commit: Pick<OutcomeCommitReport, "signals" | "reverts" | "reapply">,
  pull: { number: number; merge_commit_sha: string | null },
  touch: Pick<Touch, "lines" | "before">,
): { kind: OutcomeKind; signals: string[] } {
  const signals: string[] = [];
  if (!commit.reapply) {
    const sha = pull.merge_commit_sha;
    if (sha && commit.reverts.shas.some((named) => sha.startsWith(named))) signals.push("revert_sha");
    if (commit.reverts.pulls.includes(pull.number)) signals.push("revert_pull");
    const says = commit.signals.includes("revert_subject") || commit.signals.includes("revert_pr_title");
    if (says && touch.before > 0 && touch.lines / touch.before >= REVERT_SHARE) signals.push("revert_bulk");
  }
  const reverted = signals.length > 0;
  signals.push(...commit.signals.filter((s) => FIX_SIGNALS.has(s)));
  const kind: OutcomeKind = reverted ? "revert" : signals.some((s) => FIX_SIGNALS.has(s)) ? "fix" : "rework";
  return { kind, signals };
}

/**
 * Keep what one scan of a base branch says of each pull request it was read
 * for: each in a transaction of its own (`each`), so no report holds the
 * locks of every pull request of a branch at once. For a pull request, the
 * commits that landed after it was last read and by `scanned_until`, and in
 * its 30 days, are walked in the order sent; one that comes before its merge
 * commit in the history, when that was found, did not see its lines. A
 * commit kept once is not changed, but for a later revert of it (`relands`).
 */
export async function storeOutcomes(
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  report: PullOutcomesReport,
): Promise<PullOutcomesStored> {
  const stored: PullOutcomesStored["stored"] = [];
  const read = time(report.scanned_until);
  for (const asked of report.pulls) {
    const kept = await each(async (db) => {
      await holdPull(db, report.repo, asked.number);
      const [pull] = await db.query(
        `SELECT state, base_ref, merged_at, merge_commit_sha, outcomes_scanned_until, outcomes_held, last_files
         FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
        [db.orgId, report.repo, asked.number],
      );
      if (!pull || pull.state !== "merged" || pull.merged_at == null || pull.base_ref !== report.base_ref) return [];
      const merged = time(pull.merged_at);
      const since = pull.outcomes_scanned_until == null ? merged : time(pull.outcomes_scanned_until);
      const until = Math.min(read, merged + LONGEST);
      if (until <= since) return [];
      const mergeSha = (pull.merge_commit_sha as string) ?? asked.merge_commit_sha ?? null;
      const held = pull.outcomes_held == null ? mergedLines(json(pull.last_files)) : heldOf(pull.outcomes_held);
      const out: PullOutcomesStored["stored"] = [];
      for (const commit of report.commits) {
        const landed = time(commit.landed_at);
        if (landed <= since || landed > until || landed <= merged) continue;
        // Not after the commit it was merged as: its lines were not there to change.
        if (asked.found && !(commit.after ?? []).includes(asked.number)) continue;
        const own = commit.pulls.includes(asked.number) || commit.sha === mergeSha;
        const touch = walk(held, commit, own);
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
        }
        // A revert of a revert kept here: the lines came back.
        if (commit.reverts.shas.length > 0) {
          await db.query(
            `UPDATE pull_outcome_commits SET relands = $4, relanded_at = $5
             WHERE org_id = $1 AND repo = $2 AND number = $3 AND kind = 'revert' AND relands IS NULL AND sha <> $4 AND landed_at <= $5
               AND EXISTS (SELECT 1 FROM unnest($6::text[]) AS n(sha) WHERE pull_outcome_commits.sha LIKE n.sha || '%')`,
            [db.orgId, report.repo, asked.number, commit.sha, commit.landed_at, commit.reverts.shas],
          );
        }
      }
      await db.query(
        `UPDATE pull_requests SET outcomes_scanned_until = $4, outcomes_held = $5::jsonb,
           merge_commit_sha = coalesce(merge_commit_sha, $6)
         WHERE org_id = $1 AND repo = $2 AND number = $3`,
        [db.orgId, report.repo, asked.number, new Date(until).toISOString(), JSON.stringify({ lines: held.filter((l) => l[4] > 0) }), asked.merge_commit_sha],
      );
      return out;
    });
    stored.push(...kept);
  }
  await each((db) =>
    db.query(
      `INSERT INTO repo_outcome_scans (org_id, repo, branch, scanned_until, tip) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, repo, branch) DO UPDATE SET
         scanned_until = greatest(repo_outcome_scans.scanned_until, EXCLUDED.scanned_until), tip = EXCLUDED.tip, updated_at = clock_timestamp()`,
      [db.orgId, report.repo, report.base_ref, report.scanned_until, report.tip ?? null],
    ),
  );
  return { stored, scanned_until: report.scanned_until };
}

/** A session with lines in a pull request, and which group it is in for each `by`. */
interface Holder {
  machine_id: string;
  source: string;
  session_id: string;
  model: string;
  user: string;
  matched: Lines;
}

/** A kept commit, split over the sessions as they are matched now. */
interface Split extends PullOutcomeCommit {
  /** Agent lines by session key. */
  shares: Map<string, number>;
}

const holderKey = (s: { machine_id: string; source: string; session_id: string }) => `${s.machine_id}\n${s.source}\n${s.session_id}`;

/**
 * Split a commit's removed lines over the sessions that hold copies of them
 * in the pull request: a session with `k` of the `T` copies the pull request
 * has of a line (its agents' and not) gets `m * k / T` of the `m` removed.
 * Lines then add up across sessions, and a removal of a line a person also
 * wrote is not all put on the agent. It counts when it removed at least
 * `MIN_TOUCH_LINES` agent copies of lines no `COMMON_LINE` sessions share.
 */
function split(row: Record<string, unknown>, holders: Holder[], merged: Map<string, number>): Split {
  const removed = json<Lines>(row.removed) ?? {};
  const shares = new Map<string, number>();
  let lines = 0;
  let agent = 0;
  let notCommon = 0;
  // Agent copies it removed, common or not: the likely-fix share, as the binary's `strength`.
  let copied = 0;
  for (const [path, hashes] of Object.entries(removed)) {
    for (const [hash, m] of countsOf(hashes)) {
      lines += m;
      const having = holders
        .map((h) => ({ h, k: (h.matched[path] ?? []).filter((x) => x === hash).length }))
        .filter(({ k }) => k > 0);
      const copies = having.reduce((sum, { k }) => sum + k, 0);
      if (copies === 0) continue;
      const all = Math.max(copies, merged.get(`${path}\n${hash}`) ?? 0);
      for (const { h, k } of having) {
        const share = Math.min(k, (m * k) / all);
        shares.set(holderKey(h), (shares.get(holderKey(h)) ?? 0) + share);
        agent += share;
      }
      copied += Math.min(m, copies);
      if (having.length < COMMON_LINE) notCommon += Math.min(m, copies);
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

/** The pull requests chosen, merged, with their sessions' lines and their kept commits, split. */
async function readOutcomes(db: OrgDb, chosen: { sql: string; params: unknown[] }) {
  const pulls = await db.query(
    `SELECT p.repo, p.number, p.merged_at, p.outcomes_scanned_until, p.last_files,
            coalesce((SELECT jsonb_agg(jsonb_build_object('machine_id', s.machine_id, 'source', s.source, 'session_id', s.session_id,
                        'model', coalesce(x.primary_model, '${UNKNOWN}'), 'user', coalesce(x.owner_email, '${UNKNOWN}'), 'matched', s.matched)
                        ORDER BY s.machine_id, s.source, s.session_id)
                      FROM pull_sessions s LEFT JOIN sessions x
                        ON x.org_id = s.org_id AND x.machine_id = s.machine_id AND x.source = s.source AND x.session_id = s.session_id
                      WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number AND ${KEPT}), '[]'::jsonb) AS holders
     FROM (SELECT * FROM pull_requests ${chosen.sql}) p
     WHERE p.state = 'merged' AND p.merged_at IS NOT NULL
     ORDER BY p.merged_at, p.repo, p.number`,
    chosen.params,
  );
  const commits = await db.query(
    `SELECT c.repo, c.number, c.sha, c.kind, c.signals, c.landed_at, c.url, c.by_pull, c.removed, c.removed_total, c.relanded_at
     FROM pull_outcome_commits c JOIN (SELECT repo, number FROM pull_requests ${chosen.sql}) p USING (repo, number)
     WHERE c.org_id = $1
     ORDER BY c.landed_at, c.sha`,
    chosen.params,
  );
  const byPull = new Map<string, Record<string, unknown>[]>();
  for (const row of commits) {
    const key = `${row.repo}\n${row.number}`;
    byPull.set(key, [...(byPull.get(key) ?? []), row]);
  }
  return pulls.map((p) => {
    const holders = json<Holder[]>(p.holders) ?? [];
    const merged = new Map<string, number>();
    for (const file of json<{ path: string; hashes: string[] }[]>(p.last_files) ?? []) {
      for (const hash of file.hashes) merged.set(`${file.path}\n${hash}`, (merged.get(`${file.path}\n${hash}`) ?? 0) + 1);
    }
    return {
      repo: String(p.repo),
      number: num(p.number),
      merged_at: time(p.merged_at),
      scanned_until: p.outcomes_scanned_until == null ? null : time(p.outcomes_scanned_until),
      holders,
      commits: (byPull.get(`${p.repo}\n${p.number}`) ?? []).map((row) => split(row, holders, merged)),
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

const lineCount = (lines: Lines) => Object.values(lines).reduce((n, hashes) => n + hashes.length, 0);

/**
 * Merged pull requests' outcomes summed by tool, model, person, repository
 * or day merged, at each age, of the pull requests that reached it. A
 * session is in one group; a pull request is in each group one of its
 * sessions is in. Lines are split by session, so they add up across groups;
 * a commit or a pull request counts once in each group whose lines it
 * changed, and once in the total. The model is the session's main one.
 */
export async function summarizeOutcomes(db: OrgDb, by: PullOutcomesBy, filters: OutcomeFilters, now = Date.now()): Promise<PullOutcomesSummary> {
  const pulls = await readOutcomes(db, where(db.orgId, { repo: filters.repo, state: "merged", since: filters.since }));
  const keyOf = (pull: Read, h: Holder): string =>
    by === "tool" ? h.source : by === "model" ? h.model : by === "user" ? h.user : by === "repo" ? pull.repo : new Date(pull.merged_at).toISOString().slice(0, 10);
  const wanted = (h: Holder) =>
    (!filters.tool || h.source === filters.tool) && (!filters.model || h.model === filters.model) && (!filters.user || h.user === filters.user);
  type Sums = { ages: Record<OutcomeAge, PullOutcomesAt>; lines: number };
  const groups = new Map<string, Sums>();
  const total: Sums = { ages: { "1d": blank(), "7d": blank(), "30d": blank() }, lines: 0 };
  const add = (sums: Sums, pull: Read, holders: Holder[]) => {
    const keys = new Set(holders.map(holderKey));
    const lines = holders.reduce((n, h) => n + lineCount(h.matched), 0);
    sums.lines += lines;
    for (const [age, days] of OUTCOME_AGES) {
      const at = sums.ages[age];
      at.pulls_total += 1;
      if (!reachedAt(pull, days, now)) continue;
      at.pulls_reached += 1;
      at.agent_lines += lines;
      // The commits that changed these sessions' lines, and how many of them.
      const mine = within(pull, days)
        .map((c) => ({ c, lines: [...c.shares].filter(([key]) => keys.has(key)).reduce((n, [, l]) => n + l, 0) }))
        .filter(({ lines: l }) => l > 0);
      const of = (kind: OutcomeKind) => mine.filter(({ c }) => c.kind === kind);
      at.revert_commits += of("revert").length;
      at.agent_lines_reverted += of("revert").reduce((n, { lines: l }) => n + l, 0);
      at.fix_commits += of("fix").length;
      at.likely_fix_commits += of("fix").filter(({ c }) => c.likely).length;
      at.agent_lines_fixed += of("fix").reduce((n, { lines: l }) => n + l, 0);
      at.rework_commits += of("rework").length;
      at.agent_lines_reworked += of("rework").reduce((n, { lines: l }) => n + l, 0);
      at.sessions_fixed += new Set(of("fix").flatMap(({ c }) => [...c.shares].filter(([key, l]) => keys.has(key) && l > 0).map(([key]) => key))).size;
      if (revertedBy(mine.map(({ c }) => c), pull.merged_at + days * DAY)) at.pulls_reverted += 1;
    }
  };
  for (const pull of pulls) {
    const holders = pull.holders.filter(wanted);
    if (holders.length === 0) continue;
    const byKey = new Map<string, Holder[]>();
    for (const h of holders) byKey.set(keyOf(pull, h), [...(byKey.get(keyOf(pull, h)) ?? []), h]);
    for (const [key, some] of byKey) {
      const sums = groups.get(key) ?? { ages: { "1d": blank(), "7d": blank(), "30d": blank() }, lines: 0 };
      add(sums, pull, some);
      groups.set(key, sums);
    }
    add(total, pull, holders);
  }
  const out = (sums: Sums): Omit<PullOutcomesGroup, "key"> => ({
    outcomes_1d: sums.ages["1d"],
    outcomes_7d: sums.ages["7d"],
    outcomes_30d: sums.ages["30d"],
  });
  const sorted = [...groups].sort(([a, x], [b, y]) => (by === "day" ? a.localeCompare(b) : y.lines - x.lines || a.localeCompare(b)));
  return { groups: sorted.map(([key, sums]) => ({ key, ...out(sums) })), total: out(total) };
}

