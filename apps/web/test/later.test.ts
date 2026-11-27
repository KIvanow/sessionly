import assert from "node:assert/strict";
import { test } from "node:test";
import { laterKind, laterTile, laterWindow, MIN_PULLS, perThousand, reachedOf, revertedShare, signalName } from "../src/pull.ts";

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
