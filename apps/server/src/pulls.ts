// Pull requests reported by the GitHub Action, and which of their lines
// agents wrote. A pull request's added lines arrive as hashes; sessions
// uploaded with line hashes say which lines an agent added to which file.
// Matching the two needs no source code on the server.
import type {
  FileHashes,
  LinesBy,
  PullAttribution,
  PullCloud,
  PullDetail,
  PullFeedback,
  PullFile,
  PullHistory,
  PullHistoryNamedSession,
  PullList,
  PullMatch,
  PullMatches,
  PullReport,
  PullRow,
  PullSession,
  PullSummary,
  PullsByModel,
} from "@sessionly/schema";
import { createHash, createHmac } from "node:crypto";
import type { OrgDb } from "./db.ts";

export class BadReport extends Error {}

/**
 * The version of the Action whose reports this server understands. The same
 * string as `version` in `action/package.json`: a test fails when the two
 * differ. Bump both with every change to what a report contains.
 */
export const CURRENT_ACTION = "0.2.0";

/** Sessions that started longer than this before a pull request was opened are not looked at. */
const LOOK_BACK_DAYS = 90;
const MAX_FILES = 5000;
const MAX_FEEDBACK = 2000;
const HASH = /^[0-9a-f]{16}$/;

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const iso = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/** Lines an agent added to one file in one session. */
export interface Claim {
  tool: string;
  model: string | null;
  /** As uploaded: relative to the repository, or to the home directory, or absolute. */
  path: string;
  hashes: string[];
  /** When the session started, for telling the latest writer of a line. */
  started: number;
  /** The session, to lead back to it from the pull request. */
  session?: SessionKey;
}

type SessionKey = Pick<PullSession, "machine_id" | "source" | "session_id">;

/** A worktree kept in a `worktrees` or `.worktrees` folder, as agents do: what follows is the path in it. */
const IN_WORKTREE = /^(?:.*\/)?\.?worktrees\/[^/]+\/(.+)$/;

/**
 * Whether a session's file is this file of the repository. A session that
 * ran in the repository reports the same path. One that ran in a worktree
 * reports the path of the worktree's copy: inside the repository
 * (`.claude/worktrees/<name>/…`), or from the home directory or the root,
 * ending with the repository's path.
 */
function samePath(claimed: string, path: string): boolean {
  if (claimed === path || IN_WORKTREE.exec(claimed)?.[1] === path) return true;
  const outside = claimed.startsWith("/") || claimed.startsWith("~/");
  return outside && claimed.endsWith(`/${path}`);
}

export type Writer = { tool: string; model: string | null; session?: SessionKey };

/** For each added line of each file, the agent that wrote it, or null. */
export function writers(files: FileHashes[], claims: Claim[]): (Writer | null)[][] {
  // Looking only at claims on a file of the same name keeps this quick.
  const byName = new Map<string, Claim[]>();
  for (const claim of claims) {
    const name = claim.path.slice(claim.path.lastIndexOf("/") + 1);
    const list = byName.get(name);
    if (list) list.push(claim);
    else byName.set(name, [claim]);
  }
  return files.map((file) => {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    // Per line, who added it: the session that started last comes first.
    const pool = new Map<string, Writer[]>();
    const matching = (byName.get(name) ?? [])
      .filter((claim) => samePath(claim.path, file.path))
      .sort((a, b) => b.started - a.started);
    for (const claim of matching) {
      for (const hash of claim.hashes) {
        const list = pool.get(hash);
        const writer = { tool: claim.tool, model: claim.model, session: claim.session };
        if (list) list.push(writer);
        else pool.set(hash, [writer]);
      }
    }
    // Each line an agent added accounts for one line of the pull request.
    return file.hashes.map((hash) => pool.get(hash)?.shift() ?? null);
  });
}

function tally<T extends LinesBy>(rows: Map<string, T>, writer: Writer, make: () => T): T {
  const key = `${writer.tool}\n${writer.model ?? ""}`;
  let row = rows.get(key);
  if (!row) rows.set(key, (row = make()));
  return row;
}

const sorted = <T extends LinesBy>(rows: Map<string, T>): T[] =>
  [...rows.values()].sort(
    (a, b) => b.lines - a.lines || a.tool.localeCompare(b.tool) || (a.model ?? "").localeCompare(b.model ?? ""),
  );

/**
 * Which lines of a pull request agents wrote: as it was first reported
 * (`first`), as it is now (`now`), and how many of the agents' first lines
 * are still in it. `lines` are the writers of `now`, where they were worked
 * out already.
 */
export function attribute(
  first: FileHashes[],
  now: FileHashes[],
  claims: Claim[],
  lines: (Writer | null)[][] = writers(now, claims),
): Omit<PullAttribution, "from_open" | "cloud"> {
  const count = (files: FileHashes[]) => files.reduce((sum, f) => sum + f.hashes.length, 0);

  const nowBy = new Map<string, LinesBy>();
  let agentNow = 0;
  for (const line of lines.flat()) {
    if (!line) continue;
    agentNow += 1;
    tally(nowBy, line, () => ({ tool: line.tool, model: line.model, lines: 0 })).lines += 1;
  }

  // What is left of each file's lines now, to tick the first lines off against.
  const left = new Map<string, Map<string, number>>();
  for (const file of now) {
    const counts = left.get(file.path) ?? new Map<string, number>();
    for (const hash of file.hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    left.set(file.path, counts);
  }
  const firstBy = new Map<string, LinesBy & { surviving: number }>();
  let agentFirst = 0;
  const firstWriters = writers(first, claims);
  first.forEach((file, i) => {
    const counts = left.get(file.path);
    file.hashes.forEach((hash, j) => {
      const there = (counts?.get(hash) ?? 0) > 0;
      if (there) counts!.set(hash, counts!.get(hash)! - 1);
      const line = firstWriters[i]![j];
      if (!line) return;
      agentFirst += 1;
      const row = tally(firstBy, line, () => ({ tool: line.tool, model: line.model, lines: 0, surviving: 0 }));
      row.lines += 1;
      if (there) row.surviving += 1;
    });
  });

  return {
    first: { lines: count(first), agent_lines: agentFirst },
    now: { lines: count(now), agent_lines: agentNow, by: sorted(nowBy) },
    by: sorted(firstBy),
  };
}

/**
 * A pull request's lines as they are now, file by file and session by
 * session: where its agent lines are, and which sessions they came from.
 * `lines` are its writers, the same ones `attribute` counts.
 */
export function breakdown(now: FileHashes[], lines: (Writer | null)[][]): { files: PullFile[]; sessions: Omit<PullSession, "session">[] } {
  const sessions = new Map<string, Omit<PullSession, "session">>();
  const files = now.map((file, i) => {
    let agent = 0;
    for (const line of lines[i]!) {
      if (!line) continue;
      agent += 1;
      const from = line.session;
      if (!from) continue;
      const key = `${from.machine_id}\n${from.source}\n${from.session_id}`;
      const row = sessions.get(key);
      if (row) row.lines += 1;
      else sessions.set(key, { ...from, lines: 1 });
    }
    return { path: file.path, lines: file.hashes.length, agent_lines: agent };
  });
  return {
    files: files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
    sessions: [...sessions.values()].sort((a, b) => b.lines - a.lines || a.session_id.localeCompare(b.session_id)),
  };
}

const FEEDBACK_KINDS = ["review", "inline", "conversation"];
const REVIEW_STATES = ["approved", "changes_requested", "commented", "dismissed"];
/** `X.Y.Z`, each number at most 9 digits, or that with a pre-release suffix of at most 50 characters. */
const ACTION_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-[0-9A-Za-z.-]{1,50})?$/;
/** Reports from this client are the Action's. Any other name is not judged. */
const ACTION_REPORTER = "sessionly-action";
/**
 * A reporter that was present but did not fit. Not `''`, which marks rows
 * stored before a report said who sent it, and not the Action: another
 * client, so it is not judged.
 */
