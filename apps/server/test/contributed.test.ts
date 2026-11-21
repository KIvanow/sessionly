import assert from "node:assert/strict";
import { test } from "node:test";
import { type Contributed, type Held, type Lines, contributedAfter, copiesAt, countLines } from "../src/contributed.ts";

// Lines are written `{ "a.ts": [1, 1, 2] }` here, the numbers standing for hashes.
type Files = Record<string, number[]>;
const lines = (files: Files): Lines => Object.fromEntries(Object.entries(files).map(([path, numbers]) => [path, numbers.map(String)]));
const numbers = (kept: Lines): Files => Object.fromEntries(Object.keys(kept).sort().map((path) => [path, kept[path]!.map(Number).sort((a, b) => a - b)]));

/** A pull request's sessions through its matches: what is kept of each, as `keepSessions` keeps it. */
class Pull {
  rows = new Map<string, Held>();
  first: Files;
  constructor(first: Files) {
    this.first = first;
  }
  /** One match: the files it has now, and which lines of them, and of the first report, are whose. */
  match(now: Files, credits: Record<string, { has?: Files; opened?: Files }>): this {
    const credited = Object.entries(credits).map(([key, s]) => ({ key, matched: lines(s.has ?? {}), opened_matched: lines(s.opened ?? {}) }));
    const after = contributedAfter([...this.rows.values()], credited, copiesAt(lines(this.first)), copiesAt(lines(now)));
    this.rows = new Map(
      after.map((row) => {
        const s = credited.find((one) => one.key === row.key);
        return [row.key, { key: row.key, matched: s?.matched ?? {}, opened_matched: s?.opened_matched ?? {}, contributed: row.contributed, gone: row.gone, gone_opened: row.gone_opened }];
      }),
    );
    return this;
  }
  /** How many lines each session contributed. */
  get gave(): Record<string, number> {
    return Object.fromEntries([...this.rows].map(([key, row]) => [key, countLines(row.contributed!)]));
  }
  gone(key: string): Files {
    return numbers(this.rows.get(key)?.gone ?? {});
  }
  /** The same match again changes nothing. */
  again(now: Files, credits: Record<string, { has?: Files; opened?: Files }>): this {
    const was = JSON.stringify([...this.rows]);
    this.match(now, credits);
    assert.equal(JSON.stringify([...this.rows]), was, "the same match again");
    return this;
  }
}

test("copies of a line that review takes out stay with the sessions that had them", () => {
  // three of the same, of which review takes two, and then the last
  const same = new Pull({ "y.ts": [9] }).match({ "m.ts": [1, 1, 1] }, { s: { has: { "m.ts": [1, 1, 1] } } });
  assert.deepEqual(same.gave, { s: 3 });
  same.match({ "m.ts": [1] }, { s: { has: { "m.ts": [1] } } }).again({ "m.ts": [1] }, { s: { has: { "m.ts": [1] } } });
  assert.deepEqual([same.gave, same.gone("s")], [{ s: 3 }, { "m.ts": [1, 1] }]);
  same.match({}, {}).again({}, {});
  assert.deepEqual([same.gave, same.gone("s")], [{ s: 3 }, { "m.ts": [1, 1, 1] }]);

  // one each of two sessions, of which review takes one: the one left is one's, the other's went
  const both = new Pull({}).match({ "r.ts": [1, 1] }, { a: { has: { "r.ts": [1] } }, b: { has: { "r.ts": [1] } } });
  both.match({ "r.ts": [1] }, { b: { has: { "r.ts": [1] } } }).again({ "r.ts": [1] }, { b: { has: { "r.ts": [1] } } });
  assert.deepEqual([both.gave, both.gone("a")], [{ a: 1, b: 1 }, { "r.ts": [1] }]);
  both.match({}, {});
  assert.deepEqual(both.gave, { a: 1, b: 1 });

  // files by names that every object has already
  const odd = new Pull({}).match({ constructor: [1], ["__proto__"]: [2], "s.ts": [3] }, { s: { has: { constructor: [1], ["__proto__"]: [2], "s.ts": [3] } } });
  odd.match({ "s.ts": [3] }, { s: { has: { "s.ts": [3] } } }).again({ "s.ts": [3] }, { s: { has: { "s.ts": [3] } } });
  assert.deepEqual([odd.gave, Object.keys(odd.rows.get("s")!.gone!).sort()], [{ s: 3 }, ["__proto__", "constructor"]]);
});

