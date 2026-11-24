// Who reviewed a pull request on GitHub, and whose feedback each of its
// rounds of review followed; and the same over many pull requests. Nothing
// here reads or writes: `keepReviewSplit` in pulls.ts hands it what is kept
// of the pull request, and stores what it returns.
import type { PullFeedback, PullReviewer, ReviewerSummary, ReviewSplit, RoundAuthor } from "@sessionly/schema";

/** What a pull request's split is worked out from. */
export interface SplitOf {
  /** Who opened it. */
  author: string;
  /** Its reviews and comments as kept. */
  feedback: PullFeedback[] | null;
  /** The rounds its last report counted, by commit. */
  reviewRounds: number;
  /** Whose feedback each of them followed, when that report said and it is kept. */
  roundAuthors: RoundAuthor[][] | null;
  /**
   * Whether that report was from an Action that says whose feedback each
   * round followed (0.4.0 and later). One from before counted the rounds
   * and said no more.
   */
  says: boolean;
}

/** The order logins are listed in, wherever they are: by code unit, the same on every machine. */
export const byLogin = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const items = (r: PullReviewer): number => r.reviews + r.inline + r.replies + r.conversation;

/**
 * Everyone in the reviews and comments, with what each did: the author
 * (null with nothing of their own), and everyone else. The one place that
 * says what is a review, a reply, a comment on the diff and a bot.
 */
function countedBy(author: string, feedback: PullFeedback[]): { own: PullReviewer | null; others: PullReviewer[] } {
  const found = new Map<string, PullReviewer>();
  for (const f of feedback) {
    let one = found.get(f.author);
    if (!one) {
      one = { author: f.author, bot: false, reviews: 0, changes_requested: 0, inline: 0, replies: 0, conversation: 0, first_at: f.at, last_at: f.at };
      found.set(f.author, one);
    }
    if (f.bot) one.bot = true;
    if (f.kind === "review") {
      one.reviews += 1;
      if (f.state === "changes_requested") one.changes_requested += 1;
    } else if (f.kind === "conversation") one.conversation += 1;
    else if (f.reply) one.replies += 1;
    else one.inline += 1;
    if (Date.parse(f.at) < Date.parse(one.first_at)) one.first_at = f.at;
    if (Date.parse(f.at) > Date.parse(one.last_at)) one.last_at = f.at;
  }
  const own = found.get(author) ?? null;
  found.delete(author);
  const others = [...found.values()].sort(
    (a, b) => Number(b.bot) - Number(a.bot) || items(b) - items(a) || byLogin(a.author, b.author),
  );
  return { own, others };
}

type Unknown = NonNullable<ReviewSplit["unknown"]>;

/**
 * The rounds as the last report has them, or why they are not known.
 *
 * Whose feedback each followed, when the report said so of as many as it
 * counted. Without that, an Action from before it said (`says` is false)
 * that counted no round is taken at its word: there are none. One that
 * counted some did not say whose feedback they followed, and nothing else
 * here can: when a commit was made is known only to the Action, and the
 * times its reports arrived put feedback given between a commit and its
 * push in the wrong round.
 *
 * And an Action that says, with nothing of it kept: the report went to a
 * server from before this that kept none of it, or was the one `backfill`
 * makes up of how the pull request began, which says nothing of its
 * rounds. Not even no rounds are known then, until its next report.
 */
export function saidRounds(of: Pick<SplitOf, "reviewRounds" | "roundAuthors" | "says">): RoundAuthor[][] | Unknown {
  if (of.roundAuthors != null && of.roundAuthors.length === of.reviewRounds) return of.roundAuthors;
  if (of.says) return "not_kept";
  return of.reviewRounds === 0 ? [] : "action_did_not_say";
}