export const UNKNOWN_REPORTER = "unknown";

/** The three numbers of an Action version, ignoring a pre-release suffix. */
function actionNumbers(text: string | null): number[] | null {
  const match = text ? ACTION_VERSION.exec(text) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `version` is older than `current`, number by number. When the
 * numbers are equal, a pre-release is older than the release. One that
 * cannot be read is.
 */
export function olderAction(version: string | null, current: string): boolean {
  const now = actionNumbers(current);
  const then = actionNumbers(version);
  if (!now) return false;
  if (!then) return true;
  for (let i = 0; i < now.length; i++) {
    if (then[i] !== now[i]) return then[i]! < now[i]!;
  }
  // A parsed version has a `-` only as its pre-release suffix.
  return Boolean(version?.includes("-")) && !current.includes("-");
}

/**
 * Whether a stored report counts as an older Action. One that named no
 * reporter does. Another client's does not, including one stored as
 * `unknown` because its reporter was present but did not fit, and neither
 * does a row marked `''` from before reports said who sent them. A
 * `sessionly-action` version this server cannot read does not either: it
 * is not known to be old.
 */
function reportIsOlder(name: string | null, version: string | null): boolean {
  if (name != null && name !== ACTION_REPORTER) return false;
  if (name === ACTION_REPORTER && actionNumbers(version) == null) return false;
  return olderAction(version, CURRENT_ACTION);
}

/** How long a current or newer Action report keeps a repository off the notice. */
const ACTION_WINDOW_DAYS = 30;

/** Who sent one report, and the Action version it named. */
interface StoredReport {
  name: string | null;
  version: string | null;
}

/** Whether a repository reports with an older Action, and the version to quote. */
interface RepoReporter {
  older: boolean;
  version: string | null;
}

/**
 * Each repository's most recent judged report, and whether the repository
 * reports with an older Action. A judged report named the Action, or named
 * no one. Another client's is skipped, and so is a row marked `''` from
 * before reports said who sent them. The repository is older when that most
 * recent report is, and none of its judged reports from the last
 * `ACTION_WINDOW_DAYS` days came from the current Action or a newer one.
 * One with no judged report is not. An exact name, not the list's partial match.
 */
async function repoReporters(db: OrgDb, repos: string[]): Promise<Map<string, RepoReporter>> {
  if (repos.length === 0) return new Map();
  const judged = `org_id = $1 AND repo = ANY($2::text[]) AND (reporter_name IS NULL OR reporter_name = $3)`;
  const [recent, window] = await Promise.all([
    db.query<{ repo: string; reporter_name: unknown; reporter_version: unknown }>(
      `SELECT DISTINCT ON (repo) repo, reporter_name, reporter_version
       FROM pull_requests
       WHERE ${judged}
       ORDER BY repo, updated_at DESC`,
      [db.orgId, repos, ACTION_REPORTER],
    ),
    db.query<{ repo: string; reporter_name: unknown; reporter_version: unknown }>(
      `SELECT DISTINCT repo, reporter_name, reporter_version
       FROM pull_requests
       WHERE ${judged} AND updated_at >= now() - make_interval(days => $4::int)`,
      [db.orgId, repos, ACTION_REPORTER, ACTION_WINDOW_DAYS],
    ),
  ]);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const reportOf = (row: { reporter_name: unknown; reporter_version: unknown }): StoredReport => ({
    name: text(row.reporter_name),
    version: text(row.reporter_version),
  });
  const inWindow = new Map<string, StoredReport[]>();
  for (const row of window) {
    const repo = String(row.repo);
    const list = inWindow.get(repo);
    const report = reportOf(row);
    if (list) list.push(report);
    else inWindow.set(repo, [report]);
  }
  const byRepo = new Map<string, RepoReporter>();
  for (const row of recent) {
    const repo = String(row.repo);
    const report = reportOf(row);
    const currentSince = (inWindow.get(repo) ?? []).some((one) => !reportIsOlder(one.name, one.version));
    byRepo.set(repo, {
      older: reportIsOlder(report.name, report.version) && !currentSince,
      version: report.version,
    });
  }
  return byRepo;
}

/**
 * Who sent a report. No `reporter`, or `null`, is an Action from before
 * this was sent. One that is present but does not fit is kept as
 * `UNKNOWN_REPORTER`, so it is not read as that older Action. A version
 * that does not fit is left out and the name is still kept.
 */
function checkReporter(value: unknown): PullReport["reporter"] {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return { name: UNKNOWN_REPORTER };
  const r = value as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 50) return { name: UNKNOWN_REPORTER };
  if (typeof r.version === "string" && ACTION_VERSION.test(r.version)) return { name: r.name, version: r.version };
  return { name: r.name };
}

/** A link that can be followed from the dashboard: a web address, and nothing that runs. */
function webAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A report's reviews and comments, checked. Only what is named here is kept:
 * anything else sent with one, its text above all, is dropped.
 */