test("a line that went stays the session's whatever is matched after", () => {
  // another session writes a line of the same words in another file
  const other = new Pull({}).match({ "a.ts": [5] }, { s1: { has: { "a.ts": [5] } } }).match({}, {});
  other.match({ "b.ts": [5, 6] }, { s2: { has: { "b.ts": [5, 6] } } }).again({ "b.ts": [5, 6] }, { s2: { has: { "b.ts": [5, 6] } } });
  assert.deepEqual(other.gave, { s1: 1, s2: 2 });
  // or in the same file
  const here = new Pull({}).match({ "a.ts": [5] }, { s1: { has: { "a.ts": [5] } } }).match({}, {});
  here.match({ "a.ts": [5] }, { s2: { has: { "a.ts": [5] } } });
  assert.deepEqual(here.gave, { s1: 1, s2: 1 });
  // the same session writes it again there: the same line, once
  const back = new Pull({}).match({ "a.ts": [5] }, { s1: { has: { "a.ts": [5] } } }).match({}, {});
  back.match({ "a.ts": [5] }, { s1: { has: { "a.ts": [5] } } });
  assert.deepEqual([back.gave, back.gone("s1")], [{ s1: 1 }, {}]);

  // two copies, of which review takes one, and the one left is no one's now: the one that went is kept,
  // however often the same is matched
  const twice = new Pull({}).match({ "a.ts": [5, 5] }, { s: { has: { "a.ts": [5, 5] } } });
  twice.match({ "a.ts": [5] }, {}).again({ "a.ts": [5] }, {}).again({ "a.ts": [5] }, {});
  assert.deepEqual([twice.gave, twice.gone("s")], [{ s: 1 }, { "a.ts": [5] }]);

  // the same line of two sessions in two files, and review takes the one file's: the copy that went is
  // the session's that had it there, whatever the sessions are called, also when the other file's
  // copy turns out to be a third session's
  for (const [first, second] of [["b1", "a2"], ["a1", "b2"]] as const) {
    const two = new Pull({}).match({ "a.ts": [5], "b.ts": [5] }, { [first]: { has: { "a.ts": [5] } }, [second]: { has: { "b.ts": [5] } } });
    two.match({ "b.ts": [5] }, { [second]: { has: { "b.ts": [5] } } });
    two.match({ "b.ts": [5] }, { c3: { has: { "b.ts": [5] } } }).again({ "b.ts": [5] }, { c3: { has: { "b.ts": [5] } } });
    assert.deepEqual(two.gave, { [first]: 1, c3: 1 }, first);
  }
});

test("a session's line that moved to another file has not gone, and is not given again", () => {
  // a file renamed, and again, with the session's lines under each name
  const moved = new Pull({ "old.ts": [1, 2, 3] }).match({ "old.ts": [1, 2, 3] }, { s: { has: { "old.ts": [1, 2, 3] }, opened: { "old.ts": [1, 2, 3] } } });
  moved.match({ "new.ts": [1, 2, 3] }, { s: { has: { "new.ts": [1, 2, 3] }, opened: { "old.ts": [1, 2, 3] } } });
  moved.match({ "newer.ts": [1, 2, 3] }, { s: { has: { "newer.ts": [1, 2, 3] }, opened: { "old.ts": [1, 2, 3] } } });
  assert.deepEqual(moved.gave, { s: 3 });
  // one of them moved to another file and one taken out: three still
  moved.match({ "newer.ts": [1], "apart.ts": [2] }, { s: { has: { "newer.ts": [1], "apart.ts": [2] }, opened: { "old.ts": [1, 2, 3] } } });
  assert.deepEqual(moved.gave, { s: 3 });

  // renamed by someone, with no session that wrote it under the new name: what the session gave stays
  const lone = new Pull({}).match({ "lone.ts": [1, 2] }, { s: { has: { "lone.ts": [1, 2] } } });
  lone.match({ "alone.ts": [1, 2] }, {}).again({ "alone.ts": [1, 2] }, {});
  assert.deepEqual([lone.gave, lone.gone("s")], [{ s: 2 }, { "lone.ts": [1, 2] }]);

  // in one match, one of its two copies turns out to be a later session's and the other moves to a
  // third file: the one that moved is not also kept as gone, whatever the files are called
  for (const lost of ["a.ts", "z.ts"]) {
    const two = new Pull({}).match({ [lost]: [5], "b.ts": [5] }, { s: { has: { [lost]: [5], "b.ts": [5] } } });
    two.match({ [lost]: [5], "m.ts": [5] }, { t: { has: { [lost]: [5] } }, s: { has: { "m.ts": [5] } } });
    assert.deepEqual([two.gave, two.gone("s")], [{ s: 1, t: 1 }, {}], lost);
  }
  // and a line that was there already and turns out to be the session's is not one of its own that
  // moved: its copy that went in the same match is kept
  const took = new Pull({}).match({ "a.ts": [5], "b.ts": [5] }, { s: { has: { "a.ts": [5] } }, t: { has: { "b.ts": [5] } } });
  took.match({ "b.ts": [5] }, { s: { has: { "b.ts": [5] } } });
  assert.deepEqual([took.gave, took.gone("s")], [{ s: 2 }, { "a.ts": [5] }]);
});

