import assert from "node:assert/strict";
import { test } from "node:test";
import * as f from "../src/format.ts";

test("numbers and money", () => {
  assert.equal(f.count(1284.4), "1,284");
  assert.equal(f.compact(9_999), "9,999");
  assert.equal(f.compact(12_940), "12.9K");
  assert.equal(f.compact(40_386), "40.4K");
  assert.equal(f.compact(250_000), "250K");
  assert.equal(f.compact(4_200_000), "4.2M");
  assert.equal(f.usd(0.0042), "$0.0042");
  // what one line cost is shown to the places that say something; other costs as they were
  assert.equal(f.usdEach(0.00004), "$0.000040");
  assert.equal(f.usdEach(0.0042), "$0.0042");
  assert.equal(f.usdEach(1.5), "$1.50");
  assert.equal(f.usdEach(0.0149), "$0.015");
  assert.equal(f.usdEach(0.1), "$0.10");
  assert.equal(f.usdEach(0.00999), "$0.010");
  assert.equal(f.usd(0.00004), "$0.0000");
  assert.equal(f.usd(0), "$0.00");
  assert.equal(f.usd(5099.957), "$5,099.96");
  assert.equal(f.usdCompact(4.2), "$4.20");
  assert.equal(f.usdCompact(1284), "$1,284");
  assert.equal(f.usdCompact(12_940), "$12.9K");
  assert.equal(f.cost(null, null), "–");
  assert.equal(f.cost(2, "recorded"), "$2.00");
  assert.equal(f.cost(2, "partial_estimate"), "~$2.00");
});

test("agents and models", () => {
  assert.equal(f.toolName("claude-code"), "Claude Code");
  assert.equal(f.toolName("grok"), "Grok");
  assert.equal(f.toolName("opencode"), "OpenCode");
  assert.equal(f.toolName("some-new-agent"), "some-new-agent");
  assert.equal(f.modelName("claude-opus-5-5"), "opus-5-5");
  assert.equal(f.modelName("grok-4.7-build"), "grok-4.7-build");
  assert.equal(f.activeTime(0), "–");
  assert.equal(f.activeTime(7_000), "7s");
  assert.equal(f.groupCost({ cost_usd: 0, sessions: 3, sessions_without_cost: 3 }), "–");
  assert.equal(f.groupCost({ cost_usd: 2, sessions: 3, sessions_without_cost: 1 }), "$2.00");
  assert.equal(f.groupCost({ cost_usd: 0, sessions: 0, sessions_without_cost: 0 }), "$0.00");
});

test("time and shares", () => {
  assert.equal(f.duration(7_000), "7s");
  assert.equal(f.duration(843_000), "14m 3s");
  assert.equal(f.duration(203_760_000), "56h 36m");
  assert.equal(f.duration(-5), "0s");
  assert.equal(f.average(3, 2), "1.5");
  assert.equal(f.average(4, 2), "2");
  assert.equal(f.average(1, 3), "0.3");
  assert.equal(f.average(1, 0), "–");
  assert.equal(f.shareOf(660, 663), "99%");
  assert.equal(f.shareOf(663, 663), "100%");
  assert.equal(f.shareOf(1, 1000), "1%");
  assert.equal(f.shareOf(0, 10), "0%");
  assert.equal(f.shareOf(5, 10), "50%");
  assert.equal(f.shareOf(0, 0), "–");
  assert.equal(f.percent(0.4183), "42%");
  assert.equal(f.percent(null), "–");
  assert.equal(f.share(1, 0), null);
  const r = { files_measured: 4, files_rewritten: 1, lines_added: 40, lines_surviving: 30 };
  assert.equal(f.rewriteRate(r), 0.25);
  assert.equal(f.linesKept(r), 0.75);
  assert.equal(f.rewriteRate(null), null);
  assert.equal(f.linesKept({ ...r, lines_added: 0 }), null);
  assert.equal(f.dayLabel("2026-11-13"), "Nov 13");
  assert.equal(f.dayLabel("(unknown)"), "(unknown)");
  assert.equal(f.dateTime(null), "–");
  assert.equal(f.dateTime("not a date"), "–");
});