function checkFeedback(value: unknown, fail: (what: string) => never): PullFeedback[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FEEDBACK) fail(`feedback must be a list of at most ${MAX_FEEDBACK} reviews and comments`);
  return (value as Record<string, unknown>[]).map((f) => {
    const bad = () => fail("each review or comment needs a kind, an author and a time");
    if (!f || typeof f !== "object" || !FEEDBACK_KINDS.includes(f.kind as string)) bad();
    if (typeof f.author !== "string" || f.author === "" || f.author.length > 100) bad();
    if (typeof f.at !== "string" || Number.isNaN(Date.parse(f.at))) bad();
    const kind = f.kind as PullFeedback["kind"];
    const one: PullFeedback = {
      kind,
      url: webAddress(f.url),
      author: f.author as string,
      bot: f.bot === true,
      at: new Date(f.at as string).toISOString(),
    };
    if (kind === "review") one.state = REVIEW_STATES.includes(f.state as string) ? (f.state as string) : null;
    if (kind === "inline") {
      one.path = typeof f.path === "string" && f.path !== "" && f.path.length <= 1000 ? f.path : null;
      one.line = Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : null;
      one.reply = f.reply === true;
    }
    return one;
  });
}

/** A report as the Action sends it, checked; throws `BadReport` saying what is wrong with it. */
export function checkReport(body: unknown): PullReport {
  const r = body as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new BadReport(what);
  };
  if (!r || typeof r !== "object") fail("the report is not an object");
  const text = (key: string) => (typeof r[key] === "string" && r[key] !== "" ? (r[key] as string) : fail(`${key} is required`));
  const optional = (key: string) => (typeof r[key] === "string" && r[key] !== "" ? (r[key] as string) : null);
  const whole = (key: string) => {
    const n = r[key] ?? 0;
    return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : fail(`${key} must be a whole number`);
  };
  const when = (key: string, required: boolean) => {
    const value = optional(key);
    if (!value) return required ? fail(`${key} is required`) : null;
    return Number.isNaN(Date.parse(value)) ? fail(`${key} is not a time`) : new Date(value).toISOString();
  };
  if (!Number.isInteger(r.number) || (r.number as number) < 1) fail("number must be a pull request number");
  const state = r.state === "open" || r.state === "merged" || r.state === "closed" ? r.state : fail("state must be open, merged or closed");
  const aliases = r.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 20 || !aliases.every((a) => typeof a === "string" && a !== "")) {
    fail("aliases must be a list of at most 20 repository names");
  }
  const emails = r.commit_emails ?? [];
  if (!Array.isArray(emails) || emails.length > 500 || !emails.every((e) => typeof e === "string")) {
    fail("commit_emails must be a list of at most 500 addresses");
  }
  const files = Array.isArray(r.files) ? r.files : fail("files must be a list");
  if (files.length > MAX_FILES) fail(`a report can list at most ${MAX_FILES} files`);
  for (const file of files as Record<string, unknown>[]) {
    const ok =
      file && typeof file.path === "string" && file.path !== "" && Array.isArray(file.hashes) &&
      file.hashes.every((h) => typeof h === "string" && HASH.test(h));
    if (!ok) fail("each file needs a path and hashes of 16 hex digits");
  }
  const feedback = checkFeedback(r.feedback, fail);
  return {
    repo: text("repo").replace(/\/+$/, ""),
    head_repo: optional("head_repo"),
    aliases: aliases as string[],
    commit_emails: (emails as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean),
    number: r.number as number,
    title: optional("title"),
    url: optional("url"),
    author: text("author"),
    state,
    draft: r.draft === true,
    head_ref: optional("head_ref"),
    base_ref: optional("base_ref"),
    created_at: when("created_at", true)!,
    merged_at: when("merged_at", false),
    closed_at: when("closed_at", false),
    event: optional("event") ?? "unknown",
    commits: whole("commits"),
    reviews: whole("reviews"),
    changes_requested: whole("changes_requested"),
    review_comments: whole("review_comments"),
    bot_review_comments: whole("bot_review_comments"),
    review_rounds: whole("review_rounds"),
    files: (files as FileHashes[]).map((f) => ({ path: f.path, hashes: f.hashes })),
    files_without_diff: whole("files_without_diff"),
    feedback,
    // Never fewer than were sent, whatever the report says.
    feedback_total: feedback && Math.max(feedback.length, r.feedback_total == null ? 0 : whole("feedback_total")),
    reporter: checkReporter(r.reporter),
  };
}

/** What of a pull request says which sessions' lines may be its own. */
type Matched = Pick<PullReport, "repo" | "head_repo" | "aliases" | "commit_emails" | "head_ref" | "created_at"> & {
  /** It had committers, and none of them has a session here: nobody's lines are its own. */
  nobody?: boolean;
};

/**
 * The names a session may know the pull request's repository by: a session
 * names it by its clone's origin, which is the repository itself, a fork the
 * branch is in, or a name it used to have.
 */
const repoNames = (report: Pick<Matched, "repo" | "head_repo" | "aliases">): string[] => [
  ...new Set([report.repo, report.head_repo ?? report.repo, ...(report.aliases ?? [])]),
];

/** Which key a kept committer was made with: the beginning of a hash of it, and nothing the key can be had from. */
const keyName = (key: string): string => createHash("sha256").update(`sessionly committers\n${key}`).digest("hex").slice(0, 8);

/**
 * What is kept of an address a pull request's commits were made with: enough
 * to tell later which of the people with sessions here made them, and not
 * the address. Another organisation's hash of the same address differs.
 *
 * With a `key` (SESSIONLY_HASH_KEY), which the database does not hold, it
 * cannot be made from a guessed address by someone who has only the
 * database, and it begins with the key's name. Without one it is a plain hash.
 */
const committer = (orgId: string, email: string, key?: string): string =>
  key
    ? `${keyName(key)}.${createHmac("sha256", key).update(`${orgId}\n${email}`).digest("hex")}`
    : createHash("sha256").update(`${orgId}\n${email}`).digest("hex");

/** Whether kept committers were made with this key (or, with none, with none): others cannot be told from addresses. */
const keptWith = (kept: string[], key?: string): boolean => {
  const name = key ? keyName(key) : null;
  return kept.every((one) => (one.includes(".") ? one.split(".")[0] : null) === name);
};

/** Whose a session is: the address git was set up with where it ran, or failing that its uploader's. */
const SESSION_EMAIL = `lower(coalesce(nullif(user_email, ''), owner_email))`;

