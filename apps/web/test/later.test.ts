import assert from "node:assert/strict";
import { test } from "node:test";
import { laterKind, laterOf, laterTile, laterWindow, MIN_PULLS, outcomeRows, perThousand, reachedOf, revertedShare, signalName } from "../src/pull.ts";

const window = (more: Record<string, unknown> = {}) => ({
  reached: true,
  reverted: false,
  revert_commits: 0,
  agent_lines_reverted: 0,
  fix_commits: 0,
  likely_fix_commits: 0,
  agent_lines_fixed: 0,
  rework_commits: 0,
  agent_lines_reworked: 0,
  ...more,
});

test("what later commits did is said in a few words, a revert relanded as such", () => {
  assert.equal(laterWindow(window()), "nothing");
  assert.equal(laterWindow(window({ revert_commits: 1, reverted: true, fix_commits: 2, rework_commits: 1 })), "reverted, 2 fixes, 1 rework");
  assert.equal(laterWindow(window({ revert_commits: 1, reverted: false })), "reverted, relanded");
  assert.equal(laterKind({ kind: "fix", likely: true, relanded_at: null }), "likely fix");
  assert.equal(laterKind({ kind: "fix", likely: false, relanded_at: null }), "changed by a fix");
  assert.equal(laterKind({ kind: "revert", likely: false, relanded_at: "2026-11-01T00:00:00Z" }), "revert, relanded");
  assert.equal(signalName("revert_sha"), "names the merge commit");
  assert.equal(signalName("something_new"), "something_new");
});

test("the later-commits tile waits for the age to be read, and says why", () => {
  const now = Date.parse("2026-11-28T00:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const outcomes = (seven: boolean, thirty: boolean, scanned: string | null = ago(0)) => ({
    scanned_until: scanned,
    windows: { "1d": window(), "7d": window({ reached: seven, fix_commits: 1 }), "30d": window({ reached: thirty, fix_commits: 2 }) },
    commits: [],
  });
  assert.deepEqual(laterTile(null, ago(40), now), { value: "–", note: "not read: a scheduled run of the Action 0.5.0 or later reads them" });
  assert.equal(laterTile(outcomes(false, false), ago(3), now).note, "read 1, 7 and 30 days after it was merged");
  assert.deepEqual(laterTile(outcomes(true, false), ago(10), now), { value: "1 fix", note: "in the 7 days after merging; 30 days not read yet" });
  assert.deepEqual(laterTile(outcomes(true, true), ago(40), now), { value: "2 fixes", note: "in the 30 days after merging; by day 7: 1 fix" });
  assert.equal(laterTile(outcomes(false, false, null), ago(10), now).note, "not read yet: a scheduled run of the Action reads them");
});

test("rates per 1,000 agent lines are shown only from enough pull requests", () => {
  const at = (reached: number, lines: number) => ({ pulls_reached: reached, pulls_total: reached + 2, agent_lines: lines, pulls_reverted: 1 });
  assert.equal(reachedOf(at(3, 100)), "3 of 5");
  assert.equal(perThousand(2, at(0, 0)), "–");
  assert.equal(perThousand(2, at(MIN_PULLS - 1, 1000)), "too few");
  assert.equal(perThousand(3, at(MIN_PULLS, 2000)), "1.5");
  assert.equal(revertedShare(at(4, 10)), "1 (too few)");
  assert.equal(revertedShare(at(20, 10)), "5% (1)");
  assert.equal(revertedShare(at(0, 0)), "–");
});

test("later commits a server sent that are not an answer break neither the page nor the summary", () => {
  assert.equal(laterOf(undefined), null);
  assert.equal(laterOf({ scanned_until: null, commits: [] }), null);
  assert.equal(laterOf({ windows: { "1d": window(), "7d": window() }, commits: [] }), null);
  const read = laterOf({
    scanned_until: 5,
    windows: { "1d": window(), "7d": { reached: "yes", fix_commits: "2" }, "30d": window({ rework_commits: 1 }) },
    commits: [null, { sha: "a1" }, { sha: "b2", landed_at: "2026-11-01T00:00:00Z", kind: "odd", signals: ["fix_message", 3], sessions: [{ session_id: "s" }, { machine_id: "m", source: "codex", session_id: "s", lines: 2 }] }],
  });
  assert.equal(read!.scanned_until, null);
  assert.deepEqual([read!.windows["7d"].reached, read!.windows["7d"].fix_commits, read!.windows["30d"].rework_commits], [false, 0, 1]);
  assert.deepEqual(read!.commits.map((c) => [c.sha, c.kind, c.signals, c.sessions.length, c.lines, c.counted]), [["b2", "rework", ["fix_message"], 1, 0, false]]);
  assert.equal(laterTile(laterOf({}), "2026-10-01T00:00:00Z").value, "–");

  const at = { pulls_reached: 2, pulls_total: 3, agent_lines: 10 };
  assert.equal(outcomeRows(null, "7d"), null);
  assert.equal(outcomeRows({ groups: [] }, "7d"), null);
  assert.equal(outcomeRows({ groups: [], total: {} }, "7d"), null);
  const rows = outcomeRows({ groups: [{ key: "codex", outcomes_7d: at }, { key: "cursor" }, "x", { outcomes_7d: at }], total: { outcomes_7d: { ...at, fix_commits: "1" } } }, "7d");
  assert.deepEqual(rows!.groups.map((g) => [g.key, g.at.pulls_reached, g.at.fix_commits]), [["codex", 2, 0]]);
  assert.deepEqual([rows!.total.pulls_total, rows!.total.fix_commits], [3, 0]);
});
