import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullFeedback } from "@sessionly/schema";
import { afterMergeLine, afterMergeName, afterMergeTile, timeline, byOf, countFeedback, feedbackLabel, figureBecause, figureShift, historyEvent, localReviewsLine, matchAll, reviewGaps, matchedLine, nameSome, pullCost, pullCostNote, pullHref, pullsCostNote, sessionShare, web, survivingOnce } from "../src/pull.ts";

test("a moved agent figure says what it was, and why", () => {
  const history = [
    { at: "2026-11-17T21:00:00.000Z", agent_lines: 382, change: { reason: "1 session uploaded since: +17 agent lines" } },
    { at: "2026-11-17T19:23:00.000Z", agent_lines: 365, change: { reason: null } },
  ];
  assert.equal(figureBecause("1 session uploaded since: +17 agent lines"), "1 session uploaded since");
  assert.equal(figureBecause("1 session's lines changed: +1 agent lines"), "1 session's lines changed");
  assert.equal(figureBecause("2 new commits"), "2 new commits");
  assert.equal(figureBecause("2 commits removed"), "2 commits removed");
  assert.equal(figureBecause("Action 0.2.0, was 0.1.0"), "Action 0.2.0, was 0.1.0");
  assert.equal(
    figureShift(history, (iso) => (iso === history[0]!.at ? "17 Nov, 21:00" : `wrong ${iso}`), (n) => String(n)),
    "Was 365 until 17 Nov, 21:00: 1 session uploaded since.",
  );
  // The agent lines did not move: the history still says why, and the headline does not.
  assert.equal(
    figureShift(
      [
        { at: "t1", agent_lines: 365, change: { reason: "2 new commits" } },
        { at: "t0", agent_lines: 365, change: { reason: null } },
      ],
      (iso) => iso,
      (n) => String(n),
    ),
    null,
  );
  assert.equal(figureShift([history[1]!], (iso) => iso, (n) => String(n)), null);
  assert.equal(historyEvent("synchronize"), "Pushed");
  assert.equal(historyEvent("match"), "Matched again");
  assert.equal(historyEvent("ready_for_review"), "Marked ready");
  assert.equal(historyEvent("something_else"), "something else");
});

test("a pull request says how current its figures are", () => {
  const when = (iso: string | null) => `<${iso}>`;
  const reported = "2026-11-17T19:13:00.000Z";
  assert.equal(
    matchedLine({ updated_at: reported, matched_at: reported, matchable: true }, when),
    `Last reported by the Action <${reported}>. Sessions uploaded since then are not counted yet.`,
  );
  assert.equal(
    matchedLine({ updated_at: reported, matched_at: "2026-11-17T21:00:00.000Z", matchable: true }, when),
    `Last reported by the Action <${reported}>; its lines were matched to sessions again <2026-11-17T21:00:00.000Z>.`,
  );
  assert.match(matchedLine({ updated_at: reported, matched_at: reported, matchable: false }, when), /count with its next report\.$/);
});

test("the listed pull requests are matched again until none remain", async () => {
  const asked: Record<string, string | undefined>[] = [];
  const answers = [
    { matched: 100, failed: 0, remaining: 3, needs_report: 2, started: "t0" },
    { matched: 3, failed: 0, remaining: 0, needs_report: 2, started: "t0" },
  ];
  const heard: number[] = [];
  const done = await matchAll(async (body) => (asked.push(body), answers[asked.length - 1]!), { repo: "acme/web", state: "merged" }, (n) => heard.push(n));
  assert.deepEqual(done, { matched: 103, needs_report: 2, failed: 0 });
  assert.deepEqual(asked, [
    { repo: "acme/web", state: "merged", started: undefined },
    { repo: "acme/web", state: "merged", started: "t0" },
  ]);
  assert.deepEqual(heard, [100, 103]);
  // a server that gets no further with what remains is not asked forever
  let times = 0;
  const stuck = await matchAll(async () => ((times += 1), { matched: 0, failed: 5, remaining: 5, needs_report: 0, started: "t0" }), {});
  assert.deepEqual([times, stuck.failed], [2, 5]);
});

const one = (kind: PullFeedback["kind"], author: string, more: Partial<PullFeedback> = {}): PullFeedback => ({
  kind,
  url: null,
  author,
  bot: /\[bot\]$/.test(author),
  at: "2026-11-10T12:00:00.000Z",
  ...more,
});

test("a long list of names stops after five", () => {
  assert.equal(nameSome(["acme/web"]), "acme/web");
  assert.equal(nameSome(["a", "b"]), "a and b");
  assert.equal(nameSome(["a", "b", "c", "d", "e", "f", "g"]), "a, b, c, d, e and 2 more");
});

