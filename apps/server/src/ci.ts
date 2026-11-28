// CI on pull requests' commits: what the checks and statuses said of each
// head a pull request was reported at (a red push), and of the commit it
// was merged as (the base branch red after it). The Action reads them on
// GitHub and sends counts and a state, never what ran, unless asked to name
// the checks that failed. A session's lines arrived with the first head that
// has one of them: whether CI was red there ("red on arrival") is worked out
// as it is read, from the sessions' lines as matched now, so it follows
// matching again, hiding and deleting with no bookkeeping. CI failing is
// linked, not caused: tests are flaky and systems go down.
import type { CiReport, CiState, PullCi, PullCiDue, PullCiReport, PullCiStored, PullHead } from "@sessionly/schema";
import type { OrgDb } from "./db.ts";
import { type Lines, lineKey } from "./contributed.ts";
import { applyCi, BadReport, checkCi } from "./pulls.ts";

/** A head nobody said anything of for this long is taken to have no CI: pending no more. */
export const PENDING_DAYS = 7;
const DAY = 86_400_000;
/** No more heads, and no more merge commits, than this are asked for at once, nor taken in one report. */
const DUE_AT_ONCE = 50;
const MOST_IN_REPORT = 100;
/** No more of a pull request's pending heads than this are named in a report's answer. */
const PENDING_AT_ONCE = 20;
const MOST_NAME_BYTES = 1024;

const num = (value: unknown): number | null => (value == null ? null : Number(value));
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown): string | null => (value == null ? null : new Date(value as string).toISOString());
const time = (value: unknown): number => new Date(value as string).getTime();

/** The sessions whose lines in a pull request are kept: those it has lines of (see `KEPT` in after-merge.ts). */
const KEPT = `(jsonb_typeof(s.matched) = 'object' AND s.matched <> '{}'::jsonb)`;

/** Whether CI came out one way or the other: what is in a denominator. */
export const known = (state: CiState | null | undefined): boolean => state === "success" || state === "failure";

/**
 * A head's state as it is now: one no run has said anything of (`checkedAt`
 * null) is not known, which is not running; one read as pending
 * `PENDING_DAYS` ago or more, since it was reported, has none.
 */
export function stateNow(state: CiState, firstReportedAt: number, now: number, checkedAt: number | null): CiState {
  if (checkedAt == null) return "unknown";
  return state === "pending" && now >= firstReportedAt + PENDING_DAYS * DAY ? "none" : state;
}

