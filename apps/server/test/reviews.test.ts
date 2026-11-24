import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullFeedback, RoundAuthor } from "@sessionly/schema";
import { reviewSplit, summarizeReviewers } from "../src/reviews.ts";

// Minutes after the pull request was opened.
const at = (minutes: number) => new Date(Date.parse("2026-11-10T12:00:00Z") + minutes * 60_000).toISOString();

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

type More = { rounds?: number; said?: RoundAuthor[][] | null; says?: boolean; author?: string };
// As an Action that says whose feedback each round followed has it when `said`, and as one from before otherwise.
const split = (feedback: PullFeedback[] | null, more: More = {}) =>
  reviewSplit({
    author: more.author ?? "ann",
    feedback,
    reviewRounds: more.rounds ?? 0,
    roundAuthors: more.said ?? null,
    says: more.says ?? more.said != null,
  });
const who = (...logins: string[]): RoundAuthor[] => logins.map((author) => ({ author, bot: author.endsWith("[bot]") }));
const known = (rounds: { bots: number; people: number; both: number }, authors: RoundAuthor[][]) => ({ rounds, round_authors: authors, unknown: null });
const unknown = (why: string) => ({ rounds: null, round_authors: null, unknown: why });
const rest = ({ reviewers: _, author: __, ...others }: ReturnType<typeof reviewSplit>) => others;
const none = known({ bots: 0, people: 0, both: 0 }, []);

test("no reviews and comments: no reviewers and no rounds", () => {
  assert.deepEqual(split([]), { reviewers: [], author: null, ...none });
  assert.deepEqual(split([], { said: [] }), { reviewers: [], author: null, ...none });
});

test("the Action says whose feedback each round followed: that is the split", () => {
  const feedback = [inline(BOT, 5), review("bob", 6), inline(BOT, 30)];
  const said = [who(BOT), who("bob", BOT), who("bob")];
  const found = split(feedback, { rounds: 3, said });
  assert.deepEqual(rest(found), known({ bots: 1, people: 1, both: 1 }, said));
  assert.deepEqual(found.reviewers.map((r) => r.author), [BOT, "bob"]);
  // a round is of bots when all who asked are, of people when none is, and of both otherwise
  assert.deepEqual(split([], { rounds: 2, said: [who(BOT, "sonarcloud[bot]"), who("bob", "cy")] }).rounds, { bots: 1, people: 1, both: 0 });
  // whoever is kept among the reviews and comments: the commits' own times are not the server's to doubt
  assert.deepEqual(rest(split(null, { rounds: 3, said })), known({ bots: 1, people: 1, both: 1 }, said));
});

test("an Action from before it said: no round is none, and whose feedback any round followed is not known", () => {
  const feedback = [inline(BOT, 5), review("bob", 6)];
  assert.deepEqual(rest(split(feedback)), none);
  // the times its reports arrived are not gone by: feedback between a commit and its push would be put in the wrong round
  const found = split(feedback, { rounds: 1 });
  assert.deepEqual(rest(found), unknown("action_did_not_say"));
  assert.deepEqual(found.reviewers.map((r) => r.author), [BOT, "bob"]);
});

test("an Action that says, with nothing of it kept: not known, not even that there are none", () => {
  // stored by a server from before this, or the report backfill makes up of how the pull request began
  assert.deepEqual(rest(split([inline(BOT, 5)], { says: true })), unknown("not_kept"));
  assert.deepEqual(rest(split([inline(BOT, 5)], { rounds: 2, says: true })), unknown("not_kept"));
  // (not as many as it counted cannot be stored; if it were, it is not gone by)
  assert.deepEqual(rest(split([], { rounds: 2, said: [who(BOT)] })), unknown("not_kept"));
});