test("a pull request's page is addressed by its repository, in one part, and its number", () => {
  assert.equal(pullHref({ repo: "github.com/acme/web", number: 7 }), "#/pull/github.com%2Facme%2Fweb/7");
});

test("only a web address is followed", () => {
  assert.equal(web("https://github.com/acme/web/pull/7"), "https://github.com/acme/web/pull/7");
  for (const not of [null, undefined, "", "javascript:alert(1)", "data:text/html,x", "/pulls", " https://x"]) assert.equal(web(not), undefined);
});

test("a review or comment is described by what it was, never by what it said", () => {
  assert.equal(feedbackLabel(one("review", "bob", { state: "changes_requested" })), "Review: asked for changes");
  assert.equal(feedbackLabel(one("review", "bob", { state: "approved" })), "Review: approved");
  assert.equal(feedbackLabel(one("review", "bob", { state: null })), "Review: submitted");
  assert.equal(feedbackLabel(one("conversation", "bob")), "Comment in the conversation");
  assert.equal(feedbackLabel(one("inline", "bob", { path: "src/a.ts", line: 12 })), "Comment on src/a.ts:12");
  assert.equal(feedbackLabel(one("inline", "ann", { path: "src/a.ts", line: null, reply: true })), "Reply on src/a.ts");
  assert.equal(feedbackLabel(one("inline", "ann")), "Comment");
});

test("reviews and comments are counted apart for people, for bots and for the author", () => {
  const feedback = [
    one("conversation", "vercel[bot]"),
    one("review", "coderabbitai[bot]", { state: "commented" }),
    one("inline", "coderabbitai[bot]"),
    one("inline", "coderabbitai[bot]"),
    one("inline", "ann", { reply: true }),
    one("review", "bob", { state: "changes_requested" }),
    one("inline", "bob"),
    one("review", "cy", { state: "approved" }),
    // a bot is a bot by what GitHub says of it, whatever it is called
    one("inline", "ann", { bot: true }),
  ];
  assert.deepEqual(feedback.map((f) => byOf(f, "ann")), ["bots", "bots", "bots", "bots", "author", "people", "people", "people", "bots"]);
  assert.deepEqual(countFeedback(feedback, "ann"), [
    { by: "people", names: ["bob", "cy"], reviews: 2, changes_requested: 1, inline: 1, conversation: 0 },
    { by: "bots", names: ["coderabbitai[bot]", "ann", "vercel[bot]"], reviews: 1, changes_requested: 0, inline: 3, conversation: 1 },
    { by: "author", names: ["ann"], reviews: 0, changes_requested: 0, inline: 1, conversation: 0 },
  ]);
  assert.deepEqual(countFeedback([], "ann").map((row) => [row.by, row.names, row.reviews + row.inline + row.conversation]), [
    ["people", [], 0],
    ["bots", [], 0],
    ["author", [], 0],
  ]);
});