/**
 * The addresses behind a pull request's kept committers, as far as they can
 * be known: those of people with sessions in its repository, and the ones
 * cloud agents commit with. A committer with no session here stays unknown,
 * and has no lines to match either: `nobody` when that is all of them.
 */
async function committersAmong(
  db: OrgDb,
  names: string[],
  kept: string[],
  key?: string,
): Promise<{ emails: string[]; nobody: boolean }> {
  // A report that named no committers has every session in the repository looked at.
  if (kept.length === 0) return { emails: [], nobody: false };
  const params: unknown[] = [db.orgId];
  const rows = await db.query<{ email: string | null }>(
    `SELECT DISTINCT ${SESSION_EMAIL} AS email FROM sessions
     WHERE org_id = $1 AND repo IN (${names.map((name) => `$${params.push(name)}`).join(", ")})`,
    params,
  );
  const known = [...rows.map((row) => row.email), ...Object.keys(CLOUD_COMMITTERS)];
  const theirs = new Set(kept);
  const emails = known.filter((email): email is string => !!email && theirs.has(committer(db.orgId, email, key)));
  return { emails, nobody: emails.length === 0 };
}

/** The identities cloud agents commit with, and the branches they make. */
const CLOUD_COMMITTERS: Record<string, string> = {
  "noreply@anthropic.com": "claude-code",
  "cursoragent@cursor.com": "cursor",
};
const CLOUD_BRANCHES: [RegExp, string][] = [
  [/^cursor\//, "cursor"],
  // Its cloud sessions name their branch either way.
  [/^(claude\/|ccr-[0-9a-f]{8}-)/, "claude-code"],
];

/**
 * Whether a cloud agent worked on the pull request, going by who made its
 * commits and what its branch is called, and how many cloud sessions were
 * uploaded for that branch. Null if nothing points to one.
 */
async function cloudOf(db: OrgDb, report: Matched): Promise<PullCloud | null> {
  const agents = new Set<string>();
  for (const email of report.commit_emails ?? []) {
    const agent = CLOUD_COMMITTERS[email];
    if (agent) agents.add(agent);
  }
  const branch = report.head_ref ?? "";
  for (const [pattern, agent] of CLOUD_BRANCHES) {
    if (pattern.test(branch)) agents.add(agent);
  }
  let sessions = 0;
  if (branch) {
    const params: unknown[] = [db.orgId, branch];
    const names = repoNames(report).map((name) => `$${params.push(name)}`).join(", ");
    const rows = await db.query<{ source: string; n: unknown }>(
      `SELECT source, count(*) AS n FROM sessions
       WHERE org_id = $1 AND runtime = 'cloud' AND branch = $2 AND repo IN (${names}) GROUP BY source`,
      params,
    );
    for (const row of rows) {
      sessions += num(row.n);
      agents.add(String(row.source));
    }
  }
  return agents.size ? { agents: [...agents].sort(), sessions } : null;
}

/** What agents added in the repository around the time of a pull request. */
async function claimsFor(db: OrgDb, report: Matched): Promise<Claim[]> {
  const since = new Date(Date.parse(report.created_at) - LOOK_BACK_DAYS * 86_400_000).toISOString();
  const names = repoNames(report);
  // Only this organisation's sessions: another's, in the same repository and
  // by the same committer, are not this pull request's.
  const params: unknown[] = [since, db.orgId];
  const list = (values: string[]) => values.map((value) => `$${params.push(value)}`).join(", ");
  // The same line turns up in more than one person's work. Only sessions of
  // the people who committed to the pull request are taken to have written
  // it. A cloud agent commits as itself, so its session is known by where it
  // worked instead: the pull request's own branch.
  const emails = report.commit_emails ?? [];
  // A session without a git email is its uploader's. (Nothing is bound for a
  // condition that is left out: a parameter no statement uses is refused.)
  let by = "";
  if (emails.length || report.nobody) {
    const people = emails.length ? `${SESSION_EMAIL} IN (${list(emails)})` : "FALSE";
    const onBranch = report.head_ref ? ` OR (runtime = 'cloud' AND branch = $${params.push(report.head_ref)})` : "";
    by = `AND (${people}${onBranch})`;
  }
  const rows = await db.query(
    `SELECT machine_id, source, session_id, primary_model, started_at, payload->'lines' AS lines
     FROM sessions
     WHERE org_id = $2 AND repo IN (${list(names)}) AND payload->'lines' IS NOT NULL
       AND (started_at IS NULL OR started_at >= $1::timestamptz) ${by}`,
    params,
  );
  return rows.flatMap((row) =>
    (json<{ path?: string; model?: string | null; hashes?: string[] }[]>(row.lines) ?? []).map((lines) => ({
      tool: String(row.source),
      model: lines.model ?? (row.primary_model as string | null) ?? null,
      path: lines.path ?? "",
      hashes: lines.hashes ?? [],
      started: row.started_at == null ? 0 : new Date(row.started_at as string).getTime(),
      session: { machine_id: String(row.machine_id), source: String(row.source), session_id: String(row.session_id) },
    })),
  );
}

/**
 * Which lines of a pull request agents wrote, going by the sessions held
 * now: the figures, and the page's files and sessions. `first` and `now` are
 * its lines as first reported and as last.
 */
async function match(
  db: OrgDb,
  about: Matched,
  first: FileHashes[],
  now: FileHashes[],
  firstEvent: string,
): Promise<{ attribution: PullAttribution; detail: ReturnType<typeof breakdown> }> {
  const claims = await claimsFor(db, about);
  // Worked out once, for the figures and for the page: the two then agree.
  const lines = writers(now, claims);
  return {
    attribution: {
      ...attribute(first, now, claims, lines),
      from_open: firstEvent === "opened",
      cloud: await cloudOf(db, about),
    },
    detail: breakdown(now, lines),
  };
}

/** How many reports of one pull request are kept. The oldest past this are dropped. */
const HISTORY_KEPT = 50;

/** A session's key and its lines in a pull request, as a history row stores them. */
interface ReportSession {
  machine_id: string;
  source: string;
  session_id: string;
  lines: number;
}

/** The figures a history row is compared by. The version is kept, and is not one of them. */
interface HistoryFigures {
  commits: number;
  lines: number;
  agent_lines: number;
  sessions: ReportSession[];
  reporter_version: string | null;
}

const sessionKey = (s: Pick<ReportSession, "machine_id" | "source" | "session_id">): string =>
  `${s.machine_id}\n${s.source}\n${s.session_id}`;

function sessionsOf(value: unknown): ReportSession[] {
  const list = json<unknown>(value);
  if (!Array.isArray(list)) return [];
  const sessions: ReportSession[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.machine_id !== "string" || typeof s.source !== "string" || typeof s.session_id !== "string") continue;
    sessions.push({ machine_id: s.machine_id, source: s.source, session_id: s.session_id, lines: num(s.lines) });
  }
  return sessions;
}

