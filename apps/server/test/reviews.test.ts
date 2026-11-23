import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullFeedback, RoundAuthor } from "@sessionly/schema";
import { type ReportAt, reviewSplit, summarizeReviewers } from "../src/reviews.ts";

// Minutes after the pull request was opened.
const at = (minutes: number) => new Date(Date.parse("2026-11-10T12:00:00Z") + minutes * 60_000).toISOString();
const opened: ReportAt = { at: at(0), event: "opened", commits: 1 };
const push = (minutes: number, commits = 2): ReportAt => ({ at: at(minutes), event: "synchronize", commits });

const BOT = "coderabbitai[bot]";
const inline = (author: string, minutes: number, reply = false): PullFeedback => ({
  kind: "inline", url: null, author, bot: author.endsWith("[bot]"), at: at(minutes), path: "src/a.ts", line: 1, reply,
});
const review = (author: string, minutes: number, state = "commented"): PullFeedback => ({
  kind: "review", url: null, author, bot: author.endsWith("[bot]"), at: at(minutes), state,
});
const said = (author: string, minutes: number): PullFeedback => ({
  kind: "conversation", url: null, author, bot: author.endsWith("[bot]"), at: at(minutes),
});

type More = { firstEvent?: string; total?: number | null; rounds?: number; said?: RoundAuthor[][] | null; createdAt?: string | null; author?: string };
// As an Action that does not say whose feedback each round followed has it, unless `said`.
const split = (feedback: PullFeedback[] | null, reports: ReportAt[], more: More = {}) =>
  reviewSplit({
    author: more.author ?? "ann",
    feedback,
    feedbackTotal: more.total === undefined ? (feedback?.length ?? null) : more.total,
    reviewRounds: more.rounds ?? 0,
    roundAuthors: more.said ?? null,
    createdAt: more.createdAt === undefined ? at(0) : more.createdAt,
    firstEvent: more.firstEvent ?? "opened",
    reports,
  });
const who = (...logins: string[]): RoundAuthor[] => logins.map((author) => ({ author, bot: author.endsWith("[bot]") }));
const known = (rounds: { bots: number; people: number; both: number }, authors: RoundAuthor[][], by: "commits" | "pushes" = "pushes") => ({
  rounds, round_authors: authors, counted_by: by, unknown: null,
});
const unknown = (why: string) => ({ rounds: null, round_authors: null, counted_by: null, unknown: why });
const rest = ({ reviewers: _, ...others }: ReturnType<typeof reviewSplit>) => others;

test("no reviews and comments: no reviewers and no rounds", () => {
  assert.deepEqual(split([], [opened, push(10)]), { reviewers: [], ...known({ bots: 0, people: 0, both: 0 }, [], "commits") });
});

test("the Action says whose feedback each round followed: that is the split, whatever the reports say", () => {
  const feedback = [inline(BOT, 5), review("bob", 6), inline(BOT, 30)];
  const said = [who(BOT), who("bob", BOT), who("bob")];
  // first reported at a push, its history gone, only the latest comments kept: the commits' own times are not the server's to doubt
  const found = split(feedback, [], { rounds: 3, said, firstEvent: "synchronize", total: 2500, createdAt: null });
  assert.deepEqual(rest(found), known({ bots: 1, people: 1, both: 1 }, said, "commits"));
  assert.deepEqual(found.reviewers.map((r) => r.author), [BOT, "bob"]);
  // not as many as the rounds it counted: taken as not said
  assert.deepEqual(rest(split(feedback, [opened], { rounds: 2, said })), unknown("pushes_not_seen"));
  assert.deepEqual(rest(split([], [opened], { rounds: 0, said: [] })), known({ bots: 0, people: 0, both: 0 }, [], "commits"));
  // no round at all is none, whoever counted and whatever else is not known: an older Action, first seen at a push, comments cut
  const none = split([inline(BOT, 5)], [push(10)], { rounds: 0, firstEvent: "synchronize", total: 2500 });
  assert.deepEqual(rest(none), known({ bots: 0, people: 0, both: 0 }, [], "commits"));
});

