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
export const MAX_FILES = 5000;
const MAX_FEEDBACK = 2000;
export const HASH = /^[0-9a-f]{16}$/;

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
export const IN_WORKTREE = /^(?:.*\/)?\.?worktrees\/[^/]+\/(.+)$/;

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

/**
 * A line this many sessions or more added to the same file is a common one
 * (an import, `display: flex;`): that a session added it once says little.
 */
export const COMMON_LINE = 3;

/**
 * For each added line of each file, the agent that wrote it, or null. A
 * common line is put down only to a session that also added a line of the
 * pull request that is not (whether or not that line went to it), or every
 * line of a file of it: without that, it would go to whichever older session
 * last added it, while the one that wrote it has not been uploaded.
 */
export function writers(files: FileHashes[], claims: Claim[]): (Writer | null)[][] {
  // Looking only at claims on a file of the same name keeps this quick.
  // A claim that names no session is a session of its own.
  const byName = new Map<string, { claim: Claim; who: string }[]>();
  claims.forEach((claim, i) => {
    const name = claim.path.slice(claim.path.lastIndexOf("/") + 1);
    const who = claim.session ? `${claim.session.machine_id}\n${claim.session.source}\n${claim.session.session_id}` : `#${i}`;
    const list = byName.get(name);
    if (list) list.push({ claim, who });
    else byName.set(name, [{ claim, who }]);
  });
  const pools = files.map((file) => {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    // Per line, who added it: the session that started last comes first.
    const pool = new Map<string, { writer: Writer; who: string }[]>();
    const matching = (byName.get(name) ?? [])
      .filter(({ claim }) => samePath(claim.path, file.path))
      .sort((a, b) => b.claim.started - a.claim.started);
    for (const { claim, who } of matching) {
      for (const hash of claim.hashes) {
        const list = pool.get(hash);
        const added = { writer: { tool: claim.tool, model: claim.model, session: claim.session }, who };
        if (list) list.push(added);
        else pool.set(hash, [added]);
      }
    }
    // Only the pull request's own lines are asked about.
    const common = new Set<string>();
    for (const hash of new Set(file.hashes)) {
      const list = pool.get(hash);
      if (list && new Set(list.map((added) => added.who)).size >= COMMON_LINE) common.add(hash);
    }
    return { pool, common };
  });
  const shown = creditedWithCommon(files, pools);
  // Each line an agent added accounts for one line of the pull request, the
  // session that started last first; a common line only for a session shown.
  return files.map((file, i) => {
    const { pool, common } = pools[i]!;
    return file.hashes.map((hash) => {
      const list = pool.get(hash);
      if (!list) return null;
      const at = common.has(hash) ? list.findIndex((added) => shown.has(added.who)) : 0;
      return at < 0 || at >= list.length ? null : list.splice(at, 1)[0]!.writer;
    });
  });
}

/**
 * The sessions a common line can go to: those that added a line of the pull
 * request that is not common, and those that added every line of one of its
 * files, common or not (a file of nothing but imports is still the work of
 * whoever wrote it), as many times as the file has each.
 */
function creditedWithCommon(
  files: FileHashes[],
  pools: { pool: Map<string, { who: string }[]>; common: Set<string> }[],
): Set<string> {
  const shown = new Set<string>();
  files.forEach((file, i) => {
    const { pool, common } = pools[i]!;
    for (const hash of file.hashes) {
      if (!common.has(hash)) for (const added of pool.get(hash) ?? []) shown.add(added.who);
    }
    if (file.hashes.length === 0 || !file.hashes.every((hash) => common.has(hash))) return;
    // A line three times takes a session that added it three times.
    const needed = new Map<string, number>();
    for (const hash of file.hashes) needed.set(hash, (needed.get(hash) ?? 0) + 1);
    const times = (who: string, hash: string) => pool.get(hash)!.filter((added) => added.who === who).length;
    const [first] = needed.keys();
    for (const who of new Set(pool.get(first!)!.map((added) => added.who))) {
      if ([...needed].every(([line, count]) => times(who, line) >= count)) shown.add(who);
    }
  });
  return shown;
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

/** A line of a file, as the lines seen are keyed. */
const lineKey = (path: string, hash: string): string => `${path}\n${hash}`;

/** How often each line is in a pull request's files, first or now: as often as the one that has it most. */
function copiesIn(...reports: FileHashes[][]): Map<string, number> {
  const most = new Map<string, number>();
  for (const files of reports) {
    const here = new Map<string, number>();
    for (const file of files) for (const hash of file.hashes) here.set(lineKey(file.path, hash), (here.get(lineKey(file.path, hash)) ?? 0) + 1);
    for (const [key, n] of here) if (n > (most.get(key) ?? 0)) most.set(key, n);
  }
  return most;
}

/** Two sets of lines put together, a line in both as often as in the two. */
function addLines(a: Lines, b: Lines): Lines {
  // (A map: a file may be called `constructor`, which every object has already, or `__proto__`.)
  const all = new Map(Object.entries(a));
  for (const [path, hashes] of Object.entries(b)) all.set(path, [...(all.get(path) ?? []), ...hashes]);
  return Object.fromEntries(all);
}

/** How often each line is in a set of lines. */
function copiesOf(lines: Lines | null): Map<string, number> {
  const copies = new Map<string, number>();
  for (const [path, hashes] of Object.entries(lines ?? {})) for (const hash of hashes) copies.set(lineKey(path, hash), (copies.get(lineKey(path, hash)) ?? 0) + 1);
  return copies;
}

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
  const { counted, pooled } = linesOf(rows);
  return rows.map((row, i) => {
    const counts = counted[i];
    if (!counts) return row.lines;
    const all = pooled(row);
    let weight = 0;
    for (const [line, n] of counts) weight += (n * all.get(line)!.most) / all.get(line)!.sum;
    return weight;
  });
}

/**
 * Each row's lines, counted, and for each line how often it is there in all
 * of them together and in the one that has it most: of the rows not closed
 * for one that is not, of all of them for one that is (see `weigh`).
 */
function linesOf(rows: { live: boolean; matched: Lines | null }[]) {
  const counted = rows.map((row) => {
    if (!row.matched) return null;
    const counts = new Map<string, number>();
    for (const [path, hashes] of Object.entries(row.matched)) {
      for (const hash of hashes) counts.set(`${path}\n${hash}`, (counts.get(`${path}\n${hash}`) ?? 0) + 1);
    }
    return counts;
  });
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
  return { counted, pooled: (row: { live: boolean }) => (row.live ? live : every) };
}

/**
 * Of what a session's lines that pull requests were opened with count as
 * (`weigh`, of `opened`), what those still there count as: there in any of
 * the pull requests it has lines in now (`now`), not only the one it was
 * opened in. So a line opened in two counts once between them as long as one
 * of them keeps it, wherever it ended up; a line opened more often than it
 * is still there counts for those copies only, shared out in proportion.
 * Null for one whose lines were not kept.
 *
 * With `among`, a line is shared out as it is between those instead, all
 * alike: what a session contributed to each of its pull requests, which is
 * what its cost is split by (see `charge`). A line then survives for as much
 * of it as was paid for here.
 */
export function weighKept(
  opened: { live: boolean; matched: Lines | null }[],
  now: { live: boolean; matched: Lines | null }[],
  among?: { matched: Lines | null }[],
): (number | null)[] {
  const { counted, pooled } = linesOf(opened);
  const there = linesOf(now).pooled;
  const shared = among && linesOf(among.map((row) => ({ live: true, matched: row.matched }))).pooled({ live: true });
  return opened.map((row, i) => {
    const counts = counted[i];
    if (!counts) return null;
    const own = pooled(row);
    const kept = there(row);
    let weight = 0;
    for (const [line, n] of counts) {
      // (One whose lines were not kept is in no sharing out: its lines are then shared as they were opened.)
      const { sum, most } = shared?.get(line) ?? own.get(line)!;
      weight += (n * Math.min(kept.get(line)?.most ?? 0, most)) / sum;
    }
    return weight;
  });
}