test("the lines a pull request was opened with are whose the match says, also when they went", () => {
  // a line it was opened with and that the session has in a file pushed later too: when review takes
  // the first of the two out, both are what the session gave still
  const two = new Pull({ "f.ts": [5, 1] }).match({ "f.ts": [5, 1] }, { s: { has: { "f.ts": [5, 1] }, opened: { "f.ts": [5, 1] } } });
  two.match({ "f.ts": [5, 1], "e.ts": [5, 2] }, { s: { has: { "f.ts": [5, 1], "e.ts": [5, 2] }, opened: { "f.ts": [5, 1] } } });
  assert.deepEqual(two.gave, { s: 4 });
  const after = { s: { has: { "f.ts": [1], "e.ts": [5, 2] }, opened: { "f.ts": [5, 1] } } };
  two.match({ "f.ts": [1], "e.ts": [5, 2] }, after).again({ "f.ts": [1], "e.ts": [5, 2] }, after);
  assert.deepEqual(two.gave, { s: 4 });

  // one that review took out and that turns out to be a later session's: that one's alone, once,
  // whichever came first, the push or the upload
  const first = { "o.ts": [1, 2] };
  const mine = { s1: { has: { "o.ts": [1, 2] }, opened: { "o.ts": [1, 2] } } };
  const theirs = { s1: { has: { "o.ts": [2] }, opened: { "o.ts": [2] } }, s2: { opened: { "o.ts": [1] } } };
  const pushed = new Pull(first).match(first, mine).match({ "o.ts": [2] }, { s1: { has: { "o.ts": [2] }, opened: { "o.ts": [1, 2] } } });
  assert.deepEqual(pushed.gave, { s1: 2 });
  pushed.match({ "o.ts": [2] }, theirs).again({ "o.ts": [2] }, theirs);
  assert.deepEqual(pushed.gave, { s1: 1, s2: 1 });
  const uploaded = new Pull(first).match(first, mine).match(first, { s1: { has: { "o.ts": [2] }, opened: { "o.ts": [2] } }, s2: { has: { "o.ts": [1] }, opened: { "o.ts": [1] } } });
  uploaded.match({ "o.ts": [2] }, theirs);
  assert.deepEqual(uploaded.gave, { s1: 1, s2: 1 });
  // and when it is the first session's again (the other was deleted), it has it back, once
  pushed.match({ "o.ts": [2] }, { s1: { has: { "o.ts": [2] }, opened: { "o.ts": [1, 2] } } });
  assert.deepEqual(pushed.gave, { s1: 2 });

  // a second copy of such a line, pushed later, that review takes out: the one it was opened with is
  // in the files still, so the one that went is the session's own, whichever came first
  const one = { "f.ts": [1, 2] };
  const grown = { "f.ts": [1, 1, 2] };
  const start = () => new Pull(one).match(one, { s1: { has: one, opened: one } }).match(grown, { s1: { has: grown, opened: one } });
  const split = { s1: { has: { "f.ts": [2] }, opened: { "f.ts": [2] } }, s2: { has: { "f.ts": [1] }, opened: { "f.ts": [1] } } };
  const pushFirst = start().match(one, { s1: { has: one, opened: one } }).match(one, split).again(one, split);
  assert.deepEqual([pushFirst.gave, pushFirst.gone("s1")], [{ s1: 2, s2: 1 }, { "f.ts": [1] }]);
  const uploadFirst = start().match(grown, { s1: { has: { "f.ts": [1, 2] }, opened: { "f.ts": [2] } }, s2: { has: { "f.ts": [1] }, opened: { "f.ts": [1] } } });
  uploadFirst.match(one, split).again(one, split);
  assert.deepEqual([uploadFirst.gave, uploadFirst.gone("s1")], [{ s1: 2, s2: 1 }, { "f.ts": [1] }]);
});