test("the author's own comments and replies make them no reviewer, and are counted in a row of their own", () => {
  const own = split([inline("ann", 5), inline("ann", 6, true), review("ann", 7, "changes_requested"), said("ann", 8)]);
  const row = { author: "ann", bot: false, reviews: 1, changes_requested: 1, inline: 1, replies: 1, conversation: 1, first_at: at(5), last_at: at(8) };
  assert.deepEqual(own, { reviewers: [], author: row, ...none });
  // nothing of the author's: no row
  assert.equal(split([review("bob", 6)]).author, null);
  assert.equal(split(null).author, null);
  // a bot that opened the pull request is its author
  const bot = split([inline(BOT, 5), review("bob", 6)], { author: BOT });
  assert.deepEqual([bot.reviewers.map((r) => r.author), bot.author?.author, bot.author?.bot, bot.author?.inline], [["bob"], BOT, true, 1]);
});

test("comments in the conversation and approvals count for the reviewer", () => {
  const found = split([said("bob", 5), review("bob", 6, "approved"), said(BOT, 7), review("cy", 8, "dismissed")]);
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
  );
  assert.deepEqual(found.reviewers, [
    { author: BOT, bot: true, reviews: 0, changes_requested: 0, inline: 2, replies: 1, conversation: 0, first_at: at(1), last_at: at(9) },
    { author: "dependabot[bot]", bot: true, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, first_at: at(8), last_at: at(8) },
    { author: "bob", bot: false, reviews: 2, changes_requested: 1, inline: 1, replies: 0, conversation: 1, first_at: at(3), last_at: at(30) },
    { author: "al", bot: false, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, first_at: at(7), last_at: at(7) },
    { author: "cy", bot: false, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, first_at: at(6), last_at: at(6) },
  ]);
});

test("reviewers over many pull requests: a row a bot, one for all people, and a round a bot's alone only when no one else asked", () => {
  const other = "sonarcloud[bot]";
  const first = split(
    [inline(BOT, 1), inline(BOT, 2), inline(other, 3), review("bob", 15, "changes_requested"), inline(BOT, 25), inline("cy", 26), inline(BOT, 35)],
    { rounds: 4, said: [who(BOT, other), who("bob"), who(BOT, "cy"), who(BOT)] },
  );
  const second = split([inline(BOT, 5), said("bob", 6), inline(BOT, 7, true), said("vercel[bot]", 8)], { rounds: 1, said: [who(BOT)] });
  // its rounds are not known: its comments count, its rounds do not
  const third = split([inline(BOT, 5), review("dee", 6)], { rounds: 1 });
  assert.deepEqual(summarizeReviewers([first, second, third, null, split([])]), [
    { author: BOT, pulls: 3, reviews: 0, changes_requested: 0, inline: 6, replies: 1, conversation: 0, rounds_alone: 2, rounds_shared: 2, pulls_with_rounds_known: 2 },
    { author: other, pulls: 1, reviews: 0, changes_requested: 0, inline: 1, replies: 0, conversation: 0, rounds_alone: 0, rounds_shared: 1, pulls_with_rounds_known: 1 },
    // bob only commented in the conversation of the second, and vercel's bot only ever did: neither reviewed it
    { author: null, pulls: 2, reviews: 2, changes_requested: 1, inline: 1, replies: 0, conversation: 0, rounds_alone: 1, rounds_shared: 1, pulls_with_rounds_known: 1 },
  ]);
  // no one reviewed: no row, not one of noughts
  assert.deepEqual(summarizeReviewers([split([]), null, split([said("vercel[bot]", 1), said("bob", 2)])]), []);
  assert.deepEqual(summarizeReviewers([split([inline(BOT, 1)])]).map((r) => r.author), [BOT]);
  // one a round followed, by the Action's word, whose comments are among those no longer kept: it has its part
  const cut = split([inline("bob", 50)], { rounds: 1, said: [who(BOT, "cy")] });
  assert.deepEqual(summarizeReviewers([cut]).map((r) => [r.author, r.pulls, r.rounds_alone, r.rounds_shared, r.pulls_with_rounds_known]), [[BOT, 1, 0, 1, 1], [null, 1, 0, 1, 1]]);
});
