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
  /** Its lines in the files as they were then. Null with the others for one deleted since: nothing of it is kept on. */
  matched: Lines | null;
  /** Its lines in what the pull request was first reported with. */
  opened_matched: Lines | null;
  /** All it contributed. Null from before that was kept: what it had then, and was opened with. */
  contributed: Lines | null;
  /** Which of them went from the files. Null from before that was kept: what it contributed and has in neither. */
  gone: Lines | null;
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
 *   still when it went from the files: where the match gave it to a session
 *   before and gives it to another now, or to no one, the first does not
 *   keep it as gone. No more of them than the first report has and the
 *   files have not: a later copy of the line that went stays the session's.
 * - All of that is of the lines a session has in the files (`matched`). The
 *   lines it was opened with are put together with them and those that went
 *   after, a line in both once.
 *
 * The same `before` as this returned, with the same match, returns the same.
 */
export function contributedAfter(before: Held[], now: Credited[], first: Map<string, number>, seen: Map<string, number>): Contributed[] {
  const byKey = <T extends { key: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const credited = new Map(now.map((s) => [s.key, s]));
  const has = new Map(now.map((s) => [s.key, copiesAt(s.matched)]));
  const held = byKey(before).flatMap((row) => {
    const all = row.contributed ?? unionLines(row.matched, row.opened_matched);
    if (!all) return [];
    const present = copiesAt(unionLines(row.matched, row.opened_matched));
    const went = row.gone ? copiesAt(row.gone) : new Map([...copiesAt(all)].map(([line, n]) => [line, Math.max(0, n - (present.get(line) ?? 0))]));
    // The lines it was opened with that it is not opened with any more.
    const opened = copiesAt(credited.get(row.key)?.opened_matched ?? {});
    const lost = new Map([...copiesAt(row.opened_matched)].map(([line, n]) => [line, Math.max(0, n - (opened.get(line) ?? 0))]));
    return [{ key: row.key, went, lost, there: copiesAt(row.matched), now: has.get(row.key) ?? new Map<string, number>() }];
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
    const some = Math.min(n, from.get(at) ?? 0);
    if (some > 0) from.set(at, from.get(at)! - some);
    return Math.max(0, some);
  };
  const gone = new Map<string, Lines>();
  for (const { key, went, lost, there, now } of held) {
    // What it has now that it had not, by line whatever the file: its own, moved here.
    const more = new Map<string, number>();
    for (const line of [...now.keys()].sort()) {
      let some = now.get(line)! - (there.get(line) ?? 0);
      if (some <= 0) continue;
      // Back where it went from, first; then one that no session had there.
      some -= take(went, line, some);
      const fresh = take(grew, line, some);
      if (fresh > 0) more.set(hashOf(line), (more.get(hashOf(line)) ?? 0) + fresh);
    }
    const left = new Map<string, number>();
    const keep = (line: string, n: number) => {
      // (But for one that moved.)
      const stays = n - take(more, hashOf(line), n);
      if (stays > 0) left.set(line, (left.get(line) ?? 0) + stays);
    };
    // Only of a copy that went may it be said that it moved: one still there that is another's now did not.
    for (const line of [...there.keys()].sort()) keep(line, take(over, line, there.get(line)! - (now.get(line) ?? 0)));
    for (const line of [...went.keys()].sort()) keep(line, went.get(line)!);
    for (const line of [...lost.keys()].sort()) take(left, line, take(firstOnly, line, Math.min(lost.get(line)!, left.get(line) ?? 0)));
    const lines = linesAt(left);
    if (countLines(lines) > 0) gone.set(key, lines);
  }
  const all = new Set([...credited.keys(), ...gone.keys()]);
  return [...all].sort().map((key) => {
    const s = credited.get(key);
    const went = gone.get(key) ?? {};
    return { key, gone: went, contributed: unionLines(addLines(s?.matched ?? {}, went), s?.opened_matched ?? {})! };
  });
}