test("a line of the first report that went is kept only while the match gives the session that line", () => {
  // which of those that went are lines of the first report is kept with them
  const first = { "a.ts": [1, 2] };
  const whole = { s1: { has: first, opened: first } };
  const taken = { s1: { has: { "a.ts": [2] }, opened: first } };
  const start = () => new Pull(first).match(first, whole).match({ "a.ts": [2] }, taken);
  assert.deepEqual([start().gave, numbers(start().rows.get("s1")!.gone_opened!)], [{ s1: 2 }, { "a.ts": [1] }]);

  // a later session wrote the line that went, and a push with its copy comes before the pull request
  // was matched again for its upload: the line is that session's, once, as it is when the match came first
  const theirs = { s1: { has: { "a.ts": [2] }, opened: { "a.ts": [2] } }, s3: { has: { "a.ts": [1] }, opened: { "a.ts": [1] } } };
  const pushed = start().match({ "a.ts": [2, 1] }, theirs).again({ "a.ts": [2, 1] }, theirs);
  assert.deepEqual([pushed.gave, pushed.gone("s1")], [{ s1: 1, s3: 1 }, {}]);
  const matched = start().match({ "a.ts": [2] }, { s1: { has: { "a.ts": [2] }, opened: { "a.ts": [2] } }, s3: { opened: { "a.ts": [1] } } });
  matched.match({ "a.ts": [2, 1] }, theirs);
  assert.deepEqual([matched.gave, matched.gone("s1")], [{ s1: 1, s3: 1 }, {}]);

  // a later session's new copy of it in the files, while the first report's is the first session's
  // still, and then an earlier session that wrote the first report's is uploaded: in either order
  // the first has none of it
  const one = { "a.ts": [1] };
  const went = () => new Pull(one).match(one, { s1: { has: one, opened: one } }).match({}, { s1: { opened: one } });
  const copy = { s1: { opened: one }, s3: { has: one } };
  const both = { s2: { opened: one }, s3: { has: one } };
  const copyFirst = went().match(one, copy).again(one, copy);
  assert.deepEqual([copyFirst.gave, copyFirst.gone("s1")], [{ s1: 1, s3: 1 }, {}]);
  copyFirst.match(one, both).again(one, both);
  assert.deepEqual(copyFirst.gave, { s2: 1, s3: 1 });
  const uploadFirst = went().match({}, { s2: { opened: one } }).match(one, both);
  assert.deepEqual(uploadFirst.gave, { s2: 1, s3: 1 });

  // the line goes in the same match that gives it to the later session: that one's, once
  const atOnce = new Pull(first).match(first, whole).match({ "a.ts": [2] }, { s1: { has: { "a.ts": [2] }, opened: { "a.ts": [2] } }, s3: { opened: { "a.ts": [1] } } });
  assert.deepEqual([atOnce.gave, atOnce.gone("s1")], [{ s1: 1, s3: 1 }, {}]);
  // and one that no session is given in the first report (the session that had it in the files
  // started after the pull request was opened) is no one's when it goes
  const noOnes = new Pull(one).match(one, { s1: { has: one } }).match({}, {}).again({}, {});
  assert.deepEqual(noOnes.gave, {});

  // a second copy of it, pushed later, and both went: one is the first report's and one is not, and
  // when one is in the files again it is the first report's that is back
  const grown = { "a.ts": [1, 1] };
  const twoGone = () => new Pull(one).match(one, { s1: { has: one, opened: one } }).match(grown, { s1: { has: grown, opened: one } }).match({}, { s1: { opened: one } });
  assert.deepEqual([twoGone().gave, twoGone().gone("s1"), numbers(twoGone().rows.get("s1")!.gone_opened!)], [{ s1: 2 }, { "a.ts": [1, 1] }, { "a.ts": [1] }]);
  const oneBack = twoGone().match(one, { s1: { has: one, opened: one } }).again(one, { s1: { has: one, opened: one } });
  assert.deepEqual([oneBack.gave, oneBack.gone("s1"), numbers(oneBack.rows.get("s1")!.gone_opened!)], [{ s1: 2 }, { "a.ts": [1] }, {}]);
  // which stays the session's when the first report's turns out to be another's
  oneBack.match(one, { s1: {}, s2: { has: one, opened: one } });
  assert.deepEqual(oneBack.gave, { s1: 1, s2: 1 });

  // the first report's two copies are one session's, which moves one of them to another file as the
  // other goes, and a third copy there, another session's from a later push, goes too: that one is
  // not the first report's, and stays its session's
  const c = { "c.ts": [1, 1] };
  const three = { "c.ts": [1, 1, 1] };
  const moving = new Pull(c).match(c, { s3: { has: c, opened: c } }).match(three, { s3: { has: c, opened: c }, s2: { has: { "c.ts": [1] } } });
  moving.match({ "b.ts": [1] }, { s3: { has: { "b.ts": [1] }, opened: c } });
  assert.deepEqual([moving.gave, moving.gone("s2")], [{ s2: 1, s3: 2 }, { "c.ts": [1] }]);

  // two of a line in the first report, one each of two sessions, and both went: each keeps its own,
  // and when one of them turns out to be a third session's, only that one is given up
  const two = { "a.ts": [1, 1] };
  const each = { a: { has: { "a.ts": [1] }, opened: { "a.ts": [1] } }, b: { has: { "a.ts": [1] }, opened: { "a.ts": [1] } } };
  const pair = new Pull(two).match(two, each).match({}, { a: { opened: { "a.ts": [1] } }, b: { opened: { "a.ts": [1] } } });
  assert.deepEqual(pair.gave, { a: 1, b: 1 });
  pair.match({}, { b: { opened: { "a.ts": [1] } }, c: { opened: { "a.ts": [1] } } }).again({}, { b: { opened: { "a.ts": [1] } }, c: { opened: { "a.ts": [1] } } });
  assert.deepEqual([pair.gave, pair.gone("b")], [{ b: 1, c: 1 }, { "a.ts": [1] }]);
});