test("without it, a round is of bots, of people or of both, by whose feedback came before the push", () => {
  assert.deepEqual(rest(split([inline(BOT, 5), inline(BOT, 6)], [opened, push(10)], { rounds: 1 })), known({ bots: 1, people: 0, both: 0 }, [who(BOT)]));
  assert.deepEqual(rest(split([review("bob", 5, "changes_requested")], [opened, push(10)], { rounds: 1 })), known({ bots: 0, people: 1, both: 0 }, [who("bob")]));
  assert.deepEqual(rest(split([inline(BOT, 5), review("bob", 6)], [opened, push(10)], { rounds: 1 })), known({ bots: 0, people: 0, both: 1 }, [who("bob", BOT)]));
  // one of each, each before its own push
  const each = split([inline(BOT, 5), review("bob", 15), inline("cy", 16)], [opened, push(10), push(20, 3)], { rounds: 2 });
  assert.deepEqual(rest(each), known({ bots: 1, people: 1, both: 0 }, [who(BOT), who("bob", "cy")]));
  // a login is a bot when anything of its says so
  const mixed = [{ ...inline("renovate", 5), bot: true }, inline("renovate", 6)];
  assert.deepEqual(rest(split(mixed, [opened, push(10)], { rounds: 1 })), known({ bots: 1, people: 0, both: 0 }, [[{ author: "renovate", bot: true }]]));
});

test("feedback with no push after it is no round, and two pushes after one review are one", () => {
  // (told from the reports' times, none is found where the Action counted one: nothing is said)
  assert.equal(split([review("bob", 15)], [opened, push(10)], { rounds: 1 }).unknown, "pushes_not_seen");
  assert.deepEqual(split([review("bob", 5)], [opened, push(10), push(20, 3)], { rounds: 1 }).rounds, { bots: 0, people: 1, both: 0 });
  // at the very moment of the push, it is before it
  assert.deepEqual(split([review("bob", 10)], [opened, push(10)], { rounds: 1 }).rounds, { bots: 0, people: 1, both: 0 });
});

test("a push is the report of one; commits that came with any other report were pushed nobody saw when", () => {
  const feedback = [review("bob", 5)];
  // the pull request being opened is not a push, and neither is its being matched again or approved
  assert.equal(split(feedback, [opened, { at: at(10), event: "match", commits: 1 }, { at: at(11), event: "review", commits: 1 }], { rounds: 1 }).unknown, "pushes_not_seen");
  // a report of a push, whether or not it has more commits than before (one amended over the last)
  assert.deepEqual(split(feedback, [opened, push(10)], { rounds: 1 }).rounds, { bots: 0, people: 1, both: 0 });
  assert.deepEqual(split(feedback, [opened, push(10, 1)], { rounds: 1 }).rounds, { bots: 0, people: 1, both: 0 });
  // the report of the push never came, and a review's report is the first with its commit: a bot commented on that commit
  // meanwhile, and would be put before the push it came after. As many rounds as the Action counted, and still not said.
  const late = [review("bob", 5), inline(BOT, 12)];
  assert.deepEqual(rest(split(late, [opened, { at: at(15), event: "review", commits: 2 }], { rounds: 1 })), unknown("pushes_not_seen"));
  assert.deepEqual(rest(split(feedback, [opened, { at: at(10), event: "closed", commits: 2 }], { rounds: 1 })), unknown("pushes_not_seen"));
});

test("the rounds the reports' times come to are kept only when they are as many as the Action counted", () => {
  // an amended commit pushed over the last moved no figure and left no report: three rounds by commit, none seen
  assert.deepEqual(rest(split([review("bob", 5), review("bob", 15), review("bob", 25)], [opened], { rounds: 3 })), unknown("pushes_not_seen"));
  // a bot commented on the new commits while the report of their push was on its way: a round the Action does not count
  const during = [inline("bob", 5), inline(BOT, 19)];
  assert.deepEqual(rest(split(during, [opened, push(10), push(20, 3)], { rounds: 1 })), unknown("pushes_not_seen"));
  // the same number: kept
  assert.deepEqual(split(during, [opened, push(10), push(20, 3)], { rounds: 2 }).unknown, null);
});