test("a pull request's cost is said with what is not sure about it", () => {
  const whole = { usd: 4.1, estimated: false, sessions: 3, sessions_without_cost: 0, sessions_with_cost_partial: 0, sessions_unshared: 0, sessions_unshared_for_good: 0, sessions_uncounted: 0, per_agent_line_usd: 0.1, opened_usd: 4.1, opened_is_floor: false, opened_estimated: false, opened_surviving_lines: 20, per_surviving_line_usd: 0.2, per_surviving_line_is_floor: false };
  assert.equal(pullCost(whole), "$4.10");
  assert.equal(pullCostNote(whole), "$0.10 per agent line; $0.20 per line that survived review");
  // an estimate, and a floor: a session of it has no cost figure
  const floor = { ...whole, estimated: true, sessions_without_cost: 1, opened_usd: null, per_surviving_line_usd: null };
  assert.equal(pullCost(floor), "at least ~$4.10");
  assert.equal(pullCost(floor, "≥ "), "≥ ~$4.10");
  // what a line cost is of the same estimate
  assert.equal(pullCostNote(floor), "~$0.10 per agent line; 1 of 3 sessions has no cost figure");
  // so is one a session of which has a cost that leaves requests out
  const partial = { ...whole, sessions_with_cost_partial: 1, opened_usd: null, per_surviving_line_usd: null };
  assert.equal(pullCost(partial), "at least $4.10");
  // and so is what a line of it cost
  assert.equal(pullCostNote(partial), "at least $0.10 per agent line; the cost of 1 session leaves requests out");
  // lines kept before which they are was, of a session with lines elsewhere: an estimate, and how to make it more
  assert.match(pullCostNote({ ...whole, estimated: true, sessions_unshared: 1 }), /^~\$0\.10 per agent line; .*; 1 session has lines in other pull requests, perhaps these: match those again to share them out$/);
  // a floor and an estimate both
  assert.match(pullCostNote({ ...partial, estimated: true }), /^at least ~\$0\.10 per agent line; /);
  // where one of those pull requests cannot be matched again, the advice is not to match it again
  assert.match(pullCostNote({ ...whole, estimated: true, sessions_unshared: 1, sessions_unshared_for_good: 1 }), /perhaps these: one of those has to be reported again by the Action before they can be shared out$/);
  // what the lines it was opened with cost can be an estimate when the cost now is not
  assert.match(pullCostNote({ ...whole, opened_estimated: true }), /; ~\$0\.20 per line that survived review$/);
  // the lines with a cost went and ones without stayed: not that none is left
  assert.equal(
    pullCostNote({ ...whole, usd: null, per_agent_line_usd: null, sessions: 1, sessions_without_cost: 1, opened_usd: 4, opened_is_floor: true, opened_surviving_lines: 3, per_surviving_line_usd: null }),
    "none of the agent lines it was opened with that have a cost is left: they cost at least $4.00; 3 of sessions with none are; 1 of 1 session has no cost figure",
  );
  // review replaced every agent line it was opened with by others: what the first ones cost is still said
  assert.equal(
    pullCostNote({ ...whole, opened_surviving_lines: 0, per_surviving_line_usd: null }),
    "$0.10 per agent line; none of the agent lines it was opened with is left: they cost $4.10",
  );
  // a session whose share is not known yet, after an upgrade, is not one without a cost figure
  assert.equal(
    pullCostNote({ ...whole, sessions_without_cost: 2, sessions_uncounted: 1, opened_usd: null, per_surviving_line_usd: null }),
    "$0.10 per agent line; 1 of 3 sessions has no cost figure; the share of 1 session is still being worked out since the upgrade",
  );
  // review rounds cost more since it was opened: what its first version cost is said beside what was spent
  assert.equal(
    pullCostNote({ ...whole, usd: 6.1 }),
    "$0.10 per agent line; $0.20 per line that survived review; $4.10 of it for its first version, the rest in review",
  );
  // every line it was opened with went in review, and what was spent on it is what it was
  assert.equal(
    pullCostNote({ ...whole, per_agent_line_usd: null, opened_surviving_lines: 0, per_surviving_line_usd: null }),
    "none of the agent lines it was opened with is left: they cost $4.10",
  );
  // a cost that is not nothing is not shown as nothing
  assert.equal(pullCost({ ...whole, usd: 0.00001 }), "$0.000010");
  // a session with no cost figure makes what the opening lines cost a floor, not what a surviving one of the others did
  assert.equal(pullCostNote({ ...whole, opened_is_floor: true }), "$0.10 per agent line; $0.20 per line that survived review");
  // one whose cost leaves requests out does
  assert.equal(pullCostNote({ ...whole, opened_is_floor: true, per_surviving_line_is_floor: true }), "$0.10 per agent line; at least $0.20 per line that survived review");
  // no figure is a dash and never a cost of nothing
  const none = { usd: null, estimated: false, sessions: 2, sessions_without_cost: 2, sessions_with_cost_partial: 0, sessions_unshared: 0, sessions_unshared_for_good: 0, sessions_uncounted: 0, per_agent_line_usd: null, opened_usd: null, opened_is_floor: false, opened_estimated: false, opened_surviving_lines: null, per_surviving_line_usd: null, per_surviving_line_is_floor: false };
  assert.equal(pullCost(none), "–");
  assert.equal(pullCostNote(none), "2 of 2 sessions have no cost figure");
  assert.equal(pullCostNote({ ...none, sessions: 0, sessions_without_cost: 0 }), "no session was matched to its lines");
  // review took every agent line out: what they cost is still said
  assert.equal(pullCostNote({ ...none, sessions: 0, sessions_without_cost: 0, opened_usd: 4 }), "none of the agent lines it was opened with is left: they cost $4.00");
  // nor, with no session's lines left, that none is when some are
  assert.match(pullCostNote({ ...none, sessions: 0, sessions_without_cost: 0, opened_usd: 4, opened_surviving_lines: 2 }), /that have a cost is left: .*; 2 of sessions with none are$/);
  assert.equal(pullCost(null), "–");
  assert.match(pullCostNote(null), /were not kept/);
  // what a line cost is small, and is not shown as nothing
  assert.equal(pullCostNote({ ...whole, per_agent_line_usd: 0.00004, opened_usd: null, per_surviving_line_usd: null }), "$0.000040 per agent line");
});

