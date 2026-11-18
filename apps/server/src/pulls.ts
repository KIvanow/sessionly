// Pull requests reported by the GitHub Action, and which of their lines
// agents wrote. A pull request's added lines arrive as hashes; sessions
// uploaded with line hashes say which lines an agent added to which file.
// Matching the two needs no source code on the server.
import type {
  FileHashes,
  LinesBy,
  PullAttribution,
  PullCost,
  PullCloud,
  PullDetail,
  PullFeedback,
  PullFile,
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
 * are still in it. `lines` are the writers of `now`, and `firstWriters`
 * those of `first`, where they were worked out already.
 */
export function attribute(
  first: FileHashes[],
  now: FileHashes[],
  claims: Claim[],
  lines: (Writer | null)[][] = writers(now, claims),
  firstWriters: (Writer | null)[][] = writers(first, claims),
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

/** A session as a pull request's lines name it. */
const sessionKey = (s: { machine_id: unknown; source: unknown; session_id: unknown }): string =>
  `${s.machine_id}\n${s.source}\n${s.session_id}`;

/** A session's lines in a pull request: the hashes, by file, as often as they are there. */
type Lines = Record<string, string[]>;

/** A session with lines in a pull request, as the pull request keeps it: which one, how many, and which. */
type Wrote = Pick<PullSession, "machine_id" | "source" | "session_id" | "lines"> & { matched: Lines };

/** And which of the lines the pull request was first reported with are its own. */
type Kept = Wrote & { opened_lines: number; opened_matched: Lines };

/**
 * A pull request's lines as they are now, file by file and session by
 * session: where its agent lines are, and which sessions they came from.
 * `lines` are its writers, the same ones `attribute` counts.
 */
export function breakdown(now: FileHashes[], lines: (Writer | null)[][]): { files: PullFile[]; sessions: Wrote[] } {
  // By file in a map: a file may be called `constructor`, which every object has already.
  const sessions = new Map<string, Omit<Wrote, "matched"> & { matched: Map<string, string[]> }>();
  const files = now.map((file, i) => {
    let agent = 0;
    lines[i]!.forEach((line, at) => {
      if (!line) return;
      agent += 1;
      const from = line.session;
      if (!from) return;
      const key = sessionKey(from);
      if (!sessions.has(key)) sessions.set(key, { ...from, lines: 0, matched: new Map() });
      const row = sessions.get(key)!;
      row.lines += 1;
      if (!row.matched.has(file.path)) row.matched.set(file.path, []);
      row.matched.get(file.path)!.push(file.hashes[at]!);
    });
    return { path: file.path, lines: file.hashes.length, agent_lines: agent };
  });
  return {
    files: files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
    sessions: [...sessions.values()]
      .map((row) => ({ ...row, matched: Object.fromEntries(row.matched) }))
      .sort((a, b) => b.lines - a.lines || a.session_id.localeCompare(b.session_id)),
  };
}

/**
 * How many lines a session's lines in each of its pull requests count as,
 * for splitting what it cost. A line that is in several (one stacked on
 * another, a release of what was merged before) is shared out between
 * them, so that together they count it once. A pull request closed without
 * merging takes nothing from the others: its lines are shared out as if it
 * counted, and those of the others as if it were not there. One whose lines
 * were not kept (`matched` null) counts all of them.
 */
export function weigh(rows: { live: boolean; lines: number; matched: Lines | null }[]): number[] {
  const counted = rows.map((row) => {
    if (!row.matched) return null;
    const counts = new Map<string, number>();
    for (const [path, hashes] of Object.entries(row.matched)) {
      for (const hash of hashes) counts.set(`${path}\n${hash}`, (counts.get(`${path}\n${hash}`) ?? 0) + 1);
    }
    return counts;
  });
  // For each line: how often it is there in all of them together, and in the one that has it most.
  const among = (which: (row: { live: boolean }) => boolean) => {
    const all = new Map<string, { sum: number; most: number }>();
    counted.forEach((counts, i) => {
      if (!counts || !which(rows[i]!)) return;
      for (const [line, n] of counts) {
        const one = all.get(line) ?? { sum: 0, most: 0 };
        all.set(line, { sum: one.sum + n, most: Math.max(one.most, n) });
      }
    });
    return all;
  };
  const live = among((row) => row.live);
  const every = among(() => true);
  return rows.map((row, i) => {
    const counts = counted[i];
    if (!counts) return row.lines;
    const all = row.live ? live : every;
    let weight = 0;
    for (const [line, n] of counts) weight += (n * all.get(line)!.most) / all.get(line)!.sum;
    return weight;
  });
}

const FEEDBACK_KINDS = ["review", "inline", "conversation"];
const REVIEW_STATES = ["approved", "changes_requested", "commented", "dismissed"];

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
): Promise<{ attribution: PullAttribution; files: PullFile[]; sessions: Kept[] }> {
  const claims = await claimsFor(db, about);
  // Worked out once, for the figures and for the page: the two then agree.
  const lines = writers(now, claims);
  const firstLines = writers(first, claims);
  const { files, sessions: wrote } = breakdown(now, lines);
  // The sessions it was opened with, beside the ones it has now: one whose lines all went in review is kept by them.
  const opened = new Map(breakdown(first, firstLines).sessions.map((s) => [sessionKey(s), s]));
  const sessions: Kept[] = wrote.map((s) => {
    const then = opened.get(sessionKey(s));
    return { ...s, opened_lines: then?.lines ?? 0, opened_matched: then?.matched ?? {} };
  });
  const there = new Set(wrote.map(sessionKey));
  for (const [key, s] of opened) {
    if (!there.has(key)) sessions.push({ machine_id: s.machine_id, source: s.source, session_id: s.session_id, lines: 0, matched: {}, opened_lines: s.lines, opened_matched: s.matched });
  }
  return {
    attribution: {
      ...attribute(first, now, claims, lines, firstLines),
      from_open: firstEvent === "opened",
      cloud: await cloudOf(db, about),
    },
    files,
    sessions,
  };
}

/**
 * Store a report, replacing the last one for the pull request, and work out
 * which of its lines agents wrote. The lines of the first report are kept
 * for good: they are what review started from.
 */
export async function storePull(db: OrgDb, report: PullReport, key?: string): Promise<PullAttribution> {
  // One report of a pull request at a time, its first too, when there is no
  // row yet to hold: the later one then sees what the earlier left, the state
  // and the lines it was first reported with.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessionly-pull:${db.orgId}:${report.repo}#${report.number}`]);
  const [existing] = await db.query<{ first_files: unknown; first_event: string; state: string }>(
    `SELECT first_files, first_event, state FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
    [db.orgId, report.repo, report.number],
  );
  const first = existing ? json<FileHashes[]>(existing.first_files) : report.files;
  const { attribution, files, sessions } = await match(db, report, first, report.files, existing?.first_event ?? report.event);
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
    detail: JSON.stringify({ files }),
    // Kept to match its lines again later, when more sessions are held.
    committers: JSON.stringify((report.commit_emails ?? []).map((email) => committer(db.orgId, email, key))),
    aliases: JSON.stringify(report.aliases ?? []),
    // An Action from before these were sent says nothing of them: what is here stays.
    feedback: report.feedback ? JSON.stringify(report.feedback) : null,
    feedback_total: report.feedback ? (report.feedback_total ?? report.feedback.length) : null,
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
  // Closing without merging, or opening again, changes what its lines take from other pull requests.
  const turned = existing != null && (existing.state === "closed") !== (report.state === "closed");
  await keepSessions(db, report.repo, report.number, sessions, turned);
  return attribution;
}

/**
 * Held until the transaction ends by whoever writes which lines of which
 * sessions a pull request has, one at a time in an organisation: two reports
 * that share a session would each miss the other's lines, and a report and
 * the deleting of a session would each miss the other.
 */
export async function holdPullSessions(db: OrgDb): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessionly-pull-sessions:${db.orgId}`]);
}