const sessionSignature = (sessions: ReportSession[]): string =>
  sessions.map((s) => `${sessionKey(s)}\n${s.lines}`).sort().join("\n");

const picked = (s: ReportSession): ReportSession => ({
  machine_id: s.machine_id,
  source: s.source,
  session_id: s.session_id,
  lines: s.lines,
});

/** Whether `version` is a newer Action than `before`. One that cannot be read is not. */
function newerAction(before: string | null, version: string | null): boolean {
  if (!version || !actionNumbers(version)) return false;
  return olderAction(before, version);
}

const signed = (n: number): string => `${n > 0 ? "+" : ""}${n}`;
const sessionsWord = (n: number): string => (n === 1 ? "1 session" : `${n} sessions`);

type RawSessionChange = ReportSession & { lines_before: number };

/** A change before each named session is joined to what is known of it now. */
interface RawChange {
  lines_before: number | null;
  agent_lines_before: number | null;
  commits_before: number | null;
  sessions_added: ReportSession[];
  sessions_gone: ReportSession[];
  sessions_changed: RawSessionChange[];
  reason: string | null;
}

/**
 * What changed between two reports, and the reason in words. New commits
 * first, then sessions that arrived, then sessions that are gone, then a
 * newer Action, and otherwise that it was matched again. With no earlier
 * report there is nothing to compare, and no reason.
 */
export function historyChange(now: HistoryFigures, before: HistoryFigures | null): RawChange {
  if (!before) {
    return {
      lines_before: null,
      agent_lines_before: null,
      commits_before: null,
      sessions_added: [],
      sessions_gone: [],
      sessions_changed: [],
      reason: null,
    };
  }
  const prev = new Map(before.sessions.map((s) => [sessionKey(s), s]));
  const next = new Map(now.sessions.map((s) => [sessionKey(s), s]));
  const added: ReportSession[] = [];
  const gone: ReportSession[] = [];
  const changed: RawSessionChange[] = [];
  for (const [key, s] of next) {
    const was = prev.get(key);
    if (!was) added.push(s);
    else if (was.lines !== s.lines) changed.push({ ...s, lines_before: was.lines });
  }
  for (const [key, s] of prev) {
    if (!next.has(key)) gone.push(s);
  }
  const byLines = (a: ReportSession, b: ReportSession) => b.lines - a.lines || a.session_id.localeCompare(b.session_id);
  added.sort(byLines);
  gone.sort(byLines);
  changed.sort(byLines);

  const commits = now.commits - before.commits;
  const delta = signed(now.agent_lines - before.agent_lines);
  let reason = "matched again, nothing new";
  if (commits > 0) reason = commits === 1 ? "1 new commit" : `${commits} new commits`;
  else if (added.length > 0) reason = `${sessionsWord(added.length)} uploaded since: ${delta} agent lines`;
  else if (gone.length > 0) reason = `${sessionsWord(gone.length)} no longer matched: ${delta} agent lines`;
  else if (newerAction(before.reporter_version, now.reporter_version)) reason = "a newer Action";

  return {
    lines_before: before.lines,
    agent_lines_before: before.agent_lines,
    commits_before: before.commits,
    sessions_added: added,
    sessions_gone: gone,
    sessions_changed: changed,
    reason,
  };
}

/**
 * Keep the figures of a report, in the same transaction as the pull request.
 * A row is written only when the lines, the agent lines, the commits or the
 * set of sessions and their line counts differ from the latest one, and only
 * the latest `HISTORY_KEPT` stay. A newer Action on a report that moves
 * nothing else is written onto the latest row, so the next change is not
 * explained by a version that was already current.
 */