test("a pull request brought in with backfill is not one seen from the start, and what backfill says of one that was is no push", () => {
  const feedback = [inline(BOT, 5), review("bob", 6), review("bob", 30)];
  // months later: as it was opened, made up from its commits, then as it is, both now
  const late = [{ at: at(100_000), event: "opened", commits: 1 }, { at: at(100_000), event: "manual", commits: 4 }];
  assert.deepEqual(rest(split(feedback, late, { rounds: 1 })), unknown("not_from_open"));
  assert.deepEqual(rest(split(feedback, late, { rounds: 1, createdAt: null })), unknown("not_from_open"));
  // reported when it was opened, though some minutes after: seen from the start
  const pushed = (opened: number) => split([inline(BOT, 70)], [{ at: at(opened), event: "opened", commits: 1 }, push(80)], { rounds: 1 });
  assert.deepEqual(rest(pushed(50)), known({ bots: 1, people: 0, both: 0 }, [who(BOT)]));
  assert.equal(pushed(61).unknown, "not_from_open");
  // brought in half an hour after it was opened: the two reports come one after the other, which no push seen at its own time does
  const soon = [{ at: at(30), event: "opened", commits: 1 }, { at: at(30.1), event: "manual", commits: 2 }];
  assert.deepEqual(rest(split([inline(BOT, 5), inline("bob", 20)], soon, { rounds: 1 })), unknown("not_from_open"));
  // one the server already had: bot, push, then a person's comment nothing followed. Backfill's two reports add no round.
  const tracked = [inline(BOT, 5), inline("bob", 15)];
  const again = [opened, push(10), { at: at(500), event: "opened", commits: 1 }, { at: at(500), event: "manual", commits: 2 }];
  assert.deepEqual(rest(split(tracked, again, { rounds: 1 })), known({ bots: 1, people: 0, both: 0 }, [who(BOT)]));
});

test("the author's own comments and replies make them no reviewer and start no round", () => {
  const own = split([inline("ann", 5), inline("ann", 6, true), review("ann", 7), said("ann", 8)], [opened, push(10)]);
  assert.deepEqual(own, { reviewers: [], ...known({ bots: 0, people: 0, both: 0 }, [], "commits") });
  // nor do they by the reports' times, where the Action counted a round they are no part of
  const others = split([inline("ann", 5), review("bob", 6)], [opened, push(10)], { rounds: 1 });
  assert.deepEqual(rest(others), known({ bots: 0, people: 1, both: 0 }, [who("bob")]));
  // a bot that opened the pull request is its author
  const bot = split([inline(BOT, 5), review("bob", 6)], [opened, push(10)], { author: BOT, rounds: 1 });
  assert.deepEqual([bot.reviewers.map((r) => r.author), bot.rounds], [["bob"], { bots: 0, people: 1, both: 0 }]);
});

test("comments in the conversation and approvals count for the reviewer and start no round", () => {
  const found = split([said("bob", 5), review("bob", 6, "approved"), said(BOT, 7), review("cy", 8, "dismissed")], [opened, push(10)], { rounds: 1 });
  assert.equal(found.unknown, "pushes_not_seen");
  assert.deepEqual(found.reviewers.map((r) => [r.author, r.reviews, r.conversation]), [[BOT, 0, 1], ["bob", 1, 1], ["cy", 1, 0]]);
});

test("each reviewer's reviews and comments, replies apart, bots first and the busiest first", () => {
  const found = split(
    [
      inline(BOT, 1), inline(BOT, 2), inline(BOT, 9, true),
      review("bob", 3, "changes_requested"), review("bob", 30, "approved"), inline("bob", 4), said("bob", 5),
      inline("cy", 6), inline("al", 7),
      inline("dependabot[bot]", 8),
    ],
    [opened],
  );
  assert.deepEqual(found.reviewers, [
    { author: BOT, bot: true, reviews: 0, changes_requested: 0, inline: 2, replies: 1, conversation: 0, first_at: at(1), last_at: at(9) },
    { author: "dependabot[bot]", bot: true, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, first_at: at(8), last_at: at(8) },
    { author: "bob", bot: false, reviews: 2, changes_requested: 1, inline: 1, replies: 0, conversation: 1, first_at: at(3), last_at: at(30) },
    { author: "al", bot: false, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, first_at: at(7), last_at: at(7) },
    { author: "cy", bot: false, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, first_at: at(6), last_at: at(6) },
  ]);
  // a reply by someone other than the author is feedback, as the Action has it
  assert.deepEqual(split([inline(BOT, 5, true)], [opened, push(10)], { rounds: 1 }).rounds, { bots: 1, people: 0, both: 0 });
});