/** How many of the lines `opened` has are in `now` too, a line as often as both have it. */
function keptIn(opened: Lines | null, now: Lines | null): number | null {
  if (!opened || !now) return null;
  let kept = 0;
  for (const [path, hashes] of Object.entries(opened)) {
    const left = new Map<string, number>();
    // (A file may be called `constructor`, which every object has already.)
    for (const hash of Object.hasOwn(now, path) ? now[path]! : []) left.set(hash, (left.get(hash) ?? 0) + 1);
    for (const hash of hashes) {
      const n = left.get(hash) ?? 0;
      if (n === 0) continue;
      left.set(hash, n - 1);
      kept += 1;
    }
  }
  return kept;
}

/** Two sets of lines together: each line as often as the one that has it most. Null when neither was kept. */
export function unionLines(a: Lines | null, b: Lines | null): Lines | null {
  if (!a || !b) return a ?? b;
  // (A file may be called `constructor`, which every object has already.)
  const all = new Map<string, string[]>(Object.entries(a));
  for (const [path, hashes] of Object.entries(b)) {
    const had = all.get(path);
    if (!had) {
      all.set(path, hashes);
      continue;
    }
    const left = new Map<string, number>();
    for (const hash of had) left.set(hash, (left.get(hash) ?? 0) + 1);
    const more = hashes.filter((hash) => {
      const n = left.get(hash) ?? 0;
      if (n > 0) left.set(hash, n - 1);
      return n === 0;
    });
    if (more.length > 0) all.set(path, [...had, ...more]);
  }
  return Object.fromEntries(all);
}

const countLines = (lines: Lines): number => Object.values(lines).reduce((sum, hashes) => sum + hashes.length, 0);

/** What a session is known to have cost, and where: all a pull request's share of it is worked out from. */
export interface Spent {
  cost_usd: number | null;
  /** Its cost by the branch checked out when it was spent, where its agent says (an upload's `cost.by_branch`). */
  by_branch: { branch?: string | null; usd?: number }[] | null;
}

/** The branch a pull request is taken to be based on when its report did not say. */
const DEFAULT_BASES = ["main", "master"];

/**
 * What a session is charged to each of the pull requests it contributed
 * lines to, split between them as the lines it contributed to each at any
 * time (`contributed`) count, a line in several being shared out between
 * them (see `weigh`). Merged, open or closed, they share alike: which of
 * them a charge is in does not move it.
 *
 * Having lines in a pull request is what makes a session pay for it. Of a
 * session that says no more than one branch for all of it, or none, all of
 * its cost is shared out so, whatever that branch is: it may have begun on
 * another and its lines came to this one all the same.
 *
 * Where its agent says the branch turn by turn (`by_branch`), what was spent
 * on a branch is the pull requests' whose branch it is. What was spent on
 * one that is no such pull request's and that some are based on (`main`,
 * before the branch was made: the planning, the first edits) is theirs
 * too. What was spent on any other branch is no pull request's.
 *
 * One of them on whose own branch the session spent nothing (a branch
 * renamed before it was pushed, a detached checkout, lines picked onto
 * another): the names are what is off there and not the work, since its
 * lines are there. It is charged as of a session that names no branches,
 * its share of all the session cost by lines, or what was spent on its base
 * where that is more: a cent spent on `main` does not make the names say
 * what it cost. The others are charged what their branches say; where all
 * that comes to more than was spent, all are brought down alike. Null for a
 * session with no cost figure, or none.
 */
export function charge(
  session: Spent | null,
  rows: { head_ref: string | null; base_ref?: string | null; lines: number; contributed: Lines | null }[],
): (number | null)[] {
  const cost = session?.cost_usd;
  if (session == null || cost == null) return rows.map(() => null);
  const named = new Map<string, number>();
  for (const spent of Array.isArray(session.by_branch) ? session.by_branch : []) {
    if (typeof spent?.branch === "string" && typeof spent.usd === "number" && Number.isFinite(spent.usd) && spent.usd > 0) {
      named.set(spent.branch, (named.get(spent.branch) ?? 0) + spent.usd);
    }
  }
  const every = rows.map((_, i) => i);
  const byLines = (spent: number, among: number[], charged: number[]) => {
    const weights = weigh(among.map((i) => ({ live: true, lines: rows[i]!.lines, matched: rows[i]!.contributed })));
    const all = weights.reduce((sum, weight) => sum + weight, 0);
    among.forEach((i, at) => (charged[i]! += all > 0 ? (spent * weights[at]!) / all : 0));
    return charged;
  };
  // What each would be charged of a session that names no branches.
  const whole = byLines(cost, every, rows.map(() => 0));
  // Turns that name no branch at all say no more than a session that names none.
  if (named.size === 0) return whole;
  const basedOn = (row: (typeof rows)[number], branch: string) => (row.base_ref != null ? row.base_ref === branch : DEFAULT_BASES.includes(branch));
  const charged = rows.map(() => 0);
  for (const [branch, spent] of named) {
    const heads = every.filter((i) => rows[i]!.head_ref === branch);
    byLines(spent, heads.length > 0 ? heads : every.filter((i) => basedOn(rows[i]!, branch)), charged);
  }
  // One with lines of the session's and nothing spent on its own branch: the branches do not say what it cost.
  for (const i of every) if (rows[i]!.head_ref == null || !named.has(rows[i]!.head_ref!)) charged[i] = Math.max(charged[i]!, whole[i]!);
  // Never more than was spent, whatever the turns add up to, or with such a one beside them.
  const total = charged.reduce((sum, one) => sum + one, 0);
  return total > cost && total > 0 ? charged.map((one) => (one * cost) / total) : charged;
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
): Promise<{ attribution: PullAttribution; files: PullFile[]; sessions: Kept[]; seen: Map<string, number> }> {
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
    // The lines whose writers this says: those it was first reported with, and those it has now,
    // each as often as the one of the two that has it most.
    seen: copiesIn(first, now),
  };
}

/** How many reports of one pull request are kept. The oldest past this are dropped. */
const HISTORY_KEPT = 50;

/**
 * One request stores or matches a pull request at a time, its first too,
 * when there is no row yet to hold. The later one then sees what the earlier
 * left. The same lock a report takes, so a rematch waits for it.
 */
export async function holdPull(db: OrgDb, repo: string, number: number): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessionly-pull:${db.orgId}:${repo}#${number}`]);
}

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
const linesChanged = (n: number): string => (n === 1 ? "1 session's lines changed" : `${n} sessions' lines changed`);

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

/** The words for a newer Action: its version, and the one it replaced when that one can be read. */
function actionReason(before: string | null, version: string): string {
  return before && actionNumbers(before) ? `Action ${version}, was ${before}` : `Action ${version}`;
}

