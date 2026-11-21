// What each session contributed to a pull request, from one match of its
// lines to the next. Nothing here reads or writes: `keepSessions` in pulls.ts
// hands it what was kept and what the match says, and stores what it returns.

/** A session's lines in a pull request: the hashes, by file, as often as they are there. */
export type Lines = Record<string, string[]>;

/** A line of a file, as copies of lines are keyed. */
export const lineKey = (path: string, hash: string): string => `${path}\n${hash}`;
const hashOf = (line: string): string => line.slice(line.lastIndexOf("\n") + 1);
const pathOf = (line: string): string => line.slice(0, line.lastIndexOf("\n"));

/** How often each line of each file is in a set of lines, by `lineKey`. */
export function copiesAt(lines: Lines | null): Map<string, number> {
  const copies = new Map<string, number>();
  for (const [path, hashes] of Object.entries(lines ?? {})) for (const hash of hashes) copies.set(lineKey(path, hash), (copies.get(lineKey(path, hash)) ?? 0) + 1);
  return copies;
}

/** How often each line is in a set of lines, whatever file it is in. */
function copiesOf(lines: Lines | null): Map<string, number> {
  const copies = new Map<string, number>();
  for (const hashes of Object.values(lines ?? {})) for (const hash of hashes) copies.set(hash, (copies.get(hash) ?? 0) + 1);
  return copies;
}

/** Copies by `lineKey` as lines by file, each file's in the order of their hashes. */
function linesAt(copies: Map<string, number>): Lines {
  // (As entries: a file may be called `__proto__`, or `constructor`.)
  const files = new Map<string, string[]>();
  for (const line of [...copies.keys()].sort()) {
    const n = copies.get(line)!;
    if (n > 0) files.set(pathOf(line), [...(files.get(pathOf(line)) ?? []), ...Array<string>(n).fill(hashOf(line))]);
  }
  return Object.fromEntries(files);
}

/** Two sets of lines put together, a line in both as often as in the two. */
export function addLines(a: Lines, b: Lines): Lines {
  // (A map: a file may be called `constructor`, which every object has already, or `__proto__`.)
  const all = new Map(Object.entries(a));
  for (const [path, hashes] of Object.entries(b)) all.set(path, [...(all.get(path) ?? []), ...hashes]);
  return Object.fromEntries(all);
}

/**
 * Two sets of lines together: each line as often as the one that has it
 * most, whatever file it is in there (a file renamed between the two has the
 * same lines still). Null when neither was kept.
 */
export function unionLines(a: Lines | null, b: Lines | null): Lines | null {
  if (!a || !b) return a ?? b;
  // (A file may be called `constructor`, which every object has already.)
  const all = new Map<string, string[]>(Object.entries(a));
  const left = copiesOf(a);
  for (const [path, hashes] of Object.entries(b)) {
    const more = hashes.filter((hash) => {
      const n = left.get(hash) ?? 0;
      if (n > 0) left.set(hash, n - 1);
      return n === 0;
    });
    if (more.length > 0) all.set(path, [...(all.get(path) ?? []), ...more]);
  }
  return Object.fromEntries(all);
}

export const countLines = (lines: Lines): number => Object.values(lines).reduce((sum, hashes) => sum + hashes.length, 0);

/** A session's lines in a pull request as they were kept at the last match. `key` names the session. */
export interface Held {
  key: string;
  /**
   * Its lines in the files as they were then. Null with the others for one deleted since: nothing
   * of it is kept on. (Null beside what it contributed, of a copy an import was about to make again
   * while that took its lines out: it had all it contributed that had not gone.)
   */
  matched: Lines | null;
  /** Its lines in what the pull request was first reported with. */
  opened_matched: Lines | null;
  /** All it contributed. Null from before that was kept: what it had then, and was opened with. */
  contributed: Lines | null;
  /** Which of them went from the files. Null from before that was kept: what it contributed and has in neither. */
  gone: Lines | null;
  /** Which of those that went are lines the pull request was first reported with. Null from before that was kept: none. */
  gone_opened: Lines | null;
}

/** A session's lines in a pull request as this match says them. */
export interface Credited {
  key: string;
  matched: Lines;
  opened_matched: Lines;
}

/** What a session contributed to a pull request after a match, and which of that went from its files. */
export interface Contributed {
  key: string;
  contributed: Lines;
  gone: Lines;
  /** Which of those that went are lines the pull request was first reported with. */
  gone_opened: Lines;
}