test("a session's share of what it cost says what is not sure about it", () => {
  const known = { cost_usd: 6, cost_source: "recorded" } as any;
  const s = { cost_share_usd: 3, uncounted: false, unshared: false, session: known };
  assert.deepEqual(sessionShare(s), { text: "$3.00", why: null });
  // of a cost that is an estimate
  assert.deepEqual(sessionShare({ ...s, session: { ...known, cost_source: "estimated" } }), { text: "~$3.00", why: null });
  // its lines may be counted in another pull request too
  assert.deepEqual(sessionShare({ ...s, unshared: true }), {
    text: "~$3.00",
    why: "it has lines in other pull requests, perhaps these: an estimate until they are shared out",
  });
  // it has a cost, and its share is not known yet: that is said, not left as a bare dash
  assert.deepEqual(sessionShare({ ...s, cost_share_usd: null, uncounted: true }), { text: null, why: "its share is still being worked out since the upgrade" });
  // no cost figure, or deleted since
  assert.deepEqual(sessionShare({ ...s, cost_share_usd: null }), { text: null, why: null });
  assert.deepEqual(sessionShare({ ...s, session: null }), { text: null, why: null });
  // what a share of a line is, is not shown as nothing
  assert.deepEqual(sessionShare({ ...s, cost_share_usd: 0.00004 }), { text: "$0.000040", why: null });
});

test("the lines a cost per surviving line divides by are shown beside how many survived, where they differ, with why", () => {
  const total = { agent_lines_surviving: 14, agent_lines_surviving_once: 10, per_surviving_line_usd: 0.6 };
  const shown = survivingOnce(total);
  assert.equal(shown?.text, "10 counted once for cost");
  assert.match(shown!.why, /survives in all of them while any one keeps it/);
  // and why it can be more than the count beside it
  assert.match(shown!.why, /more where only some are/);
  assert.equal(survivingOnce({ ...total, agent_lines_surviving_once: 7.25 })?.text, "7.25 counted once for cost");
  // the same: nothing to explain
  assert.equal(survivingOnce({ ...total, agent_lines_surviving_once: 14 }), null);
  // no cost per line, likewise
  assert.equal(survivingOnce({ ...total, per_surviving_line_usd: null }), null);
});

test("the cost of several pull requests says what it leaves out", () => {
  const total = { cost_usd: 42, pulls_with_cost_missing: 0, pulls_closed_with_cost: 0, per_surviving_line_usd: 0.25, per_surviving_line_is_floor: false, per_surviving_line_estimated: false };
  assert.equal(pullsCostNote(total), "$0.25 per agent line that survived review; what the sessions that gave them lines cost, review rounds included");
  assert.equal(pullsCostNote({ ...total, pulls_with_cost_missing: 2, per_surviving_line_usd: null }), "not known in full for 2 pull requests");
  // a session of the lines they were opened with has no cost: what a surviving line cost is a floor
  assert.match(pullsCostNote({ ...total, per_surviving_line_is_floor: true }), /^at least \$0\.25 per agent line that survived review; /);
  // the ones closed without merging have a cost below and none here, which is said
  assert.match(pullsCostNote({ ...total, pulls_closed_with_cost: 2 }), /; without the 2 closed unmerged$/);
  assert.equal(pullsCostNote({ ...total, cost_usd: null, per_surviving_line_usd: null, pulls_closed_with_cost: 1 }), "without the 1 closed unmerged");
  assert.match(pullsCostNote({ ...total, per_surviving_line_estimated: true }), /^~\$0\.25 per agent line that survived review; /);
  assert.match(pullsCostNote({ ...total, cost_usd: null, pulls_with_cost_missing: 1 }), /^\$0\.25 per agent line that survived review; not known in full for 1 pull request: /);
  // no figure: because nothing was matched, or because what was matched has none
  assert.equal(pullsCostNote({ ...total, cost_usd: null, per_surviving_line_usd: null }), "no session was matched to their lines");
  assert.equal(pullsCostNote({ ...total, cost_usd: null, pulls_with_cost_missing: 1, per_surviving_line_usd: null }), "not known in full for 1 pull request: their sessions have no cost figure, or were not kept at their last report");
});