test("repository names", () => {
  assert.equal(f.repoName("github.com/acme/web"), "acme/web");
  assert.equal(f.repoName("~/src/thing"), "src/thing");
  assert.equal(f.repoName("solo"), "solo");
  assert.equal(f.repoName("~"), "home directory");
  assert.equal(f.repoName(null), "–");
});

test("the cost series is continuous and switches to weeks for long ranges", () => {
  const day = (key: string, cost_usd: number) => ({ key, cost_usd, sessions: 1 });
  const days = f.costSeries([day("2026-11-03", 2), day("2026-11-01", 1), day("(unknown)", 9)]);
  assert.deepEqual(
    days.map((b) => [b.start, b.cost_usd, b.sessions, b.span]),
    [["2026-11-01", 1, 1, "day"], ["2026-11-02", 0, 0, "day"], ["2026-11-03", 2, 1, "day"]],
  );
  assert.deepEqual(f.costSeries([]), []);

  // 2026-06-03 is a Wednesday; its week starts Monday 2026-06-01.
  const weeks = f.costSeries([day("2026-06-03", 1), day("2026-06-07", 2), day("2026-06-08", 4), day("2026-11-13", 8)]);
  assert.equal(weeks[0]!.span, "week");
  assert.deepEqual([weeks[0]!.start, weeks[0]!.cost_usd, weeks[0]!.sessions], ["2026-06-01", 3, 2]);
  assert.deepEqual([weeks[1]!.start, weeks[1]!.cost_usd], ["2026-06-08", 4]);
  assert.equal(weeks[weeks.length - 1]!.cost_usd, 8);
  assert.ok(weeks.length <= 26);
  assert.equal(weeks.reduce((sum, b) => sum + b.cost_usd, 0), 15);
});