async function recordReport(
  db: OrgDb,
  report: HistoryFigures & { repo: string; number: number; event: string },
): Promise<void> {
  const [latest] = await db.query<{
    id: unknown;
    commits: unknown;
    lines: unknown;
    agent_lines: unknown;
    sessions: unknown;
    reporter_version: unknown;
  }>(
    `SELECT id, commits, lines, agent_lines, sessions, reporter_version
     FROM pull_request_reports
     WHERE org_id = $1 AND repo = $2 AND number = $3
     ORDER BY at DESC, id DESC
     LIMIT 1`,
    [db.orgId, report.repo, report.number],
  );
  const version = latest && typeof latest.reporter_version === "string" ? latest.reporter_version : null;
  const same =
    latest != null &&
    num(latest.commits) === report.commits &&
    num(latest.lines) === report.lines &&
    num(latest.agent_lines) === report.agent_lines &&
    sessionSignature(sessionsOf(latest.sessions)) === sessionSignature(report.sessions);
  if (same && latest) {
    if (newerAction(version, report.reporter_version)) {
      await db.query(`UPDATE pull_request_reports SET reporter_version = $2 WHERE id = $1`, [latest.id, report.reporter_version]);
    }
    return;
  }
  await db.query(
    `INSERT INTO pull_request_reports
       (org_id, repo, number, event, commits, lines, agent_lines, sessions, reporter_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      db.orgId,
      report.repo,
      report.number,
      report.event,
      report.commits,
      report.lines,
      report.agent_lines,
      JSON.stringify(report.sessions.map(picked)),
      report.reporter_version,
    ],
  );
  await db.query(
    `DELETE FROM pull_request_reports
     WHERE org_id = $1 AND repo = $2 AND number = $3
       AND id NOT IN (
         SELECT id FROM pull_request_reports
         WHERE org_id = $1 AND repo = $2 AND number = $3
         ORDER BY at DESC, id DESC
         LIMIT ${HISTORY_KEPT}
       )`,
    [db.orgId, report.repo, report.number],
  );
}

/**
 * Store a report, replacing the last one for the pull request, and work out
 * which of its lines agents wrote. The lines of the first report are kept
 * for good: they are what review started from.
 */
export async function storePull(db: OrgDb, report: PullReport, key?: string): Promise<PullAttribution> {
  // Held until the history is written, so a rematch of the same pull request
  // waits and the two do not each keep the figures from before the other.
  const [existing] = await db.query<{ first_files: unknown; first_event: string }>(
    `SELECT first_files, first_event FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
    [db.orgId, report.repo, report.number],
  );
  const first = existing ? json<FileHashes[]>(existing.first_files) : report.files;
  const { attribution, detail } = await match(db, report, first, report.files, existing?.first_event ?? report.event);
  const columns: Record<string, unknown> = {
    org_id: db.orgId,
    repo: report.repo,
    number: report.number,
    head_repo: report.head_repo,
    title: report.title,
    url: report.url,
    author: report.author,
    state: report.state,
    draft: report.draft,
    head_ref: report.head_ref,
    base_ref: report.base_ref,
    created_at: report.created_at,
    merged_at: report.merged_at,
    closed_at: report.closed_at,
    last_event: report.event,
    commits: report.commits,
    reviews: report.reviews,
    changes_requested: report.changes_requested,
    review_comments: report.review_comments,
    bot_review_comments: report.bot_review_comments,
    review_rounds: report.review_rounds,
    files_without_diff: report.files_without_diff,
    last_files: JSON.stringify(report.files),
    attribution: JSON.stringify(attribution),
    detail: JSON.stringify(detail),
    // Kept to match its lines again later, when more sessions are held.
    committers: JSON.stringify((report.commit_emails ?? []).map((email) => committer(db.orgId, email, key))),
    aliases: JSON.stringify(report.aliases ?? []),
    // An Action from before these were sent says nothing of them: what is here stays.
    feedback: report.feedback ? JSON.stringify(report.feedback) : null,
    feedback_total: report.feedback ? (report.feedback_total ?? report.feedback.length) : null,
    // Who sent this report. Null, never '', when it named no one: '' is only
    // the mark on rows stored before a report said who sent it, and those are
    // not judged. The version is the Action's, and only then. A missing name
    // still counts as an older Action, so it replaces a version that was stored.
    reporter_name: report.reporter?.name || null,
    reporter_version: report.reporter?.name === ACTION_REPORTER ? (report.reporter.version ?? null) : null,
    // only used when the row is new
    first_event: report.event,
    first_files: JSON.stringify(first),
  };
  const names = Object.keys(columns);
  const casts: Record<string, string> = {
    last_files: "::jsonb",
    first_files: "::jsonb",
    attribution: "::jsonb",
    detail: "::jsonb",
    feedback: "::jsonb",
    committers: "::jsonb",
    aliases: "::jsonb",
  };
  const kept = ["org_id", "repo", "number", "first_event", "first_files"];
  // Reviews and comments, and how many there are, stay as they are when a report has none.
  const set = (name: string) =>
    name === "feedback" || name === "feedback_total"
      ? `CASE WHEN EXCLUDED.feedback IS NULL THEN pull_requests.${name} ELSE EXCLUDED.${name} END`
      : `EXCLUDED.${name}`;
  await db.query(
    `INSERT INTO pull_requests (${names.join(", ")})
     VALUES (${names.map((name, i) => `$${i + 1}${casts[name] ?? ""}`).join(", ")})
     ON CONFLICT (org_id, repo, number) DO UPDATE SET
       ${names
         .filter((name) => !kept.includes(name))
         .map((name) => `${name} = ${set(name)}`)
         .join(", ")},
       updated_at = clock_timestamp(), matched_at = clock_timestamp()`,
    Object.values(columns),
  );
  await recordReport(db, {
    repo: report.repo,
    number: report.number,
    event: report.event,
    commits: report.commits,
    lines: attribution.now.lines,
    agent_lines: attribution.now.agent_lines,
    sessions: detail.sessions.map(picked),
    reporter_version: typeof columns.reporter_version === "string" ? columns.reporter_version : null,
  });
  return attribution;
}

/**
 * Match a pull request's lines again, as last reported, against the sessions
 * held now: one uploaded after the last report then counts. Nothing else
 * about the pull request changes. Null if there is none under that number;
 * `needs_report` for one last reported before what it is matched by was
 * kept, or kept with another key, which only a new report from the Action
 * brings.
 */
