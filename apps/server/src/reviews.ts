// Who reviewed a pull request on GitHub, and whose feedback each of its
// rounds of review followed; and the same over many pull requests. Nothing
// here reads or writes: `keepReviewSplit` in pulls.ts hands it what is kept
// of the pull request, and stores what it returns.
import type { PullFeedback, PullReviewer, ReviewerSummary, ReviewSplit, RoundAuthor } from "@sessionly/schema";

/** A report of a pull request as its history keeps it: when, what prompted it, and how many commits there were. */
export interface ReportAt {
  at: string;
  event: string;
  commits: number;
}

/** What a pull request's split is worked out from. */
export interface SplitOf {
  /** Who opened it. */
  author: string;
  /** Its reviews and comments as kept, and how many there are on GitHub. */
  feedback: PullFeedback[] | null;
  feedbackTotal: number | null;
  /** The rounds the Action counted, by commit. */
  reviewRounds: number;
  /** Whose feedback each of them followed, when the Action said (0.4.0 and later). */
  roundAuthors: RoundAuthor[][] | null;
  /** When it was opened on GitHub, and what prompted its first report. */
  createdAt: string | null;
  firstEvent: string;
  /** Its history. Read only when the Action did not say whose feedback each round followed. */
  reports: ReportAt[];
}

/**
 * A pull request seen from the start had its first report within this long
 * of being opened. One brought in later with the Action's `backfill` has a
 * first report that says `opened` too, made up from its commits: the time
 * it arrived tells the two apart.
 */
export const OPENED_WITHIN_MS = 60 * 60_000;

/**
 * And `backfill` sends that made-up report and the one of how the pull
 * request is now one after the other, in one run. A report with another
 * number of commits within this long of the first is taken for that,
 * whenever the pull request was opened: its pushes were not seen at their
 * own times. (The report of a push this soon after the one of its opening
 * is rare, and costs only that its split is not said.)
 */
export const BACKFILL_WITHIN_MS = 10_000;

/**
 * What a round follows, by the Action's own rule (`roundAuthors` in
 * action/src/report.mjs): a review that comments or asks for changes, or a
 * comment on the diff, from anyone but the author. A comment in the
 * conversation is not.
 */
const asksForMore = (f: PullFeedback, author: string): boolean =>
  f.author !== author && (f.kind === "inline" || (f.kind === "review" && (f.state === "commented" || f.state === "changes_requested")));

/** The order logins are listed in, wherever they are: by code unit, the same on every machine. */
export const byLogin = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const items = (r: PullReviewer): number => r.reviews + r.inline + r.replies + r.conversation;