/**
 * What changed between two reports, and the reason in words. New commits
 * first, then fewer commits, then sessions that arrived, then sessions that
 * are gone, then a newer Action, then a session whose line count changed,
 * and otherwise that it was matched again. With no earlier report there is
 * nothing to compare, and no reason.
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
  const dropped = -commits;
  const delta = signed(now.agent_lines - before.agent_lines);
  let reason = "matched again, nothing new";
  if (commits > 0) reason = commits === 1 ? "1 new commit" : `${commits} new commits`;
  else if (commits < 0) reason = dropped === 1 ? "1 commit removed" : `${dropped} commits removed`;
  else if (added.length > 0) reason = `${sessionsWord(added.length)} uploaded since: ${delta} agent lines`;
  else if (gone.length > 0) reason = `${sessionsWord(gone.length)} no longer matched: ${delta} agent lines`;
  else if (newerAction(before.reporter_version, now.reporter_version) && now.reporter_version) {
    reason = actionReason(before.reporter_version, now.reporter_version);
  } else if (changed.length > 0) reason = `${linesChanged(changed.length)}: ${delta} agent lines`;

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
 * A row is written when the lines, the agent lines, the commits or the set
 * of sessions and their line counts differ from the latest one, and when a
 * newer Action reports the same figures. That row keeps the version that
 * produced it; the one before it is left as it was, so a later change is
 * not explained by a version that already had a row. Only the latest
 * `HISTORY_KEPT` stay.
 */
async function recordReport(
  db: OrgDb,
  report: HistoryFigures & { repo: string; number: number; event: string },
): Promise<void> {
  const [latest] = await db.query<{
    id: unknown;
    event: unknown;
    commits: unknown;
    lines: unknown;
    agent_lines: unknown;
    sessions: unknown;
    reporter_version: unknown;
  }>(
    `SELECT id, event, commits, lines, agent_lines, sessions, reporter_version
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
  // Same figures, and not a newer Action: the row already there still says
  // which version produced it.
  if (same && !newerAction(version, report.reporter_version)) return;
  // Matched again after being matched again, and no report between: one row
  // says what it came to. A session still going is uploaded at every turn,
  // and would otherwise push the reports out of what is kept.
  // (A report since, with figures that moved nothing, wrote no row: it is not merged past.)
  // pull_requests.updated_at is the report clock: only storePull sets it, and
  // matching again (rematchPull) or anything else that updates the row must not.
  const reportedSince = async () => {
    const [pull] = await db.query<{ later: boolean }>(
      `SELECT updated_at > (SELECT at FROM pull_request_reports WHERE org_id = $1 AND id = $4) AS later
       FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3`,
      [db.orgId, report.repo, report.number, latest!.id],
    );
    return pull?.later === true;
  };
  if (latest?.event === "match" && report.event === "match" && !(await reportedSince())) {
    // Back to what the row before it says: then nothing moved, and it goes.
    const [before] = await db.query<{ commits: unknown; lines: unknown; agent_lines: unknown; sessions: unknown }>(
      `SELECT commits, lines, agent_lines, sessions FROM pull_request_reports
       WHERE org_id = $1 AND repo = $2 AND number = $3 AND id <> $4
       ORDER BY at DESC, id DESC LIMIT 1`,
      [db.orgId, report.repo, report.number, latest.id],
    );
    const back =
      before != null &&
      num(before.commits) === report.commits &&
      num(before.lines) === report.lines &&
      num(before.agent_lines) === report.agent_lines &&
      sessionSignature(sessionsOf(before.sessions)) === sessionSignature(report.sessions);
    if (back) {
      await db.query(`DELETE FROM pull_request_reports WHERE org_id = $1 AND id = $2`, [db.orgId, latest.id]);
      return;
    }
    await db.query(
      `UPDATE pull_request_reports SET at = clock_timestamp(), commits = $2, lines = $3, agent_lines = $4, sessions = $5::jsonb, reporter_version = $6
       WHERE org_id = $1 AND id = $7`,
      [db.orgId, report.commits, report.lines, report.agent_lines, JSON.stringify(report.sessions.map(picked)), report.reporter_version, latest.id],
    );
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
  // One report of a pull request at a time, its first too, when there is no
  // row yet to hold: the later one then sees what the earlier left, the state
  // and the lines it was first reported with. Held until the history is written.
  await holdPull(db, report.repo, report.number);
  // Before the sessions are read: a session stored meanwhile then either is
  // read here, or is looked for in this pull request once this is committed
  // (`pullsAddedTo` waits for it).
  await holdPullSessions(db);
  const [existing] = await db.query<{ first_files: unknown; first_event: string; state: string; head_ref: string | null; base_ref: string | null }>(
    `SELECT first_files, first_event, state, head_ref, base_ref FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3 FOR UPDATE`,
    [db.orgId, report.repo, report.number],
  );
  const first = existing ? json<FileHashes[]>(existing.first_files) : report.files;
  const { attribution, files, sessions, seen } = await match(db, report, first, report.files, existing?.first_event ?? report.event);
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
       updated_at = clock_timestamp(), matched_at = clock_timestamp()`, // the report clock: see recordReport
    Object.values(columns),
  );
  // Closing without merging, or opening again, changes what its lines take from other pull requests.
  const turned = existing != null && (existing.state === "closed") !== (report.state === "closed");
  // Its branch, or the one it is based on, is another (one stacked on a pull request that was merged
  // is based on what that one was): what its sessions spent on which branch is its own is another too.
  const moved = existing != null && ((existing.head_ref ?? null) !== (report.head_ref ?? null) || (existing.base_ref ?? null) !== (report.base_ref ?? null));
  await keepSessions(db, report.repo, report.number, sessions, turned || moved, seen);
  await recordReport(db, {
    repo: report.repo,
    number: report.number,
    event: report.event,
    commits: report.commits,
    lines: attribution.now.lines,
    agent_lines: attribution.now.agent_lines,
    sessions: sessions.filter((s) => s.lines > 0).map(picked),
    reporter_version: typeof columns.reporter_version === "string" ? columns.reporter_version : null,
  });
  return attribution;
}

/**
 * Held until the transaction ends by whoever writes which lines of which
 * sessions a pull request has, one at a time in an organisation: two reports
 * that share a session would each miss the other's lines, and a report and
 * the deleting of a session would each miss the other. A report holds it from
 * before it reads the sessions, so reports in an organisation are matched one
 * at a time, and looking for what an upload adds lines to (`pullsAddedTo`)
 * waits for them.
 */
