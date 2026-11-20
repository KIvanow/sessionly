// A merged pull request's agent lines, counted again on the branch it was
// merged into 7 and 30 days after. The server holds hashes and cannot see
// the branch, so the Action reads the files there and sends their lines as
// hashes. Each count is a row of its own table, written once: the reports
// of a pull request, and their history, know nothing of these.
import type { FileHashes, PullAfterMerge, PullAfterMergeReport, PullDue } from "@sessionly/schema";
import type { OrgDb } from "./db.ts";
import { BadReport, HASH, holdPull, MAX_FILES } from "./pulls.ts";

/** The ages after merging at which the lines are counted, in days. */
export const AFTER_MERGE = [
  ["7d", 7],
  ["30d", 30],
] as const;
type Age = (typeof AFTER_MERGE)[number][0];

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/** A session's lines in a pull request: the hashes, by file, as often as they are there. */
type Lines = Record<string, string[]>;

/** No more pull requests than this are asked for at once: the Action reads each of their files from GitHub. */
const DUE_AT_ONCE = 50;

/**
 * The ages a merged pull request has reached and has no count for. An age
 * it reached before its organisation counted any (`after_merge_since`) is
 * not among them: nothing was counted then, and what is on the branch today
 * is not what was there that day. One missed since is, and its count says
 * how old the merge really was.
 */
const DUE = `
  FROM pull_requests p
  JOIN orgs o ON o.id = p.org_id
  CROSS JOIN (VALUES ${AFTER_MERGE.map(([name, days]) => `('${name}', ${days})`).join(", ")}) AS c(age, days)
  WHERE p.org_id = $1 AND p.repo = $2 AND p.state = 'merged' AND p.merged_at IS NOT NULL
    AND p.merged_at + make_interval(days => c.days) <= now()
    AND p.merged_at + make_interval(days => c.days) >= o.after_merge_since
    AND NOT EXISTS (SELECT 1 FROM pull_after_merge m
                    WHERE m.org_id = p.org_id AND m.repo = p.repo AND m.number = p.number AND m.checkpoint = c.age)`;

/**
 * The merged pull requests of a repository whose agent lines are to be
 * counted again, the longest merged first: which ages each has reached, and
 * which files to read. One with no agent lines whose sessions are kept has
 * nothing to count, and is not asked for. No line hashes: the Action sends
 * the files' own, and the server compares.
 */
export async function pullsDue(db: OrgDb, repo: string): Promise<PullDue[]> {
  // Which lines are kept of a session, as a map by file: only its files are read, and of no more pull requests than are answered.
  const kept = `pull_sessions s WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number
                AND s.lines > 0 AND jsonb_typeof(s.matched) = 'object' AND s.matched <> '{}'::jsonb`;
  const rows = await db.query(
    `SELECT d.number, d.base_ref, d.ages,
            (SELECT array_agg(DISTINCT k.path ORDER BY k.path)
             FROM pull_sessions s, jsonb_object_keys(CASE WHEN jsonb_typeof(s.matched) = 'object' THEN s.matched ELSE '{}'::jsonb END) AS k(path)
             WHERE s.org_id = $1 AND s.repo = $2 AND s.number = d.number AND s.lines > 0) AS paths
     FROM (
       SELECT p.number, p.base_ref, p.merged_at, array_agg(c.age ORDER BY c.days) AS ages
       ${DUE}
         AND EXISTS (SELECT 1 FROM ${kept})
       GROUP BY p.number, p.base_ref, p.merged_at
       ORDER BY p.merged_at, p.number
       LIMIT ${DUE_AT_ONCE}
     ) d
     ORDER BY d.merged_at, d.number`,
    [db.orgId, repo],
  );
  return rows.map((row) => ({
    number: num(row.number),
    base_ref: (row.base_ref as string) ?? null,
    checkpoints: (row.ages as Age[]) ?? [],
    paths: (row.paths as string[]) ?? [],
  }));
}

/** A count after merging as the Action sends it, checked; throws `BadReport` saying what is wrong with it. */
export function checkAfterMerge(body: unknown): PullAfterMergeReport {
  const r = body as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new BadReport(what);
  };
  if (!r || typeof r !== "object") fail("the report is not an object");
  if (typeof r.repo !== "string" || r.repo === "") fail("repo is required");
  if (!Number.isInteger(r.number) || (r.number as number) < 1) fail("number must be a pull request number");
  const files = Array.isArray(r.files) ? r.files : fail("files must be a list");
  if (files.length > MAX_FILES) fail(`a report can list at most ${MAX_FILES} files`);
  for (const file of files as Record<string, unknown>[]) {
    const ok =
      file && typeof file.path === "string" && file.path !== "" && Array.isArray(file.hashes) &&
      file.hashes.every((h) => typeof h === "string" && HASH.test(h));
    if (!ok) fail("each file needs a path and hashes of 16 hex digits");
  }
  const ages = Array.isArray(r.checkpoints) ? r.checkpoints : fail("checkpoints must be a list");
  if (ages.length === 0 || !ages.every((age) => AFTER_MERGE.some(([name]) => name === age))) {
    fail(`checkpoints must name the ages asked for: ${AFTER_MERGE.map(([name]) => name).join(" or ")}`);
  }
  return {
    repo: (r.repo as string).replace(/\/+$/, ""),
    number: r.number as number,
    checkpoints: [...new Set(ages as Age[])],
    files: (files as FileHashes[]).map((f) => ({ path: f.path, hashes: f.hashes })),
  };
}