test("axis ticks are round and cover the maximum", () => {
  assert.deepEqual(f.ticks(140), [0, 50, 100, 150]);
  assert.deepEqual(f.ticks(1), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(f.ticks(0), [0, 1]);
  const t = f.ticks(2059.68);
  assert.ok(t[t.length - 1]! >= 2059.68 && t.length <= 6, String(t));
});

test("what was kept at a fixed age, and of how many sessions", () => {
  const kept = { lines_added: 200, lines_surviving: 182, sessions_reached: 12, sessions_total: 40 };
  assert.equal(f.keptAt(kept), "91%");
  assert.equal(f.keptOf(kept), "12 of 40 sessions");
  // no session has reached the age: a dash, and still how many there are
  const none = { lines_added: 0, lines_surviving: 0, sessions_reached: 0, sessions_total: 1 };
  assert.equal(f.keptAt(none), "–");
  assert.equal(f.keptOf(none), "0 of 1 session");
  assert.equal(f.keptAt(undefined), "–");
  assert.equal(f.keptOf(null), "");
});

test("what later commits did: of the sessions counted at an age, and per session in a few words", () => {
  const at = { sessions_reached: 8, sessions_total: 20, lines_tracked: 400, sessions_with_fix: 2, fix_commits: 3, likely_fix_commits: 1, lines_fixed: 6, sessions_reverted: 1, revert_commits: 1, lines_reverted: 40, rework_commits: 4, lines_reworked: 9, by_agent: [] };
  assert.equal(f.fixedAt(at), "25%");
  // which agents' sessions made the fixes, and the rest
  assert.equal(f.fixesBy(at), "");
  assert.equal(f.fixesBy({ ...at, by_agent: [{ source: "cursor", fix_commits: 2 }, { source: "codex", fix_commits: 0 }] }), "2 by Cursor, 1 by no agent known");
  assert.equal(f.fixesBy({ fix_commits: 1, by_agent: [{ source: "claude-code", fix_commits: 1 }] }), "1 by Claude Code");
  // an agent of any name is named as it is, whatever an object has of its own
  assert.equal(f.fixesBy({ fix_commits: 1, by_agent: [{ source: "constructor", fix_commits: 1 }] }), "1 by constructor");
  assert.equal(f.revertedAt(at), "13%");
  assert.equal(f.keptOf(at), "8 of 20 sessions");
  const none = { ...at, sessions_reached: 0 };
  assert.equal(f.fixedAt(none), "–");
  assert.equal(f.revertedAt(undefined), "–");

  // what a server from before outcomes kept may be anything: nothing counted, and no failure
  for (const odd of ["none", {}, [null, 5]]) assert.deepEqual(f.laterAges(odd as any).map((a) => a.counted), [false, false, false]);
  // and an age of anything: its counts numbers, and of its agents the entries that are ones
  const odd = f.laterAges([
    { checkpoint: "1d", fix_commits: 1, by_agent: [null, 5, "cursor", { source: "cursor", fix_commits: 1 }] },
    { checkpoint: "7d", fix_commits: 1, by_agent: "x" },
    { checkpoint: "30d", fix_commits: "3", rework_commits: {}, revert_commits: Infinity, relanded: "yes", age_seconds: "x" },
  ] as any);
  assert.deepEqual(
    odd.map((a) => [a.name, a.later, a.late, a.counted]),
    [
      ["1d", "1 fix (1 by Cursor)", null, true],
      ["7d", "1 fix", null, true],
      ["30d", "nothing", null, true],
    ],
  );

  const day = 86_400;
  const ages = f.laterAges([
    { checkpoint: "7d", fix_commits: 2, rework_commits: 1, age_seconds: 9 * day, by_agent: [{ source: "cursor", fix_commits: 1 }] },
    { checkpoint: "1d", age_seconds: day },
    { checkpoint: "30d", revert_commits: 1, relanded: true, age_seconds: 30 * day },
  ]);
  assert.deepEqual(
    ages.map((a) => [a.name, a.later, a.late]),
    [
      ["1d", "nothing", null],
      ["7d", "2 fixes (1 by Cursor, 1 by no agent known), 1 rework", 9],
      ["30d", "reverted, relanded", null],
    ],
  );
  assert.deepEqual(f.laterAges(undefined).map((a) => a.later), ["–", "–", "–"]);
  // an agent named with anything but a string is none, and no failure
  const unnamed = f.laterAges([{ checkpoint: "7d", fix_commits: 1, by_agent: [{ source: { toString: 1 }, fix_commits: 1 }, { source: ["cursor"], fix_commits: 1 }] }] as any);
  assert.deepEqual(unnamed.map((a) => a.later), ["–", "1 fix", "–"]);
});

test("a session's lines at each age: a dash where it was not measured, and the day where that was late", () => {
  const day = 86_400;
  const ages = f.keptAges([
    { checkpoint: "7d", added: 20, surviving: 15, age_seconds: 7 * day + 3600 },
    { checkpoint: "1d", added: 20, surviving: 19, age_seconds: 3 * day },
  ]);
  assert.deepEqual(ages.map((age) => [age.name, age.kept, age.late, age.lines]), [
    ["1d", "95%", 3, 20],
    ["7d", "75%", null, 20],
    ["30d", "–", null, null],
  ]);
  assert.deepEqual(f.keptAges(undefined).map((age) => age.kept), ["–", "–", "–"]);
  // what a server from before checkpoints kept may be anything: nothing measured, and no failure
  for (const odd of ["none", {}, [null, 5]]) assert.deepEqual(f.keptAges(odd as any).map((age) => age.lines), [null, null, null]);
  // and an age of anything: its counts numbers
  const odd = f.keptAges([
    { checkpoint: "1d", added: {}, surviving: 3, age_seconds: "x" },
    { checkpoint: "7d", added: 20, surviving: "15", age_seconds: Infinity },
  ] as any);
  assert.deepEqual(odd.map((age) => [age.name, age.kept, age.late, age.lines]), [
    ["1d", "–", null, 0],
    ["7d", "0%", null, 20],
    ["30d", "–", null, null],
  ]);
  assert.equal(f.takenLate(30 * day, 30), null);
  assert.equal(f.takenLate(31 * day, 30), 31);
});