export async function holdPullSessions(db: OrgDb): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessionly-pull-sessions:${db.orgId}`]);
}

/**
 * The sessions with lines in a pull request, in place of the ones before,
 * and beside them those that had lines in it once: what a session
 * contributed to a pull request (`contributed`) only grows, so that what it
 * is charged there does not shrink when review takes its lines out. A line
 * that is still in what the pull request was first reported with, or in what
 * it has now (`seen`), is whose this match says it is: one put down to a
 * session before the one that wrote it was uploaded goes with it. A line
 * that is in neither any more stays with the session it was last put down
 * to: there is nothing left to match it by.
 *
 * What their lines count as, and what each session is charged, is worked
 * out again in every pull request those sessions, and the ones before, have
 * lines in: a line now in two is shared.
 */
async function keepSessions(db: OrgDb, repo: string, number: number, sessions: Kept[], turned: boolean, seen: Map<string, number>): Promise<void> {
  // Most reports change none of this (a review, a comment, a push of other
  // lines): then nothing is written. (A report holds the lock below from
  // before it reads the sessions, `storePull`; matching again takes it here.)
  // The pull request's own row is held by whoever got here, so these are not
  // changing under it.
  const had = await db.query(
    `SELECT s.machine_id, s.source, s.session_id, s.lines, s.opened_lines, s.matched, s.opened_matched, s.contributed,
            (r.first_event = 'opened' AND s.opened_matched IS NOT NULL AND s.opened_kept IS NULL) OR s.contributed_lines IS NULL AS unweighed
     FROM pull_sessions s JOIN pull_requests r USING (org_id, repo, number)
     WHERE s.org_id = $1 AND s.repo = $2 AND s.number = $3`,
    [db.orgId, repo, number],
  );
  const kept = (value: unknown) => (value == null ? null : json<Lines>(value));
  const next = new Map<string, Kept & { contributed: Lines }>(
    sessions.map((s) => [sessionKey(s), { ...s, contributed: unionLines(s.matched, s.opened_matched)! }]),
  );
  // What each had given before, in an order that does not depend on how the rows come back.
  // From before what a session contributed was kept apart: what it had then, and was opened with.
  // None for one deleted since, whose lines are not kept past it: it stays only while this match has it.
  const gave = had
    .map((row) => ({ row, key: sessionKey(row as never), before: kept(row.contributed) ?? unionLines(kept(row.matched), kept(row.opened_matched)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // A line given more often, by all of them together, than the files have it now or had at
  // first (three of the same, of which review took two; one each of two sessions, of which
  // review took one): the copies that are in neither are gone. They stay with the sessions
  // that this match gives fewer of than they had given, so that what a session gave does not
  // shrink when review takes its lines out, while a line that is still there is whose this
  // match says it is.
  const given = new Map<string, number>();
  for (const { before } of gave) for (const [line, n] of copiesOf(before)) given.set(line, (given.get(line) ?? 0) + n);
  const left = new Map([...given].map(([line, n]) => [line, Math.max(0, n - (seen.get(line) ?? 0))]));
  const matchedNow = new Map([...next].map(([key, s]) => [key, copiesOf(s.contributed)]));
  for (const { row, key, before } of gave) {
    if (!before) continue;
    const has = matchedNow.get(key);
    const gone = new Map<string, string[]>();
    for (const [path, hashes] of Object.entries(before)) {
      for (const hash of new Set(hashes)) {
        const line = lineKey(path, hash);
        const fewer = hashes.filter((one) => one === hash).length - (has?.get(line) ?? 0);
        const take = Math.min(fewer, left.get(line) ?? 0);
        if (take <= 0) continue;
        left.set(line, left.get(line)! - take);
        gone.set(path, [...(gone.get(path) ?? []), ...Array<string>(take).fill(hash)]);
      }
    }
    if (gone.size === 0) continue;
    // (As entries: a file may be called `__proto__`, or `constructor`.)
    const now = next.get(key);
    if (now) now.contributed = addLines(now.contributed, Object.fromEntries(gone));
    else {
      const s = { machine_id: String(row.machine_id), source: String(row.source), session_id: String(row.session_id) };
      next.set(key, { ...s, lines: 0, matched: {}, opened_lines: 0, opened_matched: {}, contributed: Object.fromEntries(gone) });
    }
  }
  const files = (lines: Lines | null) => lines && Object.keys(lines).sort().map((path) => [path, [...lines[path]!].sort()]);
  const said = (s: { lines: unknown; opened_lines: unknown; matched: unknown; opened_matched: unknown; contributed: unknown }) =>
    JSON.stringify([
      s.lines == null ? null : num(s.lines),
      s.opened_lines == null ? null : num(s.opened_lines),
      files(kept(s.matched)),
      files(kept(s.opened_matched)),
      files(kept(s.contributed)),
    ]);
  const was = new Map(had.map((row) => [sessionKey(row as never), said(row as never)]));
  // (One kept before what its opening lines still there count as was, or what it contributed, is weighed again.)
  const unweighed = had.some((row) => row.unweighed === true);
  if (!turned && !unweighed && was.size === next.size && [...next].every(([key, s]) => was.get(key) === said(s))) return;
  await holdPullSessions(db);
  const before = await db.query(
    `DELETE FROM pull_sessions WHERE org_id = $1 AND repo = $2 AND number = $3 RETURNING machine_id, source, session_id`,
    [db.orgId, repo, number],
  );
  if (next.size > 0) {
    // Which lines are kept only of a session that is still here: one deleted
    // since its lines were matched, a moment ago, takes them with it.
    await db.query(
      `INSERT INTO pull_sessions
         (org_id, repo, number, machine_id, source, session_id, lines, weight, matched, opened_lines, opened_weight, opened_matched,
          contributed, contributed_lines)
       SELECT $1, $2, $3, s.machine_id, s.source, s.session_id, s.lines, s.lines, CASE WHEN here.is THEN s.matched END,
              s.opened_lines, s.opened_lines, CASE WHEN here.is THEN s.opened_matched END,
              CASE WHEN here.is THEN s.contributed END, s.contributed_lines
       FROM jsonb_to_recordset($4::jsonb)
         AS s(machine_id text, source text, session_id text, lines integer, matched jsonb, opened_lines integer, opened_matched jsonb,
              contributed jsonb, contributed_lines integer),
       LATERAL (SELECT EXISTS (SELECT 1 FROM sessions x WHERE x.org_id = $1 AND x.machine_id = s.machine_id
                               AND x.source = s.source AND x.session_id = s.session_id) AS is) here`,
      [db.orgId, repo, number, JSON.stringify([...next.values()].map((s) => ({ ...s, contributed_lines: countLines(s.contributed) })))],
    );
  }
  const touched = new Map([...before, ...next.values()].map((s) => [sessionKey(s as never), { machine_id: s.machine_id, source: s.source, session_id: s.session_id }]));
  await weighAgain(db, [...touched.values()]);
}

/**
 * What these sessions' lines count as in every pull request they have lines
 * in, worked out again from what is kept of them (see `weigh` and
 * `weighKept`), and what each session is charged in each (see `charge`),
 * from what it cost as it is held now. The caller holds `holdPullSessions`,
 * or its shared kind for one session of its own.
 */
async function weighAgain(db: OrgDb, touched: { machine_id: unknown; source: unknown; session_id: unknown }[]): Promise<void> {
  if (touched.length === 0) return;
  const rows = await db.query(
    `SELECT o.repo, o.number, o.machine_id, o.source, o.session_id, o.lines, o.weight, o.matched,
            o.opened_lines, o.opened_weight, o.opened_matched, o.opened_kept, o.opened_here, o.contributed, o.contributed_lines,
            o.charged_usd, r.state <> 'closed' AS live, r.first_event = 'opened' AS from_open, r.head_ref, r.base_ref
     FROM jsonb_to_recordset($2::jsonb) AS k(machine_id text, source text, session_id text)
     JOIN pull_sessions o ON o.org_id = $1 AND o.machine_id = k.machine_id AND o.source = k.source AND o.session_id = k.session_id
     JOIN pull_requests r ON r.org_id = o.org_id AND r.repo = o.repo AND r.number = o.number`,
    [db.orgId, JSON.stringify(touched)],
  );
  if (rows.length === 0) return;
  // What each cost, once for a session however many pull requests it is in: its payload is opened for the turns' branches.
  const held = await db.query(
    `SELECT x.machine_id, x.source, x.session_id, x.cost_usd, x.payload #> '{session,cost,by_branch}' AS by_branch
     FROM jsonb_to_recordset($2::jsonb) AS k(machine_id text, source text, session_id text)
     JOIN sessions x ON x.org_id = $1 AND x.machine_id = k.machine_id AND x.source = k.source AND x.session_id = k.session_id`,
    [db.orgId, JSON.stringify(touched)],
  );
  const spent = new Map<string, Spent>(
    held.map((row) => [
      sessionKey(row as never),
      {
        cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
        by_branch: row.by_branch == null ? null : json<Spent["by_branch"]>(row.by_branch),
      },
    ]),
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
  for (const [key, its] of bySession) {
    const weights = weigh(its.map((row) => ({ live: row.live === true, lines: num(row.lines), matched: lines(row.matched) })));
    // The lines each was first reported with are shared out likewise: ones that
    // moved from one pull request to another were opened in both, and paid for once.
    // Only between those seen from the start: of another, what it was first
    // reported with says nothing, and it takes nothing from them.
    const fromOpen = its.filter((row) => row.from_open === true);
    const openedWith = fromOpen.map((row) => ({ live: row.live === true, lines: num(row.opened_lines), matched: lines(row.opened_matched) }));
    const opened = new Map(weigh(openedWith).map((weight, i) => [fromOpen[i]!, weight]));
    // What it contributed to each, at any time: of one kept before that was, what it has now and was opened with,
    // and of one whose lines were not kept, as many as were counted.
    const gave = its.map((row) => {
      const contributed = lines(row.contributed) ?? unionLines(lines(row.matched), lines(row.opened_matched));
      const counted = contributed ? countLines(contributed) : Math.max(num(row.lines), num(row.opened_lines));
      return { contributed, lines: row.contributed_lines == null ? counted : num(row.contributed_lines) };
    });
    // And of those, what the ones still there, in any of them, count as: a line shared out as
    // the session's cost is, between all it contributed to, so that what a line that survived
    // cost divides what was paid for it here.
    const keptWith = weighKept(
      openedWith,
      fromOpen.map((row) => ({ live: row.live === true, matched: lines(row.matched) })),
      gave.map((one) => ({ matched: one.contributed })),
    );
    const kept = new Map(keptWith.map((weight, i) => [fromOpen[i]!, weight]));
    const charged = charge(
      spent.get(key) ?? null,
      its.map((row, i) => ({ head_ref: (row.head_ref as string) ?? null, base_ref: (row.base_ref as string) ?? null, lines: gave[i]!.lines, contributed: gave[i]!.contributed })),
    );
    const unchanged = (stored: unknown, now: number | null) => (now == null ? stored == null : same(stored, now));
    its.forEach((row, i) => {
      // From before the lines it was opened with were counted: nothing to say of them.
      const then = row.opened_lines == null ? null : (opened.get(row) ?? num(row.opened_lines));
      const still = then == null ? null : (kept.get(row) ?? null);
      const here = still == null ? null : keptIn(lines(row.opened_matched), lines(row.matched));
      if (
        same(row.weight, weights[i]!) &&
        unchanged(row.opened_weight, then) &&
        unchanged(row.opened_kept, still) &&
        unchanged(row.opened_here, here) &&
        row.contributed_lines != null &&
        unchanged(row.charged_usd, charged[i]!)
      )
        return;
      changed.push({
        repo: row.repo,
        number: row.number,
        machine_id: row.machine_id,
        source: row.source,
        session_id: row.session_id,
        weight: weights[i],
        opened_weight: then,
        opened_kept: still,
        opened_here: here,
        // Kept as it is where it was kept already: only one from before is given what it had.
        contributed: row.contributed_lines == null && row.contributed == null ? gave[i]!.contributed : null,
        contributed_lines: gave[i]!.lines,
        charged_usd: charged[i]!,
      });
    });
  }
  if (changed.length === 0) return;
  await db.query(
    `UPDATE pull_sessions o SET weight = c.weight, opened_weight = c.opened_weight, opened_kept = c.opened_kept,
            opened_here = c.opened_here, contributed = coalesce(c.contributed, o.contributed),
            contributed_lines = c.contributed_lines, charged_usd = c.charged_usd
     FROM jsonb_to_recordset($2::jsonb)
       AS c(repo text, number integer, machine_id text, source text, session_id text, weight double precision,
            opened_weight double precision, opened_kept double precision, opened_here integer, contributed jsonb,
            contributed_lines integer, charged_usd double precision)
     WHERE o.org_id = $1 AND o.repo = c.repo AND o.number = c.number AND o.machine_id = c.machine_id
       AND o.source = c.source AND o.session_id = c.session_id`,
    [db.orgId, JSON.stringify(changed)],
  );
}

/** What these sessions are charged in each of their pull requests, worked out again. The caller holds `holdPullSessions`. */
export async function chargeAgain(db: OrgDb, sessions: SessionKey[]): Promise<void> {
  await weighAgain(db, sessions);
}

/**
 * What one session is charged in each of its pull requests, worked out
 * again: it was stored with another cost, or other branches. After any
 * report that is storing its lines now, and not before another upload:
 * uploads do not wait for each other.
 */
export async function chargeSession(db: OrgDb, key: SessionKey): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, [`sessionly-pull-sessions:${db.orgId}`]);
  // Two uploads of the one session, one after the other: the later one's cost is the one left.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessionly-charge:${db.orgId}:${sessionKey(key)}`]);
  await weighAgain(db, [key]);
}