/**
 * How many of the lines are in the files as they are now: a line of a file
 * counts for one line an agent added to it, as in the rewrite rate. A file
 * that is not among `files` has none of them.
 */
export function stillThere(sessions: Lines[], files: FileHashes[]): number {
  const left = new Map<string, Map<string, number>>();
  for (const file of files) {
    const counts = left.get(file.path) ?? new Map<string, number>();
    for (const hash of file.hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    left.set(file.path, counts);
  }
  let lines = 0;
  for (const matched of sessions) {
    for (const [path, hashes] of Object.entries(matched)) {
      const counts = left.get(path);
      if (!counts) continue;
      for (const hash of hashes) {
        const n = counts.get(hash) ?? 0;
        if (n === 0) continue;
        counts.set(hash, n - 1);
        lines += 1;
      }
    }
  }
  return lines;
}

const COLUMNS = `checkpoint, agent_lines, surviving, measured_at, age_seconds`;

function counted(row: Record<string, unknown>): PullAfterMerge {
  return {
    checkpoint: row.checkpoint as Age,
    agent_lines: num(row.agent_lines),
    surviving: num(row.surviving),
    at: new Date(row.measured_at as string).toISOString(),
    age_seconds: num(row.age_seconds),
  };
}

/**
 * Count a merged pull request's agent lines again, in the files as the
 * Action read them on the branch it was merged into, and keep the count for
 * each age it has reached and has none for (`DUE`), of the ages the files
 * were read for: one reached since they were read is asked for again, and
 * counted from files read then. A count once kept is never changed: a
 * second report of the same age keeps nothing. The agent lines are those of
 * the sessions whose lines the pull request keeps (`pull_sessions.matched`).
 * Null if there is no such pull request; the counts kept, which may be none.
 */
export async function storeAfterMerge(db: OrgDb, report: PullAfterMergeReport): Promise<PullAfterMerge[] | null> {
  await holdPull(db, report.repo, report.number);
  const [pull] = await db.query(
    `SELECT state FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
    [db.orgId, report.repo, report.number],
  );
  if (!pull) return null;
  if (pull.state !== "merged") throw new BadReport("this pull request is not merged");
  const due = await db.query<{ age: Age; age_seconds: unknown }>(
    `SELECT c.age, floor(extract(epoch FROM now() - p.merged_at)) AS age_seconds ${DUE} AND p.number = $3 AND c.age = ANY($4::text[])
     ORDER BY c.days`,
    [db.orgId, report.repo, report.number, report.checkpoints],
  );
  if (due.length === 0) return [];
  const rows = await db.query(
    `SELECT lines, matched FROM pull_sessions
     WHERE org_id = $1 AND repo = $2 AND number = $3 AND lines > 0 AND matched IS NOT NULL
     ORDER BY machine_id, source, session_id`,
    [db.orgId, report.repo, report.number],
  );
  const sessions = rows.map((row) => json<Lines>(row.matched));
  const of = rows.reduce((sum, row) => sum + num(row.lines), 0);
  if (of === 0) return [];
  // Every file with agent lines has to be told of: one left out would count as gone.
  const sent = new Set(report.files.map((file) => file.path));
  const missing = [...new Set(sessions.flatMap((matched) => Object.keys(matched)))].filter((path) => !sent.has(path));
  if (missing.length > 0) {
    throw new BadReport(`the report leaves out ${missing.length} of the files asked for (${missing[0]}): ask again which are due`);
  }
  const surviving = stillThere(sessions, report.files);
  const kept: PullAfterMerge[] = [];
  for (const { age, age_seconds } of due) {
    const [row] = await db.query(
      `INSERT INTO pull_after_merge (org_id, repo, number, checkpoint, agent_lines, surviving, age_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, repo, number, checkpoint) DO NOTHING
       RETURNING ${COLUMNS}`,
      [db.orgId, report.repo, report.number, age, of, surviving, num(age_seconds)],
    );
    if (row) kept.push(counted(row));
  }
  return kept;
}

/** The counts kept of a pull request, the earlier age first. */
export async function afterMergeOf(db: OrgDb, repo: string, number: number): Promise<PullAfterMerge[]> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM pull_after_merge WHERE org_id = $1 AND repo = $2 AND number = $3`,
    [db.orgId, repo, number],
  );
  const order = (row: PullAfterMerge) => AFTER_MERGE.findIndex(([name]) => name === row.checkpoint);
  return rows.map(counted).sort((a, b) => order(a) - order(b));
}