test("a count after merging, in plain words", () => {
  const day = 86_400;
  const thirty = { checkpoint: "30d" as const, agent_lines: 520, surviving: 498, age_seconds: 30 * day + 60 };
  const seven = { checkpoint: "7d" as const, agent_lines: 520, surviving: 511, age_seconds: 9 * day };
  assert.equal(afterMergeLine(thirty), "30 days after merge: 498 of 520 agent lines still there");
  assert.equal(afterMergeLine(seven), "7 days after merge: 511 of 520 agent lines still there (counted on day 9)");
  assert.equal(afterMergeLine({ ...seven, agent_lines: 1, surviving: 1, age_seconds: 7 * day }), "7 days after merge: 1 of 1 agent line still there");
  assert.equal(afterMergeName(seven), "7 days after merge");
  assert.equal(afterMergeName(thirty), "30 days after merge");

  const share = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
  const now = Date.parse("2026-12-20T00:00:00Z");
  assert.deepEqual(afterMergeTile([seven, thirty], null, share), { value: "96%", part: 498 / 520, note: "498 of 520 agent lines; 98% at 7 days" });
  assert.deepEqual(afterMergeTile([{ ...thirty, age_seconds: 34 * day }], null, share).note, "498 of 520 agent lines, counted on day 34");
  assert.deepEqual(afterMergeTile([seven], null, share), { value: "–", part: null, note: "not 30 days yet; at 7 days 98%, 511 of 520 agent lines" });
  assert.equal(afterMergeTile([seven], "2026-12-08T00:00:00Z", share, String, now).note, "not 30 days yet; at 7 days 98%, 511 of 520 agent lines");
  // on day 40 it is not waiting for day 30
  assert.equal(afterMergeTile([seven], "2026-11-10T00:00:00Z", share, String, now).note, "not counted at 30 days; at 7 days 98%, 511 of 520 agent lines");
  assert.equal(afterMergeTile([], "2026-12-17T00:00:00Z", share, String, now).note, "counted 7 and 30 days after it was merged");
  assert.match(afterMergeTile([], "2026-11-17T00:00:00Z", share, String, now).note, /^not counted: a scheduled run of the Action/);
});

test("reports and the counts made after merging are one list by time, and stay two kinds of thing", () => {
  const history = [{ at: "2026-11-20T10:00:00Z", event: "match" }, { at: "2026-11-01T10:00:00Z", event: "closed" }];
  const counts = [{ at: "2026-11-08T10:00:00Z", checkpoint: "7d" }, { at: "2026-12-01T10:00:00Z", checkpoint: "30d" }];
  assert.deepEqual(
    timeline(history, counts).map((row) => row.report?.event ?? row.count?.checkpoint),
    ["30d", "match", "7d", "closed"],
  );
  // at the same moment, the report comes first and the count after it
  const together = [{ at: "2026-11-20T10:00:00Z", checkpoint: "7d" }, ...counts];
  assert.deepEqual(
    timeline(history, together).map((row) => row.report?.event ?? row.count?.checkpoint),
    ["30d", "match", "7d", "7d", "closed"],
  );
  assert.deepEqual(timeline(history, undefined).map((row) => row.report?.event), ["match", "closed"]);
  assert.deepEqual(timeline([], []), []);
});

test("each review run says how long after the one before it started", () => {
  const at = (time: string | null) => ({ at: time && `2026-11-10T${time}:00Z` });
  assert.deepEqual(reviewGaps([at("09:10"), at("09:40"), at(null), at("11:00"), at("11:00")]), [null, 30 * 60_000, null, null, 0]);
  assert.deepEqual(reviewGaps([]), []);
});

test("a pull request's local review runs in a sentence, and what is not known said", () => {
  const none = { runs: 0, cloud: 0, by_effort: {}, findings: null, cost_usd: null, sessions_unknown: 0, shared_with: 0 };
  assert.equal(localReviewsLine(null, null), "No session of it is known.");
  assert.equal(localReviewsLine(none, 10), "No review command ran in its sessions.");
  assert.equal(
    localReviewsLine({ ...none, runs: 4, cloud: 1, by_effort: { high: 1, xhigh: 2 }, cost_usd: 12.4 }, 85.43),
    "Reviewed 4 times before and during review (2 xhigh, 1 high), 1 of them in the cloud. Review subagents: $12.40 of the $85.43.",
  );
  assert.equal(
    localReviewsLine({ ...none, runs: 1, findings: 3, shared_with: 2, sessions_unknown: 1 }, null),
    "Reviewed once before and during review. 3 findings reported. Some of those ran in sessions it shares with 2 other pull requests, and name none: they are counted on each. 1 of its sessions was from an older Sessionly or an agent whose review commands are not read: not known for it.",
  );
});