/**
 * A session of a pull request (`pull_sessions s`, of `pull_requests r`) kept
 * before something `weighAgain` works out was: what its opening lines still
 * there count as, or what it contributed and is charged.
 */
export const UNWEIGHED = `(r.first_event = 'opened' AND s.opened_matched IS NOT NULL AND s.opened_kept IS NULL) OR s.contributed_lines IS NULL`;

/** A session, as `weighKeptSome` goes through them in order. */
export type SessionAt = { machine_id: string; source: string; session_id: string };

/**
 * Some of the sessions of pull requests that were kept before what their
 * opening lines still there count as was (`opened_kept`), or before what
 * they contributed and are charged was (`contributed_lines`), weighed and
 * charged again: those after `after`, in order, one transaction a time, so
 * that the organisation's reports wait for no more than one. The last one
 * taken, for the next call to go on from, or null when none is left. One
 * that weighing leaves as it was is not met again.
 */
export async function weighKeptSome(db: OrgDb, after: SessionAt | null = null, atOnce = 50): Promise<SessionAt | null> {
  const some = await db.query<SessionAt>(
    `SELECT DISTINCT s.machine_id, s.source, s.session_id FROM pull_sessions s JOIN pull_requests r USING (org_id, repo, number)
     WHERE s.org_id = $1 AND (${UNWEIGHED})
       AND ($2::jsonb IS NULL OR (s.machine_id, s.source, s.session_id) >
             ($2::jsonb->>'machine_id', $2::jsonb->>'source', $2::jsonb->>'session_id'))
     ORDER BY s.machine_id, s.source, s.session_id LIMIT $3`,
    [db.orgId, after ? JSON.stringify(after) : null, atOnce],
  );
  if (some.length === 0) return null;
  await holdPullSessions(db);
  await weighAgain(db, some);
  return some[some.length - 1]!;
}

/**
 * Match a pull request's lines again, as last reported, against the sessions
 * held now: one uploaded after the last report then counts. Nothing else
 * about the pull request changes. Null if there is none under that number;
 * `needs_report` for one last reported before what it is matched by was
 * kept, or kept with another key, which only a new report from the Action
 * brings. Matched because a session was uploaded (`uploaded`), one kept with
 * another key is left as it is: a server started with the wrong key must not
 * undo what every upload meanwhile comes near.
 */