/**
 * What each session contributed to a pull request after a match of its
 * lines: for every session the match gives lines (`now`), and for every one
 * of before (`before`) that has lines that went, in the order of their keys.
 * `first` and `seen` are how often each line of each file is in what the
 * pull request was first reported with, and in what it has now.
 *
 * What a session contributed only grows, so that what it is charged does
 * not shrink when review takes its lines out:
 *
 * - A line that is in the files now is whose the match says it is: one put
 *   down to a session before the one that wrote it was uploaded goes with it.
 * - A line that sessions had in a file, more often than the file has it now:
 *   the copies over went (three of the same, of which review took two; one
 *   each of two sessions, of which review took one). They stay with the
 *   sessions that had them there and have fewer there now, as gone, whatever
 *   is matched after: the same match again, or a line of the same words that
 *   another session writes later, there or in another file, takes none back.
 * - A session's own line is the same line in whatever file. One that went
 *   from a file while the session got one in another that no session had
 *   there (the file was renamed, the line moved) has not gone; one that went
 *   and that it has again is not counted twice. Another session's line in
 *   another file says nothing of this one's, and neither does a line that
 *   was there already and turns out to be this session's.
 * - A line the pull request was first reported with is there to match by
 *   still when it went from the files: it is whose the match says it is
 *   there. A copy that goes is one of those while the first report has
 *   more of that line than the files have now. It is kept, as such
 *   (`gone_opened`), where the match gives the session that line of the
 *   first report (more often than it has it in the files), and only as
 *   long as it does: one that the match gives to another session, or to
 *   no one, is not kept. Any other copy that went (a later copy of such a line too) stays
 *   the session's for good.
 * - All of that is of the lines a session has in the files (`matched`). The
 *   lines it was opened with are put together with them and those that went
 *   after, a line in both once.
 *
 * The same `before` as this returned, with the same match, returns the same.
 *
 * Copies of one line in one file cannot be told apart, and neither can the
 * order of an upload and a push be seen after: where several sessions wrote
 * the same line in a file, which of them keeps a copy that went may go by
 * what came first (docs-site/pull-requests.md, "Known limits", lists them).
 */