/**
 * A pull request's reviewers and its rounds by who asked.
 *
 * The reviewers, and the author's own answers beside them, are counted
 * from whatever reviews and comments are kept.
 * The rounds are the Action's (`saidRounds`), from the commits' own times,
 * or not known, with why. A round is of bots when all who asked before it
 * are bots, of people when none is, and of both otherwise.
 *
 * In whatever order `feedback` comes.
 */
export function reviewSplit(of: SplitOf): ReviewSplit {
  const { own, others: reviewers } = of.feedback ? countedBy(of.author, of.feedback) : { own: null, others: [] };
  const found = saidRounds(of);
  if (typeof found === "string") return { reviewers, author: own, rounds: null, round_authors: null, unknown: found };
  const rounds = { bots: 0, people: 0, both: 0 };
  for (const authors of found) {
    const bots = authors.some((a) => a.bot);
    const people = authors.some((a) => !a.bot);
    // (A round nobody is named for cannot be: the Action names who it followed.)
    rounds[bots && people ? "both" : bots ? "bots" : "people"] += 1;
  }
  return { reviewers, author: own, rounds, round_authors: found, unknown: null };
}

const emptyRow = (author: string | null): ReviewerSummary => ({
  author,
  pulls: 0,
  reviews: 0,
  changes_requested: 0,
  inline: 0,
  replies: 0,
  conversation: 0,
  rounds_alone: 0,
  rounds_shared: 0,
  pulls_with_rounds_known: 0,
});

/** To review is to submit a review or to comment on the diff: a comment in the conversation alone is not. */
const reviewed = (r: PullReviewer): boolean => r.reviews + r.inline + r.replies > 0;

/**
 * The reviewers of many pull requests, summed: one row for each bot, and
 * one for all people together. Only those who reviewed: a bot that posts
 * its build's address in the conversation is no reviewer. A round is a
 * bot's alone when no one else's feedback came before it, and the people's
 * alone when only people's did; any other round it was part of is shared.
 * Rounds are counted only over the pull requests where they are known, and
 * each row says of how many of its pull requests that is.
 *
 * Bots first, most comments on the diff first and then by login; the
 * people's row last. A pull request with no split (null) has no part.
 */
export function summarizeReviewers(splits: (ReviewSplit | null)[]): ReviewerSummary[] {
  const bots = new Map<string, ReviewerSummary>();
  const people = emptyRow(null);
  const rowOf = (author: string): ReviewerSummary => {
    const row = bots.get(author) ?? emptyRow(author);
    bots.set(author, row);
    return row;
  };
  for (const split of splits) {
    if (!split) continue;
    // Who has a part in this one: those who reviewed, and whoever a round followed
    // (named by the Action, though their comments are among those no longer kept).
    const botsHere = new Set<string>();
    let peopleHere = false;
    for (const r of split.reviewers) {
      if (!reviewed(r)) continue;
      if (r.bot) botsHere.add(r.author);
      else peopleHere = true;
      const row = r.bot ? rowOf(r.author) : people;
      row.reviews += r.reviews;
      row.changes_requested += r.changes_requested;
      row.inline += r.inline;
      row.replies += r.replies;
      row.conversation += r.conversation;
    }
    for (const authors of split.round_authors ?? []) {
      const persons = authors.filter((a) => !a.bot).length;
      if (persons > 0) {
        peopleHere = true;
        people[persons === authors.length ? "rounds_alone" : "rounds_shared"] += 1;
      }
      for (const a of authors) {
        if (!a.bot) continue;
        botsHere.add(a.author);
        rowOf(a.author)[authors.length === 1 ? "rounds_alone" : "rounds_shared"] += 1;
      }
    }
    for (const row of [...[...botsHere].map(rowOf), ...(peopleHere ? [people] : [])]) {
      row.pulls += 1;
      if (split.round_authors) row.pulls_with_rounds_known += 1;
    }
  }
  const rows = [...bots.values()].sort((a, b) => b.inline - a.inline || byLogin(a.author!, b.author!));
  return people.pulls > 0 ? [...rows, people] : rows;
}