test("the rounds are not known without every push and all the feedback, and the reviewers still are", () => {
  const feedback = [inline(BOT, 5), review("bob", 6)];
  const reviewers = split(feedback, [opened]).reviewers;
  assert.equal(reviewers.length, 2);
  // first reported after it was opened
  assert.deepEqual(split(feedback, [push(10)], { firstEvent: "synchronize", rounds: 1 }), { reviewers, ...unknown("not_from_open") });
  // more reports than are kept: the one it was opened with is gone
  const many = Array.from({ length: 50 }, (_, i) => push(10 + i, 2 + i));
  assert.deepEqual(split(feedback, many, { rounds: 1 }), { reviewers, ...unknown("reports_not_kept") });
  assert.deepEqual(split(feedback, [], { rounds: 1 }), { reviewers, ...unknown("reports_not_kept") });
  // only the latest reviews and comments were kept
  assert.deepEqual(split(feedback, [opened, push(10)], { total: 2500, rounds: 1 }), { reviewers, ...unknown("feedback_not_kept") });
  // an Action from before they were sent
  assert.deepEqual(split(null, [opened, push(10)], { rounds: 1 }), { reviewers: [], ...unknown("feedback_not_kept") });
  // with all of it, they are
  assert.deepEqual(split(feedback, [opened, push(10)], { rounds: 1 }).rounds, { bots: 0, people: 0, both: 1 });
});

test("the order the reviews, comments and reports come in does not matter", () => {
  const feedback = [inline(BOT, 5), review("bob", 15), inline("cy", 16), said("bob", 2), inline(BOT, 17)];
  const reports = [opened, push(10), push(20, 3)];
  const expected = split(feedback, reports, { rounds: 2 });
  assert.deepEqual(expected.rounds, { bots: 1, people: 0, both: 1 });
  assert.deepEqual(split([...feedback].reverse(), [...reports].reverse(), { rounds: 2 }), expected);
  assert.deepEqual(split([feedback[2]!, feedback[4]!, feedback[0]!, feedback[3]!, feedback[1]!], [reports[1]!, reports[2]!, reports[0]!], { rounds: 2 }), expected);
});

test("reviewers over many pull requests: a row a bot, one for all people, and a round a bot's alone only when no one else asked", () => {
  const other = "sonarcloud[bot]";
  const first = split(
    [inline(BOT, 1), inline(BOT, 2), inline(other, 3), review("bob", 15, "changes_requested"), inline(BOT, 25), inline("cy", 26), inline(BOT, 35)],
    [opened, push(10), push(20, 3), push(30, 4), push(40, 5)],
    { rounds: 4 },
  );
  assert.deepEqual(first.round_authors, [who(BOT, other), who("bob"), who(BOT, "cy"), who(BOT)]);
  const second = split([inline(BOT, 5), said("bob", 6), inline(BOT, 7, true), said("vercel[bot]", 8)], [opened, push(10)], { rounds: 1 });
  // its rounds are not known: its comments count, its rounds do not
  const third = split([inline(BOT, 5), review("dee", 6)], [push(10)], { firstEvent: "synchronize", rounds: 1 });
  assert.deepEqual(summarizeReviewers([first, second, third, null, split([], [opened])]), [
    { author: BOT, pulls: 3, reviews: 0, changes_requested: 0, inline: 6, replies: 1, conversation: 0, rounds_alone: 2, rounds_shared: 2, pulls_with_rounds_known: 2, pulls_with_rounds_by_pushes: 2 },
    { author: other, pulls: 1, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, rounds_alone: 0, rounds_shared: 1, pulls_with_rounds_known: 1, pulls_with_rounds_by_pushes: 1 },
    // bob only commented in the conversation of the second, and vercel's bot only ever did: neither reviewed it
    { author: null, pulls: 2, reviews: 2, changes_requested: 1, inline: 1, replies: 0, conversation: 0, rounds_alone: 1, rounds_shared: 1, pulls_with_rounds_known: 1, pulls_with_rounds_by_pushes: 1 },
  ]);
  // no one reviewed: no row, not one of noughts
  assert.deepEqual(summarizeReviewers([split([], [opened]), null, split([said("vercel[bot]", 1), said("bob", 2)], [opened])]), []);
  assert.deepEqual(summarizeReviewers([split([inline(BOT, 1)], [opened])]).map((r) => r.author), [BOT]);
  // one a round followed, by the Action's word, whose comments are among those no longer kept: it has its part
  const cut = split([inline("bob", 50)], [], { total: 2500, rounds: 1, said: [who(BOT, "cy")] });
  assert.deepEqual(summarizeReviewers([cut]).map((r) => [r.author, r.pulls, r.rounds_alone, r.rounds_shared, r.pulls_with_rounds_known, r.pulls_with_rounds_by_pushes]), [[BOT, 1, 0, 1, 1, 0], [null, 1, 0, 1, 1, 0]]);
});