/** What CI said of commits, as `PUT /prs/ci` takes it, checked; throws `BadReport` saying what is wrong with it. */
export function checkCiReport(body: unknown): PullCiReport {
  const r = body as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new BadReport(what);
  };
  if (!r || typeof r !== "object") fail("the report is not an object");
  if (typeof r.repo !== "string" || r.repo === "") fail("repo is required");
  if (Buffer.byteLength(r.repo as string) > MOST_NAME_BYTES) fail(`repo is longer than ${MOST_NAME_BYTES} bytes`);
  const numbered = (value: unknown, what: string): (CiReport & { number: number })[] => {
    const list = value ?? [];
    if (!Array.isArray(list)) fail(`${what} must be a list`);
    for (const item of list as Record<string, unknown>[]) {
      if (!item || !Number.isInteger(item.number) || (item.number as number) < 1 || (item.number as number) > 2 ** 31 - 1) fail(`each of ${what} needs a pull request number`);
    }
    // Checked as one list, a commit once for each pull request it is named with.
    const checked = checkCi(list, fail, MOST_IN_REPORT) ?? [];
    const by = new Map(checked.map((c) => [c.sha, c]));
    const seen = new Set<string>();
    return (list as Record<string, unknown>[]).flatMap((item) => {
      const key = `${item.number}\n${item.sha}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...by.get(item.sha as string)!, number: item.number as number }];
    });
  };
  return { repo: (r.repo as string).replace(/\/+$/, ""), heads: numbered(r.heads, "heads"), merges: numbered(r.merges, "merges") };
}

/**
 * Heads of a repository read as pending `PENDING_DAYS` ago or more are taken
 * to have no CI (a check that never finished), so they are not asked for
 * again; a merge commit pending that long after merging likewise. One no
 * run has read stays as it is, not known: it is asked for while it is that
 * young, and not after.
 */
async function agePending(db: OrgDb, repo: string): Promise<void> {
  await db.query(
    `UPDATE pull_heads SET ci_state = 'none'
     WHERE org_id = $1 AND repo = $2 AND ci_state = 'pending' AND ci_checked_at IS NOT NULL AND first_reported_at < now() - make_interval(days => ${PENDING_DAYS})`,
    [db.orgId, repo],
  );
  await db.query(
    `UPDATE pull_requests SET merge_ci = merge_ci || '{"state": "none"}'::jsonb
     WHERE org_id = $1 AND repo = $2 AND state = 'merged' AND merge_ci->>'state' = 'pending' AND merged_at < now() - make_interval(days => ${PENDING_DAYS})`,
    [db.orgId, repo],
  );
}

/**
 * The commits of a repository whose CI the Action is to read: heads still
 * pending (reported in the last `PENDING_DAYS`; older ones are taken to
 * have none first), and the commits merged pull requests with agent lines
 * were merged as, of which nothing is known yet or only that CI was
 * pending. Oldest first, `DUE_AT_ONCE` of each. No hashes.
 */
export async function ciDue(db: OrgDb, repo: string): Promise<PullCiDue> {
  await agePending(db, repo);
  const heads = await db.query(
    `SELECT number, sha FROM pull_heads
     WHERE org_id = $1 AND repo = $2 AND ci_state = 'pending' AND first_reported_at >= now() - make_interval(days => ${PENDING_DAYS})
     ORDER BY first_reported_at, number, sha LIMIT ${DUE_AT_ONCE}`,
    [db.orgId, repo],
  );
  const merges = await db.query(
    `SELECT p.number, p.merge_commit_sha AS sha, p.base_ref FROM pull_requests p
     WHERE p.org_id = $1 AND p.repo = $2 AND p.state = 'merged' AND p.merged_at IS NOT NULL AND p.merge_commit_sha IS NOT NULL
       AND (p.merge_ci IS NULL OR p.merge_ci->>'state' = 'pending')
       AND EXISTS (SELECT 1 FROM pull_sessions s WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number AND ${KEPT})
     ORDER BY p.merged_at, p.number LIMIT ${DUE_AT_ONCE}`,
    [db.orgId, repo],
  );
  const named = (rows: Record<string, unknown>[]) => rows.map((row) => ({ number: Number(row.number), sha: String(row.sha) }));
  return { heads: named(heads), merges: merges.map((row) => ({ number: Number(row.number), sha: String(row.sha), base_ref: (row.base_ref as string) ?? null })) };
}

/** Keep what a report of CI says, of the commits the server knows (`applyCi`); how many of each were changed. */
export async function storeCi(db: OrgDb, report: PullCiReport): Promise<PullCiStored> {
  const stored = { heads: 0, merges: 0 };
  const byPull = new Map<number, CiReport[]>();
  for (const c of [...report.heads, ...report.merges]) byPull.set(c.number, [...(byPull.get(c.number) ?? []), c]);
  for (const [number, ci] of byPull) {
    const { heads, merges } = await applyCi(db, report.repo, number, ci);
    stored.heads += heads;
    stored.merges += merges;
  }
  return stored;
}

/** A pull request's heads whose CI is still pending, oldest first, `PENDING_AT_ONCE` at most: the answer to its report names them, and the same run reads them. */
export async function ciPending(db: OrgDb, repo: string, number: number, now = Date.now()): Promise<{ number: number; sha: string }[]> {
  const rows = await db.query(
    `SELECT sha, first_reported_at FROM pull_heads WHERE org_id = $1 AND repo = $2 AND number = $3 AND ci_state = 'pending'
     ORDER BY first_reported_at, sha LIMIT ${PENDING_AT_ONCE}`,
    [db.orgId, repo, number],
  );
  return rows.filter((row) => now < time(row.first_reported_at) + PENDING_DAYS * DAY).map((row) => ({ number, sha: String(row.sha) }));
}

/** A head as read: its state as it is now, and which of the pull request's lines were new at it (null where not read). */
export interface HeadRead {
  sha: string;
  first_reported_at: number;
  state: CiState;
  hashes: Lines | null;
}

/**
 * For each line of a pull request, by file and hash, the heads its copies
 * arrived with, one for each copy in the order reported: a head's new lines
 * are the copies beyond those the head before had, so the k-th copy arrived
 * with the head where there were first k.
 */
export function arrivals(heads: HeadRead[]): Map<string, number[]> {
  const at = new Map<string, number[]>();
  heads.forEach((head, i) => {
    for (const [path, hashes] of Object.entries(head.hashes ?? {})) {
      if (!Array.isArray(hashes)) continue;
      for (const hash of hashes) {
        const list = at.get(lineKey(path, hash));
        if (list) list.push(i);
        else at.set(lineKey(path, hash), [i]);
      }
    }
  });
  return at;
}

/**
 * Whether CI was red where a session's lines (`matched`, as now) arrived:
 * at the first head that brought one of them. Of a line the pull request
 * has several copies of, the session's `k` are taken for the last `k` to
 * arrive: the earlier ones may be another session's, or a person's (as
 * copies are shared out when a commit removes them). Null when it has no
 * lines in a head read, or that head's CI is not known (not read, pending,
 * or none to go by).
 */
export function redOnArrival(heads: HeadRead[], at: Map<string, number[]>, matched: Lines | null): boolean | null {
  let first: number | null = null;
  for (const [path, hashes] of Object.entries(matched ?? {})) {
    if (!Array.isArray(hashes)) continue;
    const copies = new Map<string, number>();
    for (const hash of hashes) copies.set(hash, (copies.get(hash) ?? 0) + 1);
    for (const [hash, k] of copies) {
      const came = at.get(lineKey(path, hash));
      if (!came) continue;
      const i = came[Math.max(0, came.length - k)]!;
      if (first === null || i < first) first = i;
    }
  }
  if (first === null) return null;
  const state = heads[first]!.state;
  return known(state) ? state === "failure" : null;
}

/** A head's CI as kept, for the page. */
export function ciOfRow(row: Record<string, unknown>, now: number): PullCi {
  const names = row.failed_checks == null ? null : json<string[]>(row.failed_checks);
  return {
    state: stateNow(row.ci_state as CiState, time(row.first_reported_at), now, row.ci_checked_at == null ? null : time(row.ci_checked_at)),
    failed: num(row.ci_failed),
    total: num(row.ci_total),
    cancelled: num(row.ci_cancelled),
    checked_at: iso(row.ci_checked_at),
    ...(Array.isArray(names) && names.length > 0 ? { failed_checks: names.map(String) } : {}),
  };
}

/**
 * The merge commit's CI as kept (`merge_ci`), checked field by field: null
 * where none was. One read as pending `PENDING_DAYS` after merging or more
 * has none, as a head would (the schedule writes that; this reads it so).
 */
export function mergeCiOf(value: unknown, mergedAt: number | null = null, now = Date.now()): PullCi | null {
  const kept = json<Record<string, unknown> | null>(value);
  if (!kept || typeof kept !== "object" || typeof kept.state !== "string") return null;
  let state = (["pending", "success", "failure", "none"] as CiState[]).includes(kept.state as CiState) ? (kept.state as CiState) : "none";
  if (state === "pending" && mergedAt != null && now >= mergedAt + PENDING_DAYS * DAY) state = "none";
  const count = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
  const names = Array.isArray(kept.failed_checks) ? kept.failed_checks.filter((n): n is string => typeof n === "string") : [];
  return {
    state,
    failed: count(kept.failed),
    total: count(kept.total),
    cancelled: count(kept.cancelled),
    checked_at: typeof kept.checked_at === "string" ? kept.checked_at : null,
    ...(names.length > 0 ? { failed_checks: names } : {}),
  };
}

/**
 * What CI said of one pull request's commits, for its page: each head as
 * reported, oldest first, the merge commit's, and for each session with
 * lines in it (by `machine_id\nsource\nsession_id`) whether CI was red where
 * its lines arrived.
 */
export async function ciOf(
  db: OrgDb,
  repo: string,
  number: number,
  now = Date.now(),
): Promise<{ heads: PullHead[]; merge_ci: PullCi | null; merge_commit_sha: string | null; red_on_arrival: Map<string, boolean | null> }> {
  const rows = await db.query(
    `SELECT sha, first_reported_at, ci_state, ci_failed, ci_total, ci_cancelled, ci_checked_at, failed_checks, hashes
     FROM pull_heads WHERE org_id = $1 AND repo = $2 AND number = $3 ORDER BY first_reported_at, sha`,
    [db.orgId, repo, number],
  );
  const [pull] = await db.query(`SELECT merge_ci, merge_commit_sha, merged_at FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3`, [db.orgId, repo, number]);
  const read: HeadRead[] = rows.map((row) => ({
    sha: String(row.sha),
    first_reported_at: time(row.first_reported_at),
    state: stateNow(row.ci_state as CiState, time(row.first_reported_at), now, row.ci_checked_at == null ? null : time(row.ci_checked_at)),
    hashes: json<Lines>(row.hashes),
  }));
  const at = arrivals(read);
  const sessions = await db.query(
    `SELECT s.machine_id, s.source, s.session_id, s.matched FROM pull_sessions s WHERE s.org_id = $1 AND s.repo = $2 AND s.number = $3 AND ${KEPT}`,
    [db.orgId, repo, number],
  );
  return {
    heads: rows.map((row) => ({ sha: String(row.sha), first_reported_at: iso(row.first_reported_at)!, ci: ciOfRow(row, now) })),
    merge_ci: pull ? mergeCiOf(pull.merge_ci, pull.merged_at == null ? null : time(pull.merged_at), now) : null,
    merge_commit_sha: (pull?.merge_commit_sha as string) ?? null,
    red_on_arrival: new Map(sessions.map((s) => [`${s.machine_id}\n${s.source}\n${s.session_id}`, redOnArrival(read, at, json<Lines | null>(s.matched))])),
  };
}