test("what was kept before is read as it was kept", () => {
  const first = copiesAt(lines({ "a.ts": [1] }));
  const seen = copiesAt(lines({ "a.ts": [1], "b.ts": [2] }));
  const now = [{ key: "s", matched: lines({ "a.ts": [1], "b.ts": [2] }), opened_matched: lines({ "a.ts": [1] }) }];
  const said = (rows: Contributed[]) => rows.map((row) => [row.key, numbers(row.contributed), numbers(row.gone)]);
  // a deleted session's row keeps none of its lines: nothing of it stays
  const deleted: Held = { key: "d", matched: null, opened_matched: null, contributed: null, gone: null, gone_opened: null };
  assert.deepEqual(said(contributedAfter([deleted], now, first, seen)), [["s", { "a.ts": [1], "b.ts": [2] }, {}]]);
  // from before what a session contributed was kept: what it had then, and was opened with
  const old: Held = { key: "s", matched: lines({ "a.ts": [1], "c.ts": [3] }), opened_matched: lines({ "a.ts": [1] }), contributed: null, gone: null, gone_opened: null };
  assert.deepEqual(said(contributedAfter([old], now, first, seen)), [["s", { "a.ts": [1], "b.ts": [2], "c.ts": [3] }, { "c.ts": [3] }]]);
  // from before which of them went was kept: what it contributed and has in neither
  const between: Held = { key: "s", matched: lines({ "a.ts": [1] }), opened_matched: lines({ "a.ts": [1] }), contributed: lines({ "a.ts": [1], "c.ts": [3] }), gone: null, gone_opened: null };
  assert.deepEqual(said(contributedAfter([between], now, first, seen)), [["s", { "a.ts": [1], "b.ts": [2], "c.ts": [3] }, { "c.ts": [3] }]]);
  // one whose lines an import took out while what it contributed stayed: it had all of that that had not gone
  const copied: Held = { key: "s", matched: null, opened_matched: null, contributed: lines({ "a.ts": [1], "c.ts": [3], "d.ts": [4] }), gone: lines({ "d.ts": [4] }), gone_opened: null };
  assert.deepEqual(said(contributedAfter([copied], now, first, seen)), [["s", { "a.ts": [1], "b.ts": [2], "c.ts": [3], "d.ts": [4] }, { "c.ts": [3], "d.ts": [4] }]]);
  // which of two sessions keeps the one copy that went of two alike goes by their names, not by the order they are given in
  const alike = (key: string): Held => ({ key, matched: lines({ "a.ts": [1] }), opened_matched: {}, contributed: lines({ "a.ts": [1] }), gone: {}, gone_opened: {} });
  const none = new Map<string, number>();
  for (const rows of [[alike("a"), alike("b")], [alike("b"), alike("a")]]) assert.deepEqual(said(contributedAfter(rows, [], none, first)), [["a", { "a.ts": [1] }, { "a.ts": [1] }]]);
  // the rows come back in the order of the sessions' names, whatever order they were given in
  const some = [{ key: "b", matched: lines({ "b.ts": [2] }), opened_matched: {} }, { key: "a", matched: lines({ "a.ts": [1] }), opened_matched: {} }];
  assert.deepEqual(contributedAfter([], some, first, seen).map((row) => row.key), ["a", "b"]);
});

