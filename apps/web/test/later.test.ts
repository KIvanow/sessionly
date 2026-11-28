import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalWords, ciOf, ciWords, commitHref, headsOf, laterKind, mergeCiWords, laterOf, laterTile, laterWindow, MIN_PULLS, ofKnown, outcomeCiRows, outcomeRows, perThousand, reachedOf, revertedShare, signalName, tenths } from "../src/pull.ts";

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

test("the agents' share of a later commit's lines is shown to a tenth, and a whole number as one", () => {
  assert.deepEqual([tenths(2), tenths(1.5), tenths(0.34), tenths(1234.56)], ["2", "1.5", "0.3", "1,234.6"]);
});

test("what CI said of a commit is read as sent, said in a few words, and not known when it is no answer", () => {
  assert.equal(ciOf(null), null);
  assert.equal(ciOf({ state: "red" }), null);
  assert.deepEqual(ciOf({ state: "failure", failed: 1, total: 3, cancelled: 0, checked_at: "2026-11-28T00:00:00Z", failed_checks: ["tests", 4] }), {
    state: "failure", failed: 1, total: 3, cancelled: 0, checked_at: "2026-11-28T00:00:00Z", failed_checks: ["tests"],
  });
  assert.deepEqual(ciOf({ state: "pending", failed: "1" }), { state: "pending", failed: null, total: null, cancelled: null, checked_at: null });
  assert.equal(ciWords(ciOf({ state: "failure", failed: 1, total: 3 })), "red, 1 of 3 checks failed");
  assert.equal(ciWords(ciOf({ state: "failure" })), "red");
  assert.equal(ciWords(ciOf({ state: "success", total: 1 })), "green, 1 check");
  assert.equal(ciWords(ciOf({ state: "pending" })), "still running");
  assert.equal(ciWords(ciOf({ state: "none", cancelled: 2 })), "none to go by, 2 checks cancelled");
  assert.equal(ciWords(ciOf({ state: "none", cancelled: 0 })), "none to go by");
  assert.equal(ciWords(null), "not known");
  assert.equal(ciWords(ciOf({ state: "unknown" })), "not read");
  // the merge, as a sentence
  assert.equal(mergeCiWords(ciOf({ state: "failure", failed: 1, total: 3, failed_checks: ["tests"] }), true), "The base branch was red: 1 of 3 checks failed (tests).");
  assert.equal(mergeCiWords(ciOf({ state: "failure" }), true), "The base branch was red: checks failed.");
  assert.equal(mergeCiWords(ciOf({ state: "success", total: 1 }), true), "The base branch was green (1 check).");
  assert.equal(mergeCiWords(ciOf({ state: "pending" }), true), "Its checks were still running when last read.");
  assert.equal(mergeCiWords(ciOf({ state: "none", cancelled: 2 }), true), "No checks to go by on the commit it was merged as: 2 checks cancelled.");
  assert.equal(mergeCiWords(ciOf({ state: "none" }), true), "No checks to go by on the commit it was merged as.");
  assert.match(mergeCiWords(null, true), /^Not read yet/);
  assert.match(mergeCiWords(ciOf({ state: "unknown" }), true), /^Not read yet/);
  assert.match(mergeCiWords(null, false), /^Not known: .*before 0\.5\.0/);
  assert.match(mergeCiWords(ciOf({ state: "failure" }), false), /^Not known/);
  assert.deepEqual([arrivalWords(true), arrivalWords(false), arrivalWords(null), arrivalWords(undefined)], ["red", "green", "–", "–"]);
  // heads: a server from before them sends none, which is not an empty list
  assert.equal(headsOf(undefined), undefined);
  assert.deepEqual(headsOf([{ sha: "a".repeat(40), first_reported_at: "2026-11-01T00:00:00Z", ci: { state: "success", total: 2 } }, { ci: {} }, null]), [
    { sha: "a".repeat(40), first_reported_at: "2026-11-01T00:00:00Z", ci: { state: "success", failed: null, total: 2, cancelled: null, checked_at: null } },
  ]);
  assert.equal(headsOf([{ sha: "b" }])![0]!.ci.state, "unknown");
  assert.equal(commitHref("https://github.com/acme/web/pull/7", "abc"), "https://github.com/acme/web/commit/abc");
  assert.equal(commitHref("https://git.example.com/acme/web/pull/7#x", "abc"), "https://git.example.com/acme/web/commit/abc");
  assert.equal(commitHref("https://github.com/acme/web", "abc"), null);
  assert.equal(commitHref(null, "abc"), null);
});

test("the CI columns of the summary come from what the server sent, and are left out when it sent none", () => {
  const ci = { heads_with_ci: 4, heads_failed: 1, sessions_with_ci: 3, red_on_arrival_sessions: 2, pulls_merge_known: 2, pulls_merge_failed: 1, pulls_ci_unknown: 5 };
  assert.equal(outcomeCiRows(null), null);
  assert.equal(outcomeCiRows({ groups: [], total: {} }), null);
  const rows = outcomeCiRows({ groups: [{ key: "codex", ci }, { key: "cursor" }, { ci }], total: { ci: { ...ci, heads_failed: "x" } } });
  assert.deepEqual([...rows!.groups.keys()], ["codex"]);
  assert.deepEqual(rows!.groups.get("codex"), ci);
  assert.deepEqual([rows!.total.heads_failed, rows!.total.pulls_ci_unknown], [0, 5]);
  assert.equal(ofKnown(1, 3), "33% (1 of 3)");
  assert.equal(ofKnown(0, 0), "–");
  assert.equal(ofKnown(0, 2), "0% (0 of 2)");
});