/** Everyone in the reviews and comments but the author, with what each did. */
function reviewersOf(author: string, feedback: PullFeedback[]): PullReviewer[] {
  const found = new Map<string, PullReviewer>();
  for (const f of feedback) {
    if (f.author === author) continue;
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
  return [...found.values()].sort(
    (a, b) => Number(b.bot) - Number(a.bot) || items(b) - items(a) || byLogin(a.author, b.author),
  );
}

/**
 * The times of the pushes among a pull request's reports, oldest first: the
 * reports a push prompted (`synchronize`). The first report is the pull
 * request being opened, not a push; and a later one that says `opened` is
 * the Action's `backfill` describing how it began, which is no report of
 * how it is and is passed over.
 *
 * Null when a push was not seen at its own time: a report prompted by
 * something else has another number of commits than the one before it, so
 * the report of the push that brought them never came (its run failed, or
 * was cancelled), and when it was pushed is anywhere between the two.
 */
function pushesIn(reports: ReportAt[]): number[] | null {
  const pushes: number[] = [];
  const real = reports.filter((report, i) => i === 0 || report.event !== "opened");
  for (const [i, report] of real.entries()) {
    if (i === 0) continue;
    if (report.event === "synchronize") pushes.push(Date.parse(report.at));
    else if (report.commits !== real[i - 1]!.commits) return null;
  }
  return pushes;
}

type Unknown = NonNullable<ReviewSplit["unknown"]>;

/**
 * The rounds as the reports' times have them, for a pull request whose
 * Action did not say whose feedback each followed: a push with feedback
 * since the push before it, or since the pull request was opened, is one
 * round. Or why that cannot be told.
 *
 * This is the server's clock against GitHub's, and a report arrives some
 * time after its push, so it is kept only where every push and all the
 * feedback were there to walk, and where it comes to as many rounds as the
 * Action counted from the commits themselves. A push that left no report
 * (as many commits, lines and sessions as before), one whose report was
 * late, and feedback given while a report was on its way mostly show as
 * another number, and then nothing is said. Where they do not, a round may
 * be put down to the wrong kind: `counted_by` says these are told this way.
 */
function roundsByPush(of: SplitOf): RoundAuthor[][] | Unknown {
  const { feedback } = of;
  if (feedback == null || (of.feedbackTotal ?? 0) > feedback.length) return "feedback_not_kept";
  if (of.firstEvent !== "opened") return "not_from_open";
  const oldestFirst = of.reports
    .map((report, i) => ({ report, i }))
    .sort((a, b) => Date.parse(a.report.at) - Date.parse(b.report.at) || a.i - b.i)
    .map(({ report }) => report);
  const first = oldestFirst[0];
  if (first?.event !== "opened") return "reports_not_kept";
  const opened = of.createdAt == null ? NaN : Date.parse(of.createdAt);
  if (!(Date.parse(first.at) - opened <= OPENED_WITHIN_MS)) return "not_from_open";
  const second = oldestFirst[1];
  if (second && second.commits !== first.commits && Date.parse(second.at) - Date.parse(first.at) <= BACKFILL_WITHIN_MS) return "not_from_open";

  // A login is a bot when anything of its says so, as its row among the reviewers has it.
  const bots = new Set(feedback.filter((f) => f.bot).map((f) => f.author));
  const asked = feedback
    .filter((f) => asksForMore(f, of.author))
    .map((f) => ({ at: Date.parse(f.at), author: f.author }))
    .sort((a, b) => a.at - b.at);
  const pushes = pushesIn(oldestFirst);
  if (!pushes) return "pushes_not_seen";
  const rounds: RoundAuthor[][] = [];
  let next = 0;
  for (const push of pushes) {
    const before = new Set<string>();
    while (next < asked.length && asked[next]!.at <= push) before.add(asked[next++]!.author);
    if (before.size > 0) rounds.push([...before].sort(byLogin).map((author) => ({ author, bot: bots.has(author) })));
  }
  return rounds.length === of.reviewRounds ? rounds : "pushes_not_seen";
}

/**
 * The rounds as the Action has them: whose feedback each followed, when it
 * said so of as many as it counted; and none, when it counted none. Null
 * when the reports' times are all there is to go by.
 */
export function saidRounds(of: Pick<SplitOf, "reviewRounds" | "roundAuthors">): RoundAuthor[][] | null {
  if (of.reviewRounds === 0) return [];
  return of.roundAuthors != null && of.roundAuthors.length === of.reviewRounds ? of.roundAuthors : null;
}

/**
 * A pull request's reviewers and its rounds by who asked.
 *
 * The reviewers are counted from whatever reviews and comments are kept.
 * The rounds are the Action's when it said whose feedback each followed, as
 * many as it counted: from the commits' own times, whenever the pull
 * request was first reported. No rounds at all are known to be none,
 * whoever counted. Otherwise they are what `roundsByPush` can tell, or not
 * known, with why. A round is of bots when all who asked
 * before it are bots, of people when none is, and of both otherwise.
 *
 * In whatever order `feedback` and `reports` come.
 */
export function reviewSplit(of: SplitOf): ReviewSplit {
  const reviewers = of.feedback ? reviewersOf(of.author, of.feedback) : [];
  const said = saidRounds(of);
  const found = said ?? roundsByPush(of);
  if (typeof found === "string") return { reviewers, rounds: null, round_authors: null, counted_by: null, unknown: found };
  const rounds = { bots: 0, people: 0, both: 0 };
  for (const authors of found) {
    const bots = authors.some((a) => a.bot);
    const people = authors.some((a) => !a.bot);
    // (A round nobody is named for cannot be: the Action names who it followed.)
    rounds[bots && people ? "both" : bots ? "bots" : "people"] += 1;
  }
  return { reviewers, rounds, round_authors: found, counted_by: said ? "commits" : "pushes", unknown: null };
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
  pulls_with_rounds_by_pushes: 0,
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
      if (split.round_authors && split.counted_by === "pushes") row.pulls_with_rounds_by_pushes += 1;
    }
  }
  const rows = [...bots.values()].sort((a, b) => b.inline - a.inline || byLogin(a.author!, b.author!));
  return people.pulls > 0 ? [...rows, people] : rows;
}