test("through any pushes and uploads, the same match again changes nothing and no session gives fewer lines for a push", () => {
  // The lines are put down to sessions as simply as may be: each copy in a file to the session that
  // wrote that line in that file and started last, as often as it wrote it.
  const PATHS = ["a.ts", "b.ts", "c.ts"];
  for (let seed = 1; seed <= 1500; seed++) {
    let state = seed;
    const random = (n: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const wrote: Files[] = [];
    const write = () => {
      const files: Files = {};
      for (const path of PATHS) if (random(2)) files[path] = Array.from({ length: 1 + random(3) }, () => 1 + random(3));
      wrote.push(files);
      return files;
    };
    const credit = (files: Files): Files[] => {
      const whose: Files[] = wrote.map(() => ({}));
      for (const [path, hashes] of Object.entries(files)) {
        const left = wrote.map((s) => [...(s[path] ?? [])]);
        for (const hash of hashes) {
          for (let i = wrote.length - 1; i >= 0; i--) {
            const at = left[i]!.indexOf(hash);
            if (at < 0) continue;
            left[i]!.splice(at, 1);
            (whose[i]![path] ??= []).push(hash);
            break;
          }
        }
      }
      return whose;
    };
    let files: Files = random(2) ? { ...write() } : {};
    const pull = new Pull(files);
    const ever = new Map<string, number>();
    const where = `seed ${seed}`;
    for (let step = 0; step < 12; step++) {
      const what = step === 0 ? 4 : random(5);
      if (what === 0 || wrote.length === 0) {
        const more = write();
        if (random(2)) for (const [path, hashes] of Object.entries(more)) files = { ...files, [path]: [...(files[path] ?? []), ...hashes] };
      } else if (what === 1) {
        const path = PATHS[random(3)]!;
        if (files[path]) files = { ...files, [path]: files[path]!.filter(() => random(2)) };
      } else if (what === 2) {
        const [from, to] = [PATHS[random(3)]!, PATHS[random(3)]!];
        if (from !== to && files[from]) {
          files = { ...files, [to]: [...(files[to] ?? []), ...files[from]!] };
          delete files[from];
        }
      } else if (what === 3) {
        files = Object.fromEntries(Object.entries(files).filter(() => random(3)));
      }
      const [has, opened] = [credit(files), credit(pull.first)];
      const credits = Object.fromEntries(
        wrote.map((_, i) => [`s${i}`, { has: has[i]!, opened: opened[i]! }] as const).filter(([, s]) => countLines(lines(s.has)) + countLines(lines(s.opened)) > 0),
      );
      const before = pull.gave;
      pull.match(files, credits).again(files, credits);
      for (const [line, n] of [...copiesAt(lines(files)), ...copiesAt(lines(pull.first))]) ever.set(line, Math.max(ever.get(line) ?? 0, n));
      const gave = pull.gave;
      // (An upload may give a session's line to another; a push of files does not.)
      if (what !== 0 && what !== 4) for (const [key, n] of Object.entries(before)) assert.ok((gave[key] ?? 0) >= n, `${where}, step ${step}: ${key} gave ${n} and gives ${gave[key] ?? 0}`);
      for (const [key, row] of pull.rows) {
        const s = wrote[Number(key.slice(1))]!;
        // No more of a line than the session wrote, and none of a file than the pull request ever had there.
        const most = new Map<string, number>();
        for (const hash of Object.values(s).flat()) most.set(String(hash), (most.get(String(hash)) ?? 0) + 1);
        const given = new Map<string, number>();
        for (const hash of Object.values(row.contributed!).flat()) given.set(hash, (given.get(hash) ?? 0) + 1);
        for (const [hash, n] of given) assert.ok(n <= (most.get(hash) ?? 0), `${where}, step ${step}: ${key} gave ${n} of ${hash} and wrote ${most.get(hash) ?? 0}`);
        for (const [line, n] of copiesAt(row.gone!)) assert.ok(n <= (ever.get(line) ?? 0), `${where}, step ${step}: ${key} has ${n} gone of ${JSON.stringify(line)}, and there were ${ever.get(line) ?? 0}`);
      }
    }
  }
});

test("while a pull request has no more of a line than it was opened with, the sessions give no more of it between them than that", () => {
  // Review only takes lines out and puts them back; sessions are uploaded meanwhile, now and then
  // with a push before the pull request is matched again for them. Each copy is put down to the
  // session that wrote the line in that file and started last, the first report's copies too.
  for (let seed = 1; seed <= 1500; seed++) {
    let state = seed * 7919;
    const random = (n: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const first: Files = { "a.ts": Array.from({ length: 1 + random(3) }, () => 1 + random(2)), "b.ts": Array.from({ length: random(3) }, () => 1 + random(2)) };
    // (In the order they started, whenever they are uploaded.)
    const wrote: (Files | null)[] = Array.from({ length: 4 }, () => null);
    const credit = (files: Files): Files[] => {
      const whose: Files[] = wrote.map(() => ({}));
      for (const [path, hashes] of Object.entries(files)) {
        const left = wrote.map((s) => [...(s?.[path] ?? [])]);
        for (const hash of hashes) {
          for (let i = wrote.length - 1; i >= 0; i--) {
            const at = left[i]!.indexOf(hash);
            if (at < 0) continue;
            left[i]!.splice(at, 1);
            (whose[i]![path] ??= []).push(hash);
            break;
          }
        }
      }
      return whose;
    };
    const most = new Map<string, number>();
    for (const hash of Object.values(first).flat()) most.set(String(hash), (most.get(String(hash)) ?? 0) + 1);
    const pull = new Pull(first);
    let files: Files = first;
    for (let step = 0; step < 12; step++) {
      const what = step === 0 ? 0 : random(4);
      if (what <= 1) {
        // A session that wrote some of its lines is uploaded, in any order of when they started.
        const i = random(wrote.length);
        wrote[i] = Object.fromEntries(Object.entries(first).map(([path, hashes]) => [path, hashes.filter(() => random(3) > 0)]));
      }
      // (And with it, or by itself, a push: some of the lines out, the others in again.)
      if (what >= 1) files = Object.fromEntries(Object.entries(first).map(([path, hashes]) => [path, hashes.filter(() => random(2))]));
      const [has, opened] = [credit(files), credit(first)];
      const credits = Object.fromEntries(
        wrote.map((_, i) => [`s${i}`, { has: has[i]!, opened: opened[i]! }] as const).filter(([, s]) => countLines(lines(s.has)) + countLines(lines(s.opened)) > 0),
      );
      pull.match(files, credits).again(files, credits);
      const given = new Map<string, number>();
      for (const row of pull.rows.values()) for (const hash of Object.values(row.contributed!).flat()) given.set(hash, (given.get(hash) ?? 0) + 1);
      for (const [hash, n] of given) assert.ok(n <= most.get(hash)!, `seed ${seed}, step ${step}: ${n} of ${hash} between them, and it was opened with ${most.get(hash)}`);
    }
  }
});