/**
 * The sessions with lines in a pull request, in place of the ones before.
 * What their lines count as is worked out again in every pull request those
 * sessions, and the ones before, have lines in: a line now in two is shared.
 */
async function keepSessions(db: OrgDb, repo: string, number: number, sessions: Kept[], turned: boolean): Promise<void> {
  // Most reports change none of this (a review, a comment, a push of other
  // lines): then nothing is written, and nobody waits. The pull request's
  // own row is held by whoever got here, so these are not changing under it.
  const had = await db.query(
    `SELECT machine_id, source, session_id, lines, opened_lines, matched, opened_matched FROM pull_sessions
     WHERE org_id = $1 AND repo = $2 AND number = $3`,
    [db.orgId, repo, number],
  );
  const files = (kept: unknown) => {
    const lines = kept == null ? null : json<Lines>(kept);
    return lines && Object.keys(lines).sort().map((path) => [path, lines[path]]);
  };
  const said = (s: { lines: unknown; opened_lines: unknown; matched: unknown; opened_matched: unknown }) =>
    JSON.stringify([s.lines == null ? null : num(s.lines), s.opened_lines == null ? null : num(s.opened_lines), files(s.matched), files(s.opened_matched)]);
  const was = new Map(had.map((row) => [sessionKey(row as never), said(row as never)]));
  if (!turned && was.size === sessions.length && sessions.every((s) => was.get(sessionKey(s)) === said(s))) return;
  await holdPullSessions(db);
  const before = await db.query(
    `DELETE FROM pull_sessions WHERE org_id = $1 AND repo = $2 AND number = $3 RETURNING machine_id, source, session_id`,
    [db.orgId, repo, number],
  );
  if (sessions.length > 0) {
    // Which lines are kept only of a session that is still here: one deleted
    // since its lines were matched, a moment ago, takes them with it.
    await db.query(
      `INSERT INTO pull_sessions
         (org_id, repo, number, machine_id, source, session_id, lines, weight, matched, opened_lines, opened_weight, opened_matched)
       SELECT $1, $2, $3, s.machine_id, s.source, s.session_id, s.lines, s.lines, CASE WHEN here.is THEN s.matched END,
              s.opened_lines, s.opened_lines, CASE WHEN here.is THEN s.opened_matched END
       FROM jsonb_to_recordset($4::jsonb)
         AS s(machine_id text, source text, session_id text, lines integer, matched jsonb, opened_lines integer, opened_matched jsonb),
       LATERAL (SELECT EXISTS (SELECT 1 FROM sessions x WHERE x.org_id = $1 AND x.machine_id = s.machine_id
                               AND x.source = s.source AND x.session_id = s.session_id) AS is) here`,
      [db.orgId, repo, number, JSON.stringify(sessions)],
    );
  }
  const touched = new Map([...before, ...sessions].map((s) => [sessionKey(s as never), { machine_id: s.machine_id, source: s.source, session_id: s.session_id }]));
  if (touched.size === 0) return;
  const rows = await db.query(
    `SELECT o.repo, o.number, o.machine_id, o.source, o.session_id, o.lines, o.weight, o.matched,
            o.opened_lines, o.opened_weight, o.opened_matched, r.state <> 'closed' AS live,
            r.first_event = 'opened' AS from_open
     FROM jsonb_to_recordset($2::jsonb) AS k(machine_id text, source text, session_id text)
     JOIN pull_sessions o ON o.org_id = $1 AND o.machine_id = k.machine_id AND o.source = k.source AND o.session_id = k.session_id
     JOIN pull_requests r ON r.org_id = o.org_id AND r.repo = o.repo AND r.number = o.number`,
    [db.orgId, JSON.stringify([...touched.values()])],
  );
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = sessionKey(row as never);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(row);
  }
  const lines = (kept: unknown) => (kept == null ? null : json<Lines>(kept));
  const same = (stored: unknown, now: number) => stored != null && Math.abs(num(stored) - now) < 1e-9;
  const changed: Record<string, unknown>[] = [];
  for (const its of bySession.values()) {
    const weights = weigh(its.map((row) => ({ live: row.live === true, lines: num(row.lines), matched: lines(row.matched) })));
    // The lines each was first reported with are shared out likewise: ones that
    // moved from one pull request to another were opened in both, and paid for once.
    // Only between those seen from the start: of another, what it was first
    // reported with says nothing, and it takes nothing from them.
    const fromOpen = its.filter((row) => row.from_open === true);
    const opened = new Map(
      weigh(fromOpen.map((row) => ({ live: row.live === true, lines: num(row.opened_lines), matched: lines(row.opened_matched) }))).map(
        (weight, i) => [fromOpen[i]!, weight],
      ),
    );
    its.forEach((row, i) => {
      // From before the lines it was opened with were counted: nothing to say of them.
      const then = row.opened_lines == null ? null : (opened.get(row) ?? num(row.opened_lines));
      if (same(row.weight, weights[i]!) && (then == null ? row.opened_weight == null : same(row.opened_weight, then))) return;
      changed.push({ repo: row.repo, number: row.number, machine_id: row.machine_id, source: row.source, session_id: row.session_id, weight: weights[i], opened_weight: then });
    });
  }
  if (changed.length === 0) return;
  await db.query(
    `UPDATE pull_sessions o SET weight = c.weight, opened_weight = c.opened_weight
     FROM jsonb_to_recordset($2::jsonb)
       AS c(repo text, number integer, machine_id text, source text, session_id text, weight double precision, opened_weight double precision)
     WHERE o.org_id = $1 AND o.repo = c.repo AND o.number = c.number AND o.machine_id = c.machine_id
       AND o.source = c.source AND o.session_id = c.session_id`,
    [db.orgId, JSON.stringify(changed)],
  );
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
    `SELECT head_repo, head_ref, created_at, first_event, first_files, last_files, committers, aliases
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
  const { attribution, files, sessions } = await match(
    db,
    about,
    json<FileHashes[]>(r.first_files),
    json<FileHashes[]>(r.last_files),
    String(r.first_event),
  );
  const [stored] = await db.query<{ matched_at: unknown }>(
    `UPDATE pull_requests SET attribution = $4::jsonb, detail = $5::jsonb, matched_at = clock_timestamp()
     WHERE org_id = $1 AND repo = $2 AND number = $3 RETURNING matched_at`,
    [db.orgId, repo, number, JSON.stringify(attribution), JSON.stringify({ files })],
  );
  await keepSessions(db, repo, number, sessions, false);
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

/** To a millionth of a dollar: sums of shares are then the same however they were added up. */
const money = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** A session with lines in a pull request, or that had some when it was first reported: what it cost there. */
interface Share {
  /** As the pull request's page has it. */
  wrote: PullSession;
  estimated: boolean;
  /** Its cost leaves requests out: what it cost here is then a floor. */
  partial: boolean;
  /** Of an `unshared` one: a pull request whose lines were not kept cannot be matched again, only reported again. */
  stuck: boolean;
  /** It has a cost, and what share of it is here is not known yet: its line hashes are still to be counted. */
  uncounted: boolean;
  /**
   * It has lines in several pull requests, and in one of them they were kept
   * before which lines they are was: the same ones, perhaps, counted in
   * each. What it cost in any of them is then no more than an estimate.
   */
  unshared: boolean;
  /**
   * How many of the lines the pull request was first reported with are its
   * own, and what those cost: null with no cost figure. `opened_known` is
   * false for one kept before those lines were counted.
   */
  opened_lines: number;
  opened_usd: number | null;
  opened_known: boolean;
}

const pullKey = (p: { repo: unknown; number: unknown }): string => `${p.repo}\n${p.number}`;

/**
 * What each session cost in each of the pull requests chosen: the session's
 * cost, in the proportion of what its lines there count as (see `weigh`) to
 * all the lines it uploaded hashes of. So a session is split between the
 * pull requests it wrote into and never counted more than once. Where it
 * has been uploaded since with fewer hashes than its lines in pull requests
 * count as, the proportion is to those. `chosen` is a query of the pull
 * requests' `repo` and `number`, whose first parameter is the organisation.
 * By pull request, each with its sessions, most lines first; one query
 * however many there are.
 */
async function sharesIn(db: OrgDb, chosen: { sql: string; params: unknown[] }, full = false): Promise<Map<string, Share[]>> {
  // What a pull request's page says of each session; a list or a sum has no use for it.
  const about = ["owner_email", "runtime", "title", "started_at", "active_ms", "primary_model", "prompts"]
    .map((column) => (full ? `s.${column}` : `NULL AS ${column}`))
    .join(", ");
  const rows = await db.query(
    `WITH mine AS (
       SELECT p.repo, p.number, p.machine_id, p.source, p.session_id, p.lines, p.weight, p.opened_lines, p.opened_weight,
              r.state = 'closed' AS closed
       FROM (${chosen.sql}) c
       JOIN pull_sessions p ON p.org_id = $1 AND p.repo = c.repo AND p.number = c.number
       JOIN pull_requests r ON r.org_id = p.org_id AND r.repo = p.repo AND r.number = p.number),
     totals AS (
       SELECT o.machine_id, o.source, o.session_id, count(*) AS pulls,
              sum(o.weight) FILTER (WHERE r.state <> 'closed') AS in_pulls,
              sum(o.weight) FILTER (WHERE r.state = 'closed') AS in_closed,
              bool_or(o.matched IS NULL) AS unkept,
              bool_or(o.matched IS NULL AND r.committers IS NULL) AS unkept_for_good,
              sum(coalesce(o.opened_weight, o.opened_lines, 0)) FILTER (WHERE r.state <> 'closed' AND r.first_event = 'opened') AS opened_in_pulls,
              sum(coalesce(o.opened_weight, o.opened_lines, 0)) FILTER (WHERE r.state = 'closed' AND r.first_event = 'opened') AS opened_in_closed
       FROM pull_sessions o JOIN pull_requests r ON r.org_id = o.org_id AND r.repo = o.repo AND r.number = o.number
       WHERE o.org_id = $1
         AND (o.machine_id, o.source, o.session_id) IN (SELECT machine_id, source, session_id FROM mine)
       GROUP BY o.machine_id, o.source, o.session_id)
     SELECT mine.*, t.pulls, t.unkept, t.unkept_for_good, t.in_pulls, t.in_closed, t.opened_in_pulls, t.opened_in_closed, s.session_id IS NOT NULL AS held,
            s.hashed_lines,
            s.cost_usd, s.cost_source, s.unpriced_requests, ${about}
     FROM mine
     LEFT JOIN totals t ON t.machine_id = mine.machine_id AND t.source = mine.source AND t.session_id = mine.session_id
     LEFT JOIN sessions s ON s.org_id = $1 AND s.machine_id = mine.machine_id AND s.source = mine.source
       AND s.session_id = mine.session_id
     ORDER BY mine.lines DESC, mine.session_id`,
    chosen.params,
  );
  const shares = new Map<string, Share[]>();
  for (const row of rows) {
    const held = row.held === true;
    const weight = num(row.weight);
    // One closed without merging is a share of what the closed ones have
    // between them, as the others are of theirs: neither is counted twice.
    const closed = row.closed === true;
    const among = Math.max(num(row.hashed_lines), num(closed ? row.in_closed : row.in_pulls), weight);
    const whole = held && row.cost_usd != null ? Number(row.cost_usd) : null;
    // From before its line hashes were counted, and not counted yet (the
    // server does that after it starts): what share its lines here are is
    // not known until then, and its payload is not opened to find out.
    const uncounted = held && row.hashed_lines == null;
    const cost = uncounted ? null : whole;
    const lines = num(row.lines);
    // The lines it was first reported with, shared likewise with the others that were opened with them.
    const opened = row.opened_weight == null ? num(row.opened_lines) : num(row.opened_weight);
    const amongOpened = Math.max(num(row.hashed_lines), num(closed ? row.opened_in_closed : row.opened_in_pulls), opened);
    const share: Share = {
      wrote: {
        machine_id: String(row.machine_id),
        source: String(row.source),
        session_id: String(row.session_id),
        lines,
        hashed_lines: held && !uncounted ? num(row.hashed_lines) : null,
        cost_share_usd: cost == null ? null : money(among > 0 ? (cost * weight) / among : 0),
        session: held
          ? {
              owner_email: String(row.owner_email),
              runtime: (row.runtime as string) ?? null,
              title: (row.title as string) ?? null,
              started_at: iso(row.started_at),
              active_ms: num(row.active_ms),
              cost_usd: whole,
              cost_source: (row.cost_source as string) ?? null,
              primary_model: (row.primary_model as string) ?? null,
              prompts: num(row.prompts),
            }
          : null,
      },
      estimated: row.cost_source !== "recorded",
      uncounted: uncounted && whole != null,
      unshared: held && row.unkept === true && num(row.pulls) > 1,
      stuck: row.unkept_for_good === true,
      partial: row.cost_source === "partial_estimate" || num(row.unpriced_requests) > 0,
      opened_lines: num(row.opened_lines),
      opened_usd: cost == null ? null : money(opened > 0 ? (cost * opened) / amongOpened : 0),
      opened_known: row.opened_lines != null,
    };
    const key = pullKey(row as never);
    if (!shares.has(key)) shares.set(key, []);
    shares.get(key)!.push(share);
  }
  return shares;
}

/** What a pull request's sessions cost it, from what is known of each now. */
function costOf(pull: Pick<PullRow, "attribution" | "first_event">, shares: Share[]): PullCost {
  let usd: number | null = null;
  let estimated = false;
  let sessions = 0;
  let without = 0;
  let partial = 0;
  let unshared = 0;
  let stuck = 0;
  let uncounted = 0;
  // The lines that cost is of: a session with no cost figure says nothing of what a line cost.
  let costed = 0;
  // What the lines it was first reported with cost, where every session says
  // how many were its own; a floor when one of those has no cost, or not all of it.
  let opened: number | null = null;
  let openedFloor = false;
  let openedEstimated = false;
  let openedKnown = true;
  for (const share of shares) {
    if (!share.opened_known) openedKnown = false;
    else if (share.opened_lines > 0) {
      if (share.opened_usd == null) openedFloor = true;
      else {
        opened = (opened ?? 0) + share.opened_usd;
        if (share.partial) openedFloor = true;
        if (share.estimated) openedEstimated = true;
      }
    }
    // One all of whose lines went in review is here for what it was opened with alone.
    const { lines, cost_share_usd: cost } = share.wrote;
    if (lines === 0) continue;
    sessions += 1;
    if (cost == null) {
      without += 1;
      if (share.uncounted) uncounted += 1;
      continue;
    }
    usd = (usd ?? 0) + cost;
    costed += lines;
    if (share.estimated) estimated = true;
    if (share.partial) partial += 1;
    if (share.unshared) unshared += 1;
    if (share.unshared && share.stuck) stuck += 1;
  }
  const a = pull.attribution;
  const each = usd != null && costed > 0 ? usd / costed : null;
  const surviving = a.by.reduce((sum, by) => sum + by.surviving, 0);
  // What review left can only be said of a pull request seen from the start,
  // and what it was opened with cost only of one whose sessions then were kept.
  if (!openedKnown || pull.first_event !== "opened" || a.first.agent_lines === 0) opened = null;
  return {
    usd: usd == null ? null : money(usd),
    // A share that may be counted in another pull request too is no more than an estimate.
    estimated: estimated || unshared > 0,
    sessions,
    sessions_without_cost: without,
    sessions_with_cost_partial: partial,
    sessions_unshared: unshared,
    sessions_unshared_for_good: stuck,
    sessions_uncounted: uncounted,
    per_agent_line_usd: each == null ? null : money(each),
    opened_usd: opened == null ? null : money(opened),
    opened_is_floor: opened != null && openedFloor,
    opened_estimated: opened != null && openedEstimated,
    per_surviving_line_usd: opened != null && surviving > 0 ? money(opened / surviving) : null,
  };
}

/** Rows as the list and the summary have them: each with what its sessions cost. */
async function costed(db: OrgDb, rows: Record<string, unknown>[], chosen: { sql: string; params: unknown[] }): Promise<PullRow[]> {
  const shares = rows.length > 0 ? await sharesIn(db, chosen) : new Map<string, Share[]>();
  return rows.map((r) => {
    const pull = pullRow(r);
    return { ...pull, cost: r.detailed === true ? costOf(pull, shares.get(pullKey(pull)) ?? []) : null };
  });
}

const ROW_COLUMNS = `repo, number, title, url, author, state, created_at, merged_at, first_event, commits,
  reviews, changes_requested, review_comments, bot_review_comments, review_rounds, files_without_diff,
  attribution, updated_at, matched_at, committers IS NOT NULL AS matchable`;

function pullRow(r: Record<string, unknown>): PullRow {
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
    cost: null,
    updated_at: iso(r.updated_at) ?? "",
    matched_at: iso(r.matched_at),
    matchable: r.matchable === true,
  };
}

/**
 * These three read in several statements what has to agree, the figures
 * and the sessions: the request they answer runs with a snapshot (see
 * `readsPulls` in app.ts).
 *
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
  const detail = r.detail == null ? null : json<{ files: PullFile[] }>(r.detail);
  const row = pullRow(r);
  const shares = detail
    ? ((await sharesIn(db, { sql: `SELECT $2::text AS repo, $3::integer AS number`, params: [db.orgId, repo, number] }, true)).get(pullKey(row)) ?? [])
    : null;
  return {
    ...row,
    cost: shares && costOf(row, shares),
    draft: r.draft === true,
    head_ref: (r.head_ref as string) ?? null,
    base_ref: (r.base_ref as string) ?? null,
    closed_at: iso(r.closed_at),
    files: detail?.files ?? null,
    sessions: shares && shares.filter((s) => s.wrote.lines > 0).map((s) => s.wrote),
    feedback: r.feedback == null ? null : json<PullFeedback[]>(r.feedback),
    feedback_total: r.feedback == null || r.feedback_total == null ? null : num(r.feedback_total),
  };
}

/** Pull requests, most recently created first. */
export async function listPulls(
  db: OrgDb,
  filters: PullFilters,
  page: { limit: number; offset: number },
): Promise<PullList> {
  const { sql, params } = where(db.orgId, filters);
  const rows = await db.query(
    `SELECT ${ROW_COLUMNS}, detail IS NOT NULL AS detailed FROM pull_requests ${sql}
     ORDER BY created_at DESC NULLS LAST, repo, number DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
  const [count] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_requests ${sql}`, params);
  const these = {
    sql: `SELECT repo, number FROM jsonb_to_recordset($2::jsonb) AS k(repo text, number integer)`,
    params: [db.orgId, JSON.stringify(rows.map((r) => ({ repo: r.repo, number: r.number })))],
  };
  return { pulls: await costed(db, rows, these), total: num(count?.n) };
}

/** How each agent and model's lines fared in review, over the matching pull requests. */
export async function summarizePulls(db: OrgDb, filters: PullFilters): Promise<PullSummary> {
  const { sql, params } = where(db.orgId, filters);
  const rows = await costed(
    db,
    await db.query(`SELECT ${ROW_COLUMNS}, detail IS NOT NULL AS detailed FROM pull_requests ${sql}`, params),
    { sql: `SELECT repo, number FROM pull_requests ${sql}`, params },
  );
  // Of the pull requests seen from the start that have a cost: what the agent
  // lines they were opened with cost, and how many of those survived review.
  const opened = { usd: 0, surviving: 0 };
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
    cost_usd: null as number | null,
    cost_estimated: false,
    pulls_with_cost_missing: 0,
    pulls_closed_with_cost: 0,
    per_surviving_line_usd: null as number | null,
    per_surviving_line_is_floor: false,
    per_surviving_line_estimated: false,
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
    // One closed without merging has a cost of its own that the others' lines
    // are not shared with: among them it would count a session twice. So it
    // is in no figure of cost here, unless only such are asked for.
    if (pull.state === "closed" && filters.state !== "closed") {
      if (pull.cost?.usd != null) total.pulls_closed_with_cost += 1;
    } else {
      if (pull.cost?.usd != null) {
        total.cost_usd = (total.cost_usd ?? 0) + pull.cost.usd;
        if (pull.cost.estimated) total.cost_estimated = true;
      }
      // A floor: a session of it has no cost figure, or its sessions were not kept.
      const floor = pull.cost ? pull.cost.sessions_without_cost + pull.cost.sessions_with_cost_partial > 0 : a.now.agent_lines > 0;
      if (floor) total.pulls_with_cost_missing += 1;
      // One where no line survived is in this too: what its lines cost was spent.
      if (pull.cost?.opened_usd != null) {
        opened.usd += pull.cost.opened_usd;
        opened.surviving += a.by.reduce((sum, by) => sum + by.surviving, 0);
        if (pull.cost.opened_is_floor) total.per_surviving_line_is_floor = true;
        if (pull.cost.opened_estimated) total.per_surviving_line_estimated = true;
      }
    }
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
  if (total.cost_usd != null) total.cost_usd = money(total.cost_usd);
  if (opened.surviving > 0) total.per_surviving_line_usd = money(opened.usd / opened.surviving);
  else total.per_surviving_line_is_floor = total.per_surviving_line_estimated = false;
  return { by_model: sorted(byModel), total };
}