export async function rematchPull(
  db: OrgDb,
  repo: string,
  number: number,
  key?: string,
  { uploaded = false }: { uploaded?: boolean } = {},
): Promise<PullMatch | "needs_report" | null> {
  await holdPull(db, repo, number);
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
    if (uploaded) return "needs_report";
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
  const { attribution, files, sessions, seen } = await match(
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
  await keepSessions(db, repo, number, sessions, false, seen);
  await recordReport(db, {
    repo,
    number,
    event: "match",
    commits: num(r.commits),
    lines: attribution.now.lines,
    agent_lines: attribution.now.agent_lines,
    sessions: sessions.filter((s) => s.lines > 0).map(picked),
    reporter_version: typeof r.reporter_version === "string" ? r.reporter_version : null,
  });
  return { attribution, matched_at: iso(stored?.matched_at) ?? new Date().toISOString() };
}

/**
 * No more than this many pull requests are matched again when one session is
 * uploaded: those it added most lines of, then those reported last. Its lines
 * are counted here whether common or not (telling which are takes every other
 * session's claims), so one sharing more boilerplate with it can come first.
 */
export const MATCH_ON_UPLOAD = 5;

/**
 * The pull requests a session just stored can change the figures of: in its
 * repository, open or closed in the last two weeks and not before it started,
 * committed to by its person (or, for a cloud session, on its branch), with a
 * line it added to the same file, those with most of its lines first; and
 * ahead of them, those that have its lines from before, which it may have
 * fewer of now. Its lines are often uploaded after the pull request was
 * reported (it is opened while the session goes on): matching these again
 * (`rematchPull`) counts them without waiting for the next report. Run once
 * the session is committed: a report under way is waited for, and either it
 * read the session or its pull request is among these.
 */
export async function pullsAddedTo(db: OrgDb, key: SessionKey, hashKey?: string): Promise<{ repo: string; number: number }[]> {
  // The session is committed already: what it is can be read before waiting.
  const [s] = await db.query(
    `SELECT repo, started_at, runtime, branch, ${SESSION_EMAIL} AS email, payload->'lines' AS lines FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`,
    [db.orgId, key.machine_id, key.source, key.session_id],
  );
  if (!s?.repo) return [];
  const added = json<{ path?: string; hashes?: string[] }[] | null>(s.lines) ?? [];
  const hashes = [...new Set(added.flatMap((lines) => lines.hashes ?? []))];
  // None at all says nothing of the lines it had (sent without them, as an
  // older sessionly does): what pull requests have of it stays.
  if (hashes.length === 0) return [];
  // Shared: uploads do not wait for each other, only for a report under way.
  await db.query(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, [`sessionly-pull-sessions:${db.orgId}`]);
  const recent = (p = "") => `(${p}state = 'open' OR coalesce(${p}merged_at, ${p}closed_at, ${p}updated_at) >= now() - interval '14 days')`;
  // Those that have its lines from before: what it has now may be fewer, or other lines.
  const credited = await db.query(
    `SELECT p.repo, p.number, p.updated_at, p.first_files, p.last_files, greatest(ps.lines, coalesce(ps.opened_lines, 0)) AS had
     FROM pull_sessions ps JOIN pull_requests p USING (org_id, repo, number)
     WHERE ps.org_id = $1 AND ps.machine_id = $2 AND ps.source = $3 AND ps.session_id = $4
       AND (ps.lines > 0 OR ps.opened_lines > 0) AND p.committers IS NOT NULL AND ${recent("p.")}`,
    [db.orgId, key.machine_id, key.source, key.session_id],
  );
  const started = iso(s.started_at);
  const kept = s.email ? committer(db.orgId, String(s.email), hashKey) : null;
  const branch = s.runtime === "cloud" && s.branch ? String(s.branch) : null;
  // Which have one of its lines is asked of the database, file by file below.
  const has = (column: string) =>
    `EXISTS (SELECT 1 FROM jsonb_array_elements(${column}) AS f, jsonb_array_elements_text(f->'hashes') AS h WHERE h = ANY($7::text[]))`;
  const rows = await db.query(
    `SELECT repo, number, updated_at, first_files, last_files FROM pull_requests
     WHERE org_id = $1 AND committers IS NOT NULL
       AND (repo = $2 OR head_repo = $2 OR coalesce(aliases, '[]'::jsonb) ? $2)
       AND ${recent()}
       AND ($3::timestamptz IS NULL OR created_at IS NULL OR created_at <= $3::timestamptz + make_interval(days => $4::int))
       AND ($3::timestamptz IS NULL OR coalesce(merged_at, closed_at) IS NULL OR $3::timestamptz <= coalesce(merged_at, closed_at))
       AND (committers = '[]'::jsonb OR ($5::text IS NOT NULL AND committers ? $5::text) OR ($6::text IS NOT NULL AND head_ref = $6::text))
       AND (${has("last_files")} OR ${has("first_files")})`,
    [db.orgId, s.repo, started, LOOK_BACK_DAYS, kept, branch, hashes],
  );
  // Its lines by path, together whatever model groups they are in, each as
  // many times as it added it; and per file of a pull request, those of the
  // paths that are that file, together, once.
  const byPath = new Map<string, Map<string, number>>();
  for (const lines of added) {
    const path = lines.path ?? "";
    const counts = byPath.get(path) ?? new Map<string, number>();
    for (const hash of lines.hashes ?? []) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    byPath.set(path, counts);
  }
  const forFile = new Map<string, Map<string, number>>();
  const writtenIn = (path: string) => {
    let counts = forFile.get(path);
    if (!counts) {
      forFile.set(path, (counts = new Map()));
      for (const [claimed, each] of byPath) {
        if (samePath(claimed, path)) for (const [hash, n] of each) counts.set(hash, (counts.get(hash) ?? 0) + n);
      }
    }
    return counts;
  };
  // How many of a pull request's lines it added to the same file: a line the
  // file has twenty times, added once, is one.
  const overlap = (files: FileHashes[]) =>
    files.reduce((sum, file) => {
      const counts = writtenIn(file.path);
      if (counts.size === 0) return sum;
      const left = new Map(counts);
      for (const hash of file.hashes) {
        const n = left.get(hash) ?? 0;
        if (n === 0) continue;
        left.set(hash, n - 1);
        sum++;
      }
      return sum;
    }, 0);
  // The ones with most of its lines come first, now or from before (which matching again takes back),
  // so that one sharing only an import with it does not take the place of the one it wrote; then the
  // ones reported last.
  const pulls = new Map<string, { repo: string; number: number; lines: number; at: number }>();
  for (const r of [...credited, ...rows]) {
    const id = `${r.repo}#${r.number}`;
    const lines = Math.max(num(r.had), overlap(json<FileHashes[]>(r.last_files)), overlap(json<FileHashes[]>(r.first_files)));
    const at = new Date(r.updated_at as string).getTime();
    const before = pulls.get(id);
    if (!before || lines > before.lines) pulls.set(id, { repo: String(r.repo), number: num(r.number), lines, at });
  }
  const found = [...pulls.values()]
    .filter((pull) => pull.lines > 0)
    .sort((x, y) => y.lines - x.lines || y.at - x.at || x.repo.localeCompare(y.repo) || x.number - y.number)
    .map(({ repo, number }) => ({ repo, number }));
  return found.slice(0, MATCH_ON_UPLOAD);
}

/**
 * What a session's lines are now, and what else decides which pull requests
 * they count in and for whom (whose it is, where and when it ran, its model), to tell an upload that
 * changed any of it: a hash of them, or null for no session.
 */
export async function matchedBy(db: OrgDb, key: SessionKey, { hold = false }: { hold?: boolean } = {}): Promise<string | null> {
  const [row] = await db.query<{ by: string | null }>(
    `SELECT md5(jsonb_build_array(payload->'lines', ${SESSION_EMAIL}, repo, branch, runtime, started_at, primary_model)::text) AS by FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4${hold ? " FOR UPDATE" : ""}`,
    [db.orgId, key.machine_id, key.source, key.session_id],
  );
  return row?.by ?? null;
}

/**
 * What a session cost and on which branches, as it is held now: what its
 * pull requests are charged of it is worked out from these (see `charge`).
 * A hash of them, to tell an upload that changed any; null for no session.
 */
export async function spentBy(db: OrgDb, key: SessionKey): Promise<string | null> {
  const [row] = await db.query<{ by: string | null }>(
    `SELECT md5(jsonb_build_array(cost_usd, payload #> '{session,cost,by_branch}')::text) AS by FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`,
    [db.orgId, key.machine_id, key.source, key.session_id],
  );
  return row?.by ?? null;
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
  /**
   * Exactly a repository whose sessions are matched with the pull request's
   * lines, in any case: its own, the one its branch is in, or another name it
   * goes by. Not a substring, as `repo` is: `acme/shown` is not `acme/shown-2`.
   */
  sessions_repo?: string;
}

function where(orgId: string, filters: PullFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;
  const conditions: string[] = [`org_id = ${bind(orgId)}`];
  if (filters.repo) conditions.push(`repo ILIKE ${bind(`%${filters.repo.replace(/[\\%_]/g, "\\$&")}%`)}`);
  if (filters.sessions_repo) {
    const name = bind(filters.sessions_repo.toLowerCase());
    conditions.push(
      `(lower(repo) = ${name} OR lower(head_repo) = ${name} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(aliases, '[]'::jsonb)) AS a(name) WHERE lower(a.name) = ${name}))`,
    );
  }
  if (filters.state) conditions.push(`state = ${bind(filters.state)}`);
  if (filters.since) conditions.push(`coalesce(merged_at, closed_at, created_at) >= ${bind(filters.since)}::timestamptz`);
  return { sql: `WHERE ${conditions.join(" AND ")}`, params };
}

/**
 * The paths of the files of a repository's pull requests (`sessions_repo`),
 * as each was first reported and as it was last: the files known to be in
 * it. The first report of one is kept for good, so a path known once stays
 * known.
 */
export async function reportedPaths(db: OrgDb, repo: string): Promise<string[]> {
  const { sql, params } = where(db.orgId, { sessions_repo: repo });
  const rows = await db.query<{ path: string }>(
    `SELECT DISTINCT f.file->>'path' AS path
     FROM (SELECT first_files || last_files AS files FROM pull_requests ${sql}) AS p,
          jsonb_array_elements(p.files) AS f(file)
     WHERE f.file->>'path' IS NOT NULL`,
    params,
  );
  return rows.map((row) => String(row.path));
}

/** To a millionth of a dollar: sums of shares are then the same however they were added up. */
const money = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** A session that contributed lines to a pull request: what it is charged there. */
interface Share {
  /** As the pull request's page has it. */
  wrote: PullSession;
  estimated: boolean;
  /** Its cost leaves requests out: what it cost here is then a floor. */
  partial: boolean;
  /** Of one `unshared` (see `PullSession`): a pull request whose lines were not kept cannot be matched again, only reported again. */
  stuck: boolean;
  /** What its lines here now count as (see `weigh`): what a line of them cost is said of that. */
  weight: number;
  /**
   * How many of the lines the pull request was first reported with are its
   * own, and what they count as. `opened_known` is false for one kept
   * before those lines were counted.
   */
  opened_lines: number;
  opened_weight: number;
  opened_known: boolean;
  /** Of `opened_weight`, what those still there in any of its pull requests count as (see `weighKept`): null for one kept before that was. */
  opened_kept: number | null;
  /** How many of those lines are still in this pull request: null likewise. */
  opened_here: number | null;
}

const pullKey = (p: { repo: unknown; number: unknown }): string => `${p.repo}\n${p.number}`;

/**
 * What each session is charged in each of the pull requests chosen
 * (`charged_usd`, as `weighAgain` keeps it: see `charge`). `chosen` is a
 * query of the pull requests' `repo` and `number`, whose first parameter is
 * the organisation. By pull request, each with its sessions, most lines
 * first; one query however many there are.
 */
async function sharesIn(db: OrgDb, chosen: { sql: string; params: unknown[] }, full = false): Promise<Map<string, Share[]>> {
  // What a pull request's page says of each session; a list or a sum has no use for it.
  const about = ["owner_email", "runtime", "title", "started_at", "active_ms", "primary_model", "prompts"]
    .map((column) => (full ? `s.${column}` : `NULL AS ${column}`))
    .join(", ");
  const rows = await db.query(
    `WITH mine AS (
       SELECT p.repo, p.number, p.machine_id, p.source, p.session_id, p.lines, p.weight, p.opened_lines, p.opened_weight,
              p.opened_kept, p.opened_here, p.contributed_lines, p.charged_usd, r.state = 'closed' AS closed
       FROM (${chosen.sql}) c
       JOIN pull_sessions p ON p.org_id = $1 AND p.repo = c.repo AND p.number = c.number
       JOIN pull_requests r ON r.org_id = p.org_id AND r.repo = p.repo AND r.number = p.number
       -- (One kept from before with no line of it at all is no session of the pull request.)
       WHERE p.lines > 0 OR p.opened_lines > 0 OR p.contributed_lines > 0),
     totals AS (
       SELECT o.machine_id, o.source, o.session_id, count(*) AS pulls,
              bool_or(o.contributed IS NULL) AS unkept,
              bool_or(o.contributed IS NULL AND r.committers IS NULL) AS unkept_for_good
       FROM pull_sessions o JOIN pull_requests r ON r.org_id = o.org_id AND r.repo = o.repo AND r.number = o.number
       WHERE o.org_id = $1
         AND (o.machine_id, o.source, o.session_id) IN (SELECT machine_id, source, session_id FROM mine)
       GROUP BY o.machine_id, o.source, o.session_id)
     SELECT mine.*, t.pulls, t.unkept, t.unkept_for_good, s.session_id IS NOT NULL AS held,
            s.hashed_lines,
            s.cost_usd, s.cost_source, s.unpriced_requests, ${about}
     FROM mine
     LEFT JOIN totals t ON t.machine_id = mine.machine_id AND t.source = mine.source AND t.session_id = mine.session_id
     LEFT JOIN sessions s ON s.org_id = $1 AND s.machine_id = mine.machine_id AND s.source = mine.source
       AND s.session_id = mine.session_id
     ORDER BY mine.lines DESC, mine.contributed_lines DESC NULLS LAST, mine.session_id`,
    chosen.params,
  );
  const shares = new Map<string, Share[]>();
  for (const row of rows) {
    const held = row.held === true;
    const whole = held && row.cost_usd != null ? Number(row.cost_usd) : null;
    // Kept before what a session contributed was, and not charged yet (the
    // server does that after it starts): what it is charged here is not
    // known until then.
    const uncounted = held && row.contributed_lines == null;
    const cost = uncounted || whole == null || row.charged_usd == null ? null : Number(row.charged_usd);
    const lines = num(row.lines);
    // What it contributed to each is weighed against the others it contributed to: one of
    // those whose lines were not kept makes its share here unsure.
    const unkept = row.unkept === true;
    const share: Share = {
      wrote: {
        machine_id: String(row.machine_id),
        source: String(row.source),
        session_id: String(row.session_id),
        lines,
        contributed_lines: row.contributed_lines == null ? Math.max(lines, num(row.opened_lines)) : num(row.contributed_lines),
        hashed_lines: held && row.hashed_lines != null ? num(row.hashed_lines) : null,
        cost_share_usd: cost == null ? null : money(cost),
        uncounted: uncounted && whole != null,
        unshared: held && unkept && num(row.pulls) > 1,
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
      stuck: row.unkept_for_good === true,
      partial: row.cost_source === "partial_estimate" || num(row.unpriced_requests) > 0,
      weight: num(row.weight),
      opened_lines: num(row.opened_lines),
      opened_weight: row.opened_weight == null ? num(row.opened_lines) : num(row.opened_weight),
      opened_known: row.opened_lines != null,
      opened_kept: row.opened_kept == null ? null : Number(row.opened_kept),
      opened_here: row.opened_here == null ? null : num(row.opened_here),
    };
    const key = pullKey(row as never);
    if (!shares.has(key)) shares.set(key, []);
    shares.get(key)!.push(share);
  }
  return shares;
}

/**
 * What the sessions a pull request was opened with were charged, unrounded,
 * what their lines that survived count as, and whether one of them with a
 * cost leaves requests out.
 */
type Opened = { usd: number; surviving: number; floor: boolean };

/**
 * What a pull request's sessions were charged, from what is known of each
 * now; and what the summary adds up of it, so that it divides what the page
 * does.
 */
function costOf(pull: Pick<PullRow, "attribution" | "first_event">, shares: Share[]): { cost: PullCost; opened: Opened | null } {
  let usd: number | null = null;
  let estimated = false;
  let sessions = 0;
  let without = 0;
  let partial = 0;
  let unshared = 0;
  let stuck = 0;
  let uncounted = 0;
  // What the lines it has now of the sessions charged count as, a line that
  // is in two pull requests being half a line in each: what a line of it cost
  // is said of those. A session with no cost figure says nothing of that.
  let costed = 0;
  // What the sessions it was first reported with lines of were charged, where
  // every session says how many were its own; a floor when one of those has
  // no cost, or not all of it.
  let opened: number | null = null;
  let openedFloor = false;
  let openedEstimated = false;
  let openedKnown = true;
  // What a line of them that survived cost is said only of the sessions with
  // a cost: a floor only when one of those leaves requests out.
  let survivingFloor = false;
  // Of those with a cost, what the lines still there count as, where the
  // session says (`opened_kept`). Of the lines still here, how many are of a
  // session that says; and how many lines the others were opened with, and
  // what those with a cost count as.
  let kept = 0;
  let hereSaid = 0;
  let unsaidLines = 0;
  let unsaidCosted = 0;
  for (const share of shares) {
    const { lines, cost_share_usd: cost, unshared: unsure, uncounted: later } = share.wrote;
    sessions += 1;
    if (!share.opened_known) openedKnown = false;
    else if (share.opened_lines > 0) {
      if (share.opened_kept == null) unsaidLines += share.opened_lines;
      else hereSaid += share.opened_here ?? 0;
      if (cost == null) openedFloor = true;
      else {
        opened = (opened ?? 0) + cost;
        if (share.opened_kept == null) unsaidCosted += share.opened_weight;
        else kept += share.opened_kept;
        if (share.partial) openedFloor = survivingFloor = true;
        // Shared out with lines that may be the same ones, it is as unsure as the cost now.
        if (share.estimated || unsure) openedEstimated = true;
      }
    }
    if (cost == null) {
      without += 1;
      if (later) uncounted += 1;
      continue;
    }
    // One all of whose lines went in review was charged all the same: what it spent was spent.
    usd = (usd ?? 0) + cost;
    if (lines > 0) costed += share.weight;
    if (share.estimated) estimated = true;
    if (share.partial) partial += 1;
    if (unsure) unshared += 1;
    if (unsure && share.stuck) stuck += 1;
  }
  const a = pull.attribution;
  const each = usd != null && costed > 0 ? usd / costed : null;
  // What the lines that survived count as, of what they were opened with. A
  // line opened in two pull requests is half a line in each, and counts as
  // surviving in both while either keeps it: between them it is one line,
  // wherever it ended up. Of a session whose lines were not kept, which of
  // them survived is not known: of the lines that survived here, those the
  // others do not account for are taken to be shared out between such
  // sessions as the lines they were opened with.
  const here = a.by.reduce((sum, by) => sum + by.surviving, 0);
  const rest = unsaidLines > 0 ? Math.min(1, Math.max(0, here - hereSaid) / unsaidLines) : 0;
  const surviving = kept + unsaidCosted * rest;
  // What review left can only be said of a pull request seen from the start,
  // and what it was opened with cost only of one whose sessions then were kept.
  if (!openedKnown || pull.first_event !== "opened" || a.first.agent_lines === 0) opened = null;
  const cost: PullCost = {
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
    opened_surviving_lines: opened == null ? null : here,
    // Not on the page of one that kept none of them itself, though they survived in another.
    per_surviving_line_usd: opened != null && here > 0 && surviving > 0 ? money(opened / surviving) : null,
    per_surviving_line_is_floor: opened != null && here > 0 && surviving > 0 && survivingFloor,
  };
  return { cost, opened: opened == null ? null : { usd: opened, surviving, floor: survivingFloor } };
}

/** Rows as the list and the summary have them: each with what its sessions cost. */
async function costed(
  db: OrgDb,
  rows: Record<string, unknown>[],
  chosen: { sql: string; params: unknown[] },
): Promise<{ pull: PullRow; opened: Opened | null }[]> {
  const shares = rows.length > 0 ? await sharesIn(db, chosen) : new Map<string, Share[]>();
  return rows.map((r) => {
    const pull = pullRow(r);
    if (r.detailed !== true) return { pull, opened: null };
    const { cost, opened } = costOf(pull, shares.get(pullKey(pull)) ?? []);
    return { pull: { ...pull, cost }, opened };
  });
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
    cost: null,
    updated_at: iso(r.updated_at) ?? "",
    matched_at: iso(r.matched_at),
    matchable: r.matchable === true,
    reporter_version: reporterVersion,
    reporter_older: reportIsOlder(reporterName, reporterVersion),
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
export async function getPull(db: OrgDb, repo: string, number: number): Promise<Omit<PullDetail, "after_merge"> | null> {
  const [r] = await db.query(
    `SELECT ${ROW_COLUMNS}, draft, head_ref, base_ref, closed_at, detail, feedback, feedback_total
     FROM pull_requests WHERE org_id = $1 AND repo = $2 AND number = $3`,
    [db.orgId, repo, number],
  );
  if (!r) return null;
  const detail = r.detail == null ? null : json<{ files: PullFile[] }>(r.detail);
  const row = pullRow(r);
  const [reporter, shares, history] = await Promise.all([
    repoReporters(db, [repo]).then((found) => found.get(repo)),
    detail
      ? sharesIn(db, { sql: `SELECT $2::text AS repo, $3::integer AS number`, params: [db.orgId, repo, number] }, true).then(
          (found) => found.get(pullKey(row)) ?? [],
        )
      : Promise.resolve(null),
    pullHistory(db, repo, number),
  ]);
  return {
    ...row,
    cost: shares && costOf(row, shares).cost,
    reporter_current: CURRENT_ACTION,
    repo_reporter_older: reporter?.older ?? false,
    repo_reporter_version: reporter?.version ?? null,
    draft: r.draft === true,
    head_ref: (r.head_ref as string) ?? null,
    base_ref: (r.base_ref as string) ?? null,
    closed_at: iso(r.closed_at),
    files: detail?.files ?? null,
    sessions: shares && shares.map((s) => s.wrote),
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

/** What is known now of the sessions a history row names. */
async function withSessions(
  db: OrgDb,
  wrote: ReportSession[],
): Promise<(ReportSession & { session: PullSession["session"] })[]> {
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
  return { pulls: (await costed(db, rows, these)).map(({ pull }) => pull), total: num(count?.n) };
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
  // lines they were opened with cost, and what those that survived count as,
  // as each one's page has them.
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
    agent_lines_surviving_once: 0,
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
  for (const { pull, opened: its } of rows) {
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
      if (pull.cost && its) {
        opened.usd += its.usd;
        opened.surviving += its.surviving;
        if (its.floor) total.per_surviving_line_is_floor = true;
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
  total.agent_lines_surviving_once = Math.round(opened.surviving * 100) / 100;
  if (opened.surviving > 0) total.per_surviving_line_usd = money(opened.usd / opened.surviving);
  else total.per_surviving_line_is_floor = total.per_surviving_line_estimated = false;
  // Which repositories the filter contains. Each is judged by its most
  // recent report from the Action, or that named no one, and by the last
  // ACTION_WINDOW_DAYS days of those reports.
  const reporters = await repoReporters(db, [...new Set(rows.map(({ pull }) => pull.repo))]);
  const older = [...reporters].filter(([, one]) => one.older).map(([repo]) => repo);
  return { by_model: sorted(byModel), older_actions: older.sort(), total };
}