export async function rematchPull(
  db: OrgDb,
  repo: string,
  number: number,
  key?: string,
): Promise<PullMatch | "needs_report" | null> {
  // The row is held until this is stored, so that a report arriving meanwhile
  // waits, and its files are not left beside figures made from the ones before.
  const [r] = await db.query(
    `SELECT head_repo, head_ref, created_at, first_event, first_files, last_files, committers, aliases,
            commits, reporter_version
     FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
    [db.orgId, repo, number],
  );
  if (!r) return null;
  if (r.committers == null) return "needs_report";
  const kept = json<string[]>(r.committers);
  if (!keptWith(kept, key)) {
    // The key is another now: these say nothing any more, and the page should say so.
    await db.query(`UPDATE pull_requests SET committers = NULL WHERE org_id = $1 AND repo = $2 AND number = $3`, [db.orgId, repo, number]);
    return "needs_report";
  }
  const names = { repo, head_repo: (r.head_repo as string) ?? null, aliases: json<string[]>(r.aliases) ?? [] };
  const { emails, nobody } = await committersAmong(db, repoNames(names), kept, key);
  const about: Matched = {
    ...names,
    head_ref: (r.head_ref as string) ?? null,
    commit_emails: emails,
    nobody,
    // A pull request is not stored without it.
    created_at: iso(r.created_at) ?? new Date().toISOString(),
  };
  const { attribution, detail } = await match(
    db,
    about,
    json<FileHashes[]>(r.first_files),
    json<FileHashes[]>(r.last_files),
    String(r.first_event),
  );
  const [stored] = await db.query<{ matched_at: unknown }>(
    `UPDATE pull_requests SET attribution = $4::jsonb, detail = $5::jsonb, matched_at = clock_timestamp()
     WHERE org_id = $1 AND repo = $2 AND number = $3 RETURNING matched_at`,
    [db.orgId, repo, number, JSON.stringify(attribution), JSON.stringify(detail)],
  );
  await recordReport(db, {
    repo,
    number,
    event: "match",
    commits: num(r.commits),
    lines: attribution.now.lines,
    agent_lines: attribution.now.agent_lines,
    sessions: detail.sessions.map(picked),
    reporter_version: typeof r.reporter_version === "string" ? r.reporter_version : null,
  });
  return { attribution, matched_at: iso(stored?.matched_at) ?? new Date().toISOString() };
}

/** No more than this many pull requests are matched again in one request. */
export const MATCH_AT_ONCE = 100;
/** Nor for longer than this, in milliseconds: whoever asks is answered before a proxy gives up on it. */
const MATCH_FOR = 10_000;

/**
 * Match again the pull requests the filters choose, those matched longest
 * ago first, `MATCH_AT_ONCE` at most: `remaining` are the ones still as they
 * were before `started`, for the next request with the same `started`. The
 * first request has none and is given the time it is now.
 *
 * `each` runs its function in a transaction of its own. Every pull request
 * has one: its row is held no longer than it takes to match it, so a report
 * of it that arrives meanwhile waits for that only, and one that cannot be
 * matched takes none of the others back with it.
 */
export async function rematchPulls(
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  filters: PullFilters,
  since?: string,
  key?: string,
  log: (err: unknown) => void = () => {},
): Promise<PullMatches> {
  const began = Date.now();
  const due = (sql: string, params: unknown[]) =>
    `${sql} AND committers IS NOT NULL AND (matched_at IS NULL OR matched_at < $${params.length + 1}::timestamptz)`;
  const { started, rows } = await each(async (db) => {
    const { sql, params } = where(db.orgId, filters);
    // By the database's clock, which is the one `matched_at` is written with.
    // A time given that is still to come is taken as now: nothing would ever
    // be matched after it, and the requests would not end.
    const [clock] = await db.query<{ t: unknown }>(`SELECT clock_timestamp() AS t`);
    const now = iso(clock?.t) ?? new Date().toISOString();
    const started = since && since < now ? since : now;
    const rows = await db.query<{ repo: string; number: unknown }>(
      `SELECT repo, number FROM pull_requests ${due(sql, params)}
       ORDER BY matched_at NULLS FIRST, repo, number LIMIT ${MATCH_AT_ONCE}`,
      [...params, started],
    );
    return { started, rows };
  });
  let matched = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() - began > MATCH_FOR) break;
    try {
      // One kept with another key is left for a report, and counts as that below.
      if ((await each((db) => rematchPull(db, String(row.repo), num(row.number), key))) !== "needs_report") matched += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  return each(async (db) => {
    const { sql, params } = where(db.orgId, filters);
    const [left] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_requests ${due(sql, params)}`, [...params, started]);
    const [waiting] = await db.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM pull_requests ${sql} AND committers IS NULL`,
      params,
    );
    return { matched, failed, remaining: num(left?.n), needs_report: num(waiting?.n), started };
  });
}

export interface PullFilters {
  /** Substring of the repository. */
  repo?: string;
  state?: string;
  /** Merged, closed or (if still open) created at or after this. */
  since?: string;
}

function where(orgId: string, filters: PullFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;
  const conditions: string[] = [`org_id = ${bind(orgId)}`];
  if (filters.repo) conditions.push(`repo ILIKE ${bind(`%${filters.repo.replace(/[\\%_]/g, "\\$&")}%`)}`);
  if (filters.state) conditions.push(`state = ${bind(filters.state)}`);
  if (filters.since) conditions.push(`coalesce(merged_at, closed_at, created_at) >= ${bind(filters.since)}::timestamptz`);
  return { sql: `WHERE ${conditions.join(" AND ")}`, params };
}

const ROW_COLUMNS = `repo, number, title, url, author, state, created_at, merged_at, first_event, commits,
  reviews, changes_requested, review_comments, bot_review_comments, review_rounds, files_without_diff,
  attribution, updated_at, matched_at, committers IS NOT NULL AS matchable, reporter_name, reporter_version`;

function pullRow(r: Record<string, unknown>): PullRow {
  const reporterName = typeof r.reporter_name === "string" ? r.reporter_name : null;
  const reporterVersion = typeof r.reporter_version === "string" ? r.reporter_version : null;
  return {
    repo: String(r.repo),
    number: num(r.number),
    title: (r.title as string) ?? null,
    url: (r.url as string) ?? null,
    author: String(r.author),
    state: r.state as PullRow["state"],
    created_at: iso(r.created_at),
    merged_at: iso(r.merged_at),
    first_event: String(r.first_event),
    commits: num(r.commits),
    reviews: num(r.reviews),
    changes_requested: num(r.changes_requested),
    review_comments: num(r.review_comments),
    bot_review_comments: num(r.bot_review_comments),
    review_rounds: num(r.review_rounds),
    files_without_diff: num(r.files_without_diff),
    attribution: json<PullAttribution>(r.attribution),
    updated_at: iso(r.updated_at) ?? "",
    matched_at: iso(r.matched_at),
    matchable: r.matchable === true,
    reporter_version: reporterVersion,
    reporter_older: reportIsOlder(reporterName, reporterVersion),
  };
}

/**
 * One pull request: its figures, its files, the sessions that wrote its
 * lines, and its reviews and comments. Null if none was reported under that
 * number.
 */
export async function getPull(db: OrgDb, repo: string, number: number): Promise<PullDetail | null> {
  const [r] = await db.query(
    `SELECT ${ROW_COLUMNS}, draft, head_ref, base_ref, closed_at, detail, feedback, feedback_total
     FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3`,
    [db.orgId, repo, number],
  );
  if (!r) return null;
  const detail = r.detail == null ? null : json<{ files: PullFile[]; sessions: Omit<PullSession, "session">[] }>(r.detail);
  const [reporter, sessions, history] = await Promise.all([
    repoReporters(db, [repo]).then((found) => found.get(repo)),
    detail ? withSessions(db, detail.sessions ?? []) : Promise.resolve(null),
    pullHistory(db, repo, number),
  ]);
  return {
    ...pullRow(r),
    reporter_current: CURRENT_ACTION,
    repo_reporter_older: reporter?.older ?? false,
    repo_reporter_version: reporter?.version ?? null,
    draft: r.draft === true,
    head_ref: (r.head_ref as string) ?? null,
    base_ref: (r.base_ref as string) ?? null,
    closed_at: iso(r.closed_at),
    files: detail?.files ?? null,
    sessions,
    feedback: r.feedback == null ? null : json<PullFeedback[]>(r.feedback),
    feedback_total: r.feedback == null || r.feedback_total == null ? null : num(r.feedback_total),
    history,
  };
}

/** The pull request's history, newest first, each with what changed against the one before it. */
async function pullHistory(db: OrgDb, repo: string, number: number): Promise<PullHistory[]> {
  const rows = await db.query(
    `SELECT at, event, commits, lines, agent_lines, sessions, reporter_version
     FROM pull_request_reports
     WHERE org_id = $1 AND repo = $2 AND number = $3
     ORDER BY at DESC, id DESC`,
    [db.orgId, repo, number],
  );
  const snaps: (HistoryFigures & { at: string; event: string })[] = rows.map((row) => ({
    at: iso(row.at) ?? "",
    event: String(row.event),
    commits: num(row.commits),
    lines: num(row.lines),
    agent_lines: num(row.agent_lines),
    sessions: sessionsOf(row.sessions),
    reporter_version: typeof row.reporter_version === "string" ? row.reporter_version : null,
  }));
  const changes = snaps.map((snap, i) => historyChange(snap, snaps[i + 1] ?? null));
  const named = changes.flatMap((change) => [...change.sessions_added, ...change.sessions_gone, ...change.sessions_changed]);
  const known = new Map((await withSessions(db, named)).map((s) => [sessionKey(s), s.session]));
  const name = (s: ReportSession): PullHistoryNamedSession => ({ ...s, session: known.get(sessionKey(s)) ?? null });
  return snaps.map((snap, i) => {
    const change = changes[i]!;
    return {
      at: snap.at,
      event: snap.event,
      commits: snap.commits,
      lines: snap.lines,
      agent_lines: snap.agent_lines,
      sessions: snap.sessions,
      reporter_version: snap.reporter_version,
      change: {
        lines_before: change.lines_before,
        agent_lines_before: change.agent_lines_before,
        commits_before: change.commits_before,
        sessions_added: change.sessions_added.map(name),
        sessions_gone: change.sessions_gone.map(name),
        sessions_changed: change.sessions_changed.map((s) => ({ ...name(s), lines_before: s.lines_before })),
        reason: change.reason,
      },
    };
  });
}

/** What is known now of the sessions a pull request's lines came from. */
async function withSessions(db: OrgDb, wrote: Omit<PullSession, "session">[]): Promise<PullSession[]> {
  if (wrote.length === 0) return [];
  const params: unknown[] = [db.orgId];
  const keys = wrote
    .map((s) => `($${params.push(s.machine_id)}::text, $${params.push(s.source)}::text, $${params.push(s.session_id)}::text)`)
    .join(", ");
  const rows = await db.query(
    `SELECT machine_id, source, session_id, owner_email, runtime, title, started_at, active_ms, cost_usd,
            cost_source, primary_model, prompts
     FROM sessions WHERE org_id = $1 AND (machine_id, source, session_id) IN (${keys})`,
    params,
  );
  const key = (s: { machine_id: unknown; source: unknown; session_id: unknown }) => `${s.machine_id}\n${s.source}\n${s.session_id}`;
  const found = new Map(rows.map((row) => [key(row as never), row]));
  return wrote.map((s) => {
    const row = found.get(key(s));
    return {
      ...s,
      session: row
        ? {
            owner_email: String(row.owner_email),
            runtime: (row.runtime as string) ?? null,
            title: (row.title as string) ?? null,
            started_at: iso(row.started_at),
            active_ms: num(row.active_ms),
            cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
            cost_source: (row.cost_source as string) ?? null,
            primary_model: (row.primary_model as string) ?? null,
            prompts: num(row.prompts),
          }
        : null,
    };
  });
}

/** Pull requests, most recently created first. */
export async function listPulls(
  db: OrgDb,
  filters: PullFilters,
  page: { limit: number; offset: number },
): Promise<PullList> {
  const { sql, params } = where(db.orgId, filters);
  const rows = await db.query(
    `SELECT ${ROW_COLUMNS} FROM pull_requests ${sql}
     ORDER BY created_at DESC NULLS LAST, repo, number DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
  const [count] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_requests ${sql}`, params);
  return { pulls: rows.map(pullRow), total: num(count?.n) };
}

/** How each agent and model's lines fared in review, over the matching pull requests. */
export async function summarizePulls(db: OrgDb, filters: PullFilters): Promise<PullSummary> {
  const { sql, params } = where(db.orgId, filters);
  const rows = (await db.query(`SELECT ${ROW_COLUMNS} FROM pull_requests ${sql}`, params)).map(pullRow);
  const byModel = new Map<string, PullsByModel>();
  const total = {
    pulls: rows.length,
    pulls_with_agent_lines: 0,
    lines: 0,
    agent_lines: 0,
    pulls_from_open: 0,
    opened_agent_lines: 0,
    agent_lines_surviving: 0,
    cloud_pulls: 0,
    cloud_pulls_without_session: 0,
  };
  const rowFor = (by: LinesBy) =>
    tally(byModel, by, () => ({
      tool: by.tool,
      model: by.model,
      pulls: 0,
      lines: 0,
      opened_lines: 0,
      surviving: 0,
      review_rounds: 0,
      changes_requested: 0,
      review_comments: 0,
      bot_review_comments: 0,
    }));
  for (const pull of rows) {
    const a = pull.attribution;
    total.lines += a.now.lines;
    total.agent_lines += a.now.agent_lines;
    if (a.now.agent_lines > 0) total.pulls_with_agent_lines += 1;
    if (a.cloud) {
      total.cloud_pulls += 1;
      if (a.cloud.sessions === 0) total.cloud_pulls_without_session += 1;
    }
    for (const by of a.now.by) {
      const row = rowFor(by);
      row.pulls += 1;
      row.lines += by.lines;
      row.review_rounds += pull.review_rounds;
      row.changes_requested += pull.changes_requested;
      row.review_comments += pull.review_comments;
      row.bot_review_comments += pull.bot_review_comments;
    }
    // What review changed can only be said of a pull request seen from the start.
    if (pull.first_event !== "opened") continue;
    total.pulls_from_open += 1;
    for (const by of a.by) {
      total.opened_agent_lines += by.lines;
      total.agent_lines_surviving += by.surviving;
      const row = rowFor(by);
      row.opened_lines += by.lines;
      row.surviving += by.surviving;
    }
  }
  // Which repositories the filter contains. Each is judged by its most
  // recent report from the Action, or that named no one, and by the last
  // ACTION_WINDOW_DAYS days of those reports.
  const reporters = await repoReporters(db, [...new Set(rows.map((pull) => pull.repo))]);
  const older = [...reporters].filter(([, one]) => one.older).map(([repo]) => repo);
  return { by_model: sorted(byModel), older_actions: older.sort(), total };
}