export function contributedAfter(before: Held[], now: Credited[], first: Map<string, number>, seen: Map<string, number>): Contributed[] {
  const byKey = <T extends { key: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const credited = new Map(now.map((s) => [s.key, s]));
  const has = new Map(now.map((s) => [s.key, copiesAt(s.matched)]));
  const none = new Map<string, number>();
  const held = byKey(before).flatMap((row) => {
    const all = row.contributed ?? unionLines(row.matched, row.opened_matched);
    if (!all) return [];
    const present = copiesAt(unionLines(row.matched, row.opened_matched));
    const went = row.gone ? copiesAt(row.gone) : new Map([...copiesAt(all)].map(([line, n]) => [line, Math.max(0, n - (present.get(line) ?? 0))]));
    // Those that went, apart: the ones the pull request was first reported with, and the others.
    const opened = new Map([...copiesAt(row.gone_opened)].map(([line, n]) => [line, Math.min(n, went.get(line) ?? 0)]));
    const later = new Map([...went].map(([line, n]) => [line, n - (opened.get(line) ?? 0)]));
    const there = row.matched ? copiesAt(row.matched) : new Map([...copiesAt(all)].map(([line, n]) => [line, Math.max(0, n - (went.get(line) ?? 0))]));
    // How many of each the match gives it in the first report beyond those it has in the files
    // now: so many may be lines of the first report that went.
    const now = has.get(row.key) ?? none;
    const credit = new Map([...copiesAt(credited.get(row.key)?.opened_matched ?? {})].map(([line, n]) => [line, Math.max(0, n - (now.get(line) ?? 0))]));
    return [{ key: row.key, opened, later, there, now, credit }];
  });
  const sum = (all: Iterable<Map<string, number>>): Map<string, number> => {
    const total = new Map<string, number>();
    for (const copies of all) for (const [line, n] of copies) total.set(line, (total.get(line) ?? 0) + n);
    return total;
  };
  const were = sum(held.map((s) => s.there));
  const are = sum(has.values());
  // How many copies of each went from its file; how many more of each the sessions have
  // between them than they had; and how many of each only the first report has still.
  const over = new Map([...were].map(([line, n]) => [line, Math.max(0, n - Math.max(seen.get(line) ?? 0, are.get(line) ?? 0))]));
  const grew = new Map([...are].map(([line, n]) => [line, Math.max(0, n - (were.get(line) ?? 0))]));
  const firstOnly = new Map([...first].map(([line, n]) => [line, Math.max(0, n - (seen.get(line) ?? 0))]));
  const take = (from: Map<string, number>, at: string, n: number): number => {
    const some = Math.max(0, Math.min(n, from.get(at) ?? 0));
    if (some > 0) from.set(at, from.get(at)! - some);
    return some;
  };
  const add = (to: Map<string, number>, at: string, n: number): void => {
    if (n > 0) to.set(at, (to.get(at) ?? 0) + n);
  };
  // First, of the lines each has in the files: which went with this match, and which of those
  // that went before are kept on.
  const left = held.map(({ key, opened, later, there, now, credit }) => {
    // What it has now that it had not, by line whatever the file: its own, moved here.
    const more = new Map<string, number>();
    for (const line of [...now.keys()].sort()) {
      let some = now.get(line)! - (there.get(line) ?? 0);
      if (some <= 0) continue;
      // Back where it went from, first (one the pull request was opened with before another:
      // that one is in the files again); then one that no session had there.
      some -= take(opened, line, some);
      some -= take(later, line, some);
      add(more, hashOf(line), take(grew, line, some));
    }
    // (But for one that moved.)
    const stays = (line: string, n: number): number => n - take(more, hashOf(line), n);
    // Only of a copy that went may it be said that it moved: one still there that is another's
    // now did not. (`passed`: those that left their place, the ones that moved with them.)
    const went = new Map<string, number>();
    const passed = new Map<string, number>();
    for (const line of [...there.keys()].sort()) {
      const some = take(over, line, there.get(line)! - (now.get(line) ?? 0));
      add(passed, line, some);
      add(went, line, stays(line, some));
    }
    const kept = { opened: new Map<string, number>(), later: new Map<string, number>() };
    for (const line of [...opened.keys()].sort()) add(kept.opened, line, stays(line, opened.get(line)!));
    for (const line of [...later.keys()].sort()) add(kept.later, line, stays(line, later.get(line)!));
    return { key, went, passed, credit, ...kept };
  });
  // Then which of them are lines of the first report. Only the first report has `firstOnly`
  // of each still, and those are the sessions' that the match gives them, before any other's:
  // - one kept as such stays while the match gives the session that line there beyond those it
  //   has in the files, and is one of them;
  // - so is one the session keeps for good (it went while the files had the line as often as
  //   the first report), as far as the match gives it more of the line than that: it stays
  //   the session's for good all the same, so that no later match takes it away;
  // - and so is one that left its place with this match (one that moved as much as one that
  //   went): those that went are kept as lines of the first report.
  // What is left of them after is no session's the match gives the line there, or no one's:
  // so many of the others' that went with this match are not kept at all.
  for (const s of left) {
    for (const [line, n] of s.opened) {
      const some = Math.min(n, s.credit.get(line) ?? 0);
      s.opened.set(line, some);
      take(firstOnly, line, some);
    }
  }
  for (const s of left) for (const [line, n] of s.later) take(firstOnly, line, Math.min(n, (s.credit.get(line) ?? 0) - (s.opened.get(line) ?? 0)));
  for (const s of left) {
    for (const [line, n] of s.passed) {
      const some = take(firstOnly, line, Math.min(n, (s.credit.get(line) ?? 0) - (s.opened.get(line) ?? 0)));
      const opened = Math.min(some, s.went.get(line) ?? 0);
      add(s.opened, line, opened);
      if (opened > 0) s.went.set(line, s.went.get(line)! - opened);
    }
  }
  const gone = new Map<string, { gone: Lines; gone_opened: Lines }>();
  for (const s of left) {
    for (const [line, n] of s.went) add(s.later, line, n - take(firstOnly, line, n));
    const lines = { gone: linesAt(sum([s.opened, s.later])), gone_opened: linesAt(s.opened) };
    if (countLines(lines.gone) > 0) gone.set(s.key, lines);
  }
  const all = new Set([...credited.keys(), ...gone.keys()]);
  return [...all].sort().map((key) => {
    const s = credited.get(key);
    const went = gone.get(key) ?? { gone: {}, gone_opened: {} };
    return { key, ...went, contributed: unionLines(addLines(s?.matched ?? {}, went.gone), s?.opened_matched ?? {})! };
  });
}
