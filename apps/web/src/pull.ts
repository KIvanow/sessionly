// A pull request's page: where it is, how current its figures are, and its
// reviews and comments counted by whose they are.
import type { LocalReviewRun, LocalReviews, PullCost, PullDetail, PullFeedback, PullMatches, PullReviewer, PullRow, PullSession, ReviewSplit } from "@sessionly/schema";
import { count, dateTime, usd, usdEach } from "./format.ts";

/** Whether a cost is a floor: a session of it has no cost figure, or one that leaves requests out. */
export const costIsFloor = (c: Pick<PullCost, "sessions_without_cost" | "sessions_with_cost_partial">): boolean =>
  c.sessions_without_cost + c.sessions_with_cost_partial > 0;

/** A cost as a headline has it: under a cent, the digits that say something, and never "$0.0000" for one that is not nothing. */
const usdOf = (n: number): string => (n > 0 && n < 0.01 ? usdEach(n) : usd(n));

/** What is not sure about a figure, before it: "at least " for a floor, "~" for an estimate. */
const unsure = (floor: boolean, estimated: boolean, word = "at least "): string => `${floor ? word : ""}${estimated ? "~" : ""}`;

/** A cost in a few words: "~" before an estimate, `floor` before one that is a floor, a dash for none. */
export function costText(cost: number | null, estimated: boolean, floor: boolean, word?: string): string {
  if (cost == null) return "–";
  return `${unsure(floor, estimated, word)}${usdOf(cost)}`;
}

/** What a run was pointed at, in words, where the record says: Codex's `/review`, or a pull request of another repository. "" otherwise. */
export function reviewTarget(target: string | null | undefined): string {
  if (!target) return "";
  const known: Record<string, string> = {
    base_branch: "the changes against a branch",
    uncommitted_changes: "the uncommitted changes",
    commit: "a commit",
    custom: "what it was told to",
    other_repository: "a pull request in another repository",
  };
  return known[target] ?? target.replaceAll("_", " ");
}

/**
 * How long after the run before it each review run started, in milliseconds:
 * the time one iteration took. Null for the first, and where a time is missing.
 */
export function reviewGaps(each: readonly Pick<LocalReviewRun, "at">[]): (number | null)[] {
  return each.map((run, i) => {
    const before = i > 0 ? each[i - 1]!.at : null;
    if (!run.at || !before) return null;
    const gap = Date.parse(run.at) - Date.parse(before);
    return Number.isFinite(gap) && gap >= 0 ? gap : null;
  });
}

/**
 * The review runs of a pull request's sessions in a sentence: "Reviewed 3 times
 * before and during review (2 xhigh, 1 high), 1 of them in the cloud. Review
 * subagents: $12.40 of the $85.43." `spent` is the pull request's cost.
 */
export function localReviewsLine(r: LocalReviews | null): string {
  if (!r) return "No session of it is known.";
  const unknown =
    r.sessions_unknown > 0
      ? ` Not known for ${count(r.sessions_unknown)} of its sessions: deleted since, captured by an older Sessionly, which did not count reviews, or a Codex session whose own record of them was not there to read.`
      : "";
  if (r.runs === 0) return `No review command ran in its sessions.${unknown}`;
  const efforts = Object.entries(r.by_effort)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([effort, n]) => `${count(n)} ${effort}`);
  const parts = [`Reviewed ${r.runs === 1 ? "once" : `${count(r.runs)} times`} before and during review${efforts.length ? ` (${efforts.join(", ")})` : ""}`];
  if (r.cloud > 0) parts.push(`${count(r.cloud)} of them in the cloud`);
  let line = `${parts.join(", ")}.`;
  if (r.findings != null) line += ` ${count(r.findings)} findings reported.`;
  if (r.cost_usd != null) line += ` Review subagents: ${usdOf(r.cost_usd)}.`;
  if (r.shared_with > 0)
    line += ` Some of those ran in sessions it shares with ${count(r.shared_with)} other pull ${r.shared_with === 1 ? "request" : "requests"}, and name none: they may be counted on those too.`;
  return line + unknown;
}

/** What a pull request's sessions cost it. */
export function pullCost(c: Pick<PullCost, "usd" | "estimated" | "sessions_without_cost" | "sessions_with_cost_partial"> | null, word?: string): string {
  return c ? costText(c.usd, c.estimated, costIsFloor(c), word) : "–";
}

/** The small print under a pull request's cost: what a line cost, and what the figure leaves out. */
export function pullCostNote(c: PullCost | null): string {
  if (!c) return "not known: its sessions were not kept at its last report";
  const opened = unsure(c.opened_is_floor, c.opened_estimated);
  // Review replaced every agent line it was opened with, or every one of a session with a cost: what
  // those cost is in no other figure here.
  const left = c.opened_surviving_lines ?? 0;
  const gone =
    c.opened_usd == null || c.per_surviving_line_usd != null
      ? null
      : left === 0
        ? `none of the agent lines it was opened with is left: they cost ${opened}${usdOf(c.opened_usd)}`
        : `none of the agent lines it was opened with that have a cost is left: they cost ${opened}${usdOf(c.opened_usd)}; ${count(left)} of sessions with none ${left === 1 ? "is" : "are"}`;
  if (c.sessions === 0) return gone ?? "no session was matched to its lines";
  // What its first version cost, where review rounds cost more since: the rest of the cost is theirs.
  const first =
    c.usd != null && c.opened_usd != null && c.opened_usd < c.usd ? `${opened}${usdOf(c.opened_usd)} of it for its first version, the rest in review` : null;
  const without = c.sessions_without_cost - c.sessions_uncounted;
  const missing = [
    without > 0 ? `${count(without)} of ${count(c.sessions)} ${c.sessions === 1 ? "session" : "sessions"} ${without === 1 ? "has" : "have"} no cost figure` : null,
    c.sessions_uncounted > 0
      ? `the share of ${count(c.sessions_uncounted)} ${c.sessions_uncounted === 1 ? "session is" : "sessions is"} still being worked out since the upgrade`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  const partial =
    c.sessions_with_cost_partial > 0
      ? `the cost of ${count(c.sessions_with_cost_partial)} ${c.sessions_with_cost_partial === 1 ? "session leaves" : "sessions leave"} requests out`
      : null;
  // Matching again says which lines are whose. One last reported before what it is matched by was kept needs a report.
  const how =
    c.sessions_unshared_for_good > 0
      ? "one of those has to be reported again by the Action before they can be shared out"
      : "match those again to share them out";
  const unshared =
    c.sessions_unshared > 0
      ? `${count(c.sessions_unshared)} ${c.sessions_unshared === 1 ? "session has" : "sessions have"} lines in other pull requests, perhaps these: ${how}`
      : null;
  const each = [
    // A cost that leaves requests out, over all of that session's lines, is a floor for each.
    c.per_agent_line_usd != null ? `${unsure(c.sessions_with_cost_partial > 0, c.estimated)}${usdEach(c.per_agent_line_usd)} per agent line` : null,
    // There when the cost now is not: the lines with a cost went, and ones without stayed.
    c.per_surviving_line_usd != null
      ? `${unsure(c.per_surviving_line_is_floor, c.opened_estimated)}${usdEach(c.per_surviving_line_usd)} per line that survived review`
      : null,
  ];
  return [...each, first, gone, missing, partial, unshared].filter(Boolean).join("; ");
}

/**
 * A session's cost in a pull request, as its row has it: "~" before an
 * estimate, null where there is none, and why, where the figure alone does
 * not say.
 */
export function sessionShare(s: Pick<PullSession, "cost_share_usd" | "uncounted" | "unshared" | "session">): { text: string | null; why: string | null } {
  if (s.uncounted) return { text: null, why: "its share is still being worked out since the upgrade" };
  if (!s.session || s.cost_share_usd == null) return { text: null, why: null };
  const estimated = s.session.cost_source !== "recorded" || s.unshared;
  return {
    text: `${estimated ? "~" : ""}${usdEach(s.cost_share_usd)}`,
    why: s.unshared ? "it has lines in other pull requests, perhaps these: an estimate until they are shared out" : null,
  };
}

/** The small print under the cost of several pull requests. */
export function pullsCostNote(total: {
  cost_usd: number | null;
  pulls_with_cost_missing: number;
  pulls_closed_with_cost: number;
  per_surviving_line_usd: number | null;
  per_surviving_line_is_floor: boolean;
  per_surviving_line_estimated: boolean;
}): string {
  const missing = total.pulls_with_cost_missing;
  const floor = missing > 0 ? `not known in full for ${count(missing)} ${missing === 1 ? "pull request" : "pull requests"}` : null;
  // Those closed without merging have a cost in the list below and none here.
  const closed = total.pulls_closed_with_cost > 0 ? `without the ${count(total.pulls_closed_with_cost)} closed unmerged` : null;
  const each =
    total.per_surviving_line_usd != null
      ? `${unsure(total.per_surviving_line_is_floor, total.per_surviving_line_estimated)}${usdEach(total.per_surviving_line_usd)} per agent line that survived review`
      : null;
  if (total.cost_usd == null) {
    const why = floor ? `${floor}: their sessions have no cost figure, or were not kept at their last report` : null;
    return [each, why, closed].filter(Boolean).join("; ") || "no session was matched to their lines";
  }
  return [each, floor ?? "what the sessions that gave them lines cost, review rounds included", closed].filter(Boolean).join("; ");
}

const once = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * How many lines that survived the cost per line divides by, each counted
 * once, and why that is not how many survived: shown only when it is not.
 * Null too when there is no cost per line to explain.
 */
export function survivingOnce(total: {
  agent_lines_surviving: number;
  agent_lines_surviving_once: number;
  per_surviving_line_usd: number | null;
}): { text: string; why: string } | null {
  if (total.per_surviving_line_usd == null || total.agent_lines_surviving_once === total.agent_lines_surviving) return null;
  return {
    text: `${once.format(total.agent_lines_surviving_once)} counted once for cost`,
    why:
      "What the cost per agent line that survived review divides by. A line opened in more than one pull request counts in part in " +
      "each, as its cost does, and survives in all of them while any one keeps it: fewer than the count beside it where those " +
      "pull requests are all here, more where only some are. Only pull requests with a cost are in it.",
  };
}

/** Where a pull request's page is: the repository's name has slashes, so it goes in as one part. */
export function pullHref(p: { repo: string; number: number }): string {
  return `#/pull/${encodeURIComponent(p.repo)}/${p.number}`;
}

/** A link is only followed to a web address. */
export const web = (url: string | null | undefined): string | undefined => (url && /^https?:\/\//i.test(url) ? url : undefined);

/** At most five names, then how many are left: `a, b, c, d, e and 2 more`. */
export function nameSome(names: string[]): string {
  const shown = names.slice(0, 5);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

const STATES: Record<string, string> = {
  approved: "approved",
  changes_requested: "asked for changes",
  commented: "commented",
  dismissed: "dismissed",
};

/** What a review or comment was, in a few words. Never what it said: that is not kept. */
export function feedbackLabel(f: PullFeedback): string {
  if (f.kind === "review") return `Review: ${STATES[f.state ?? ""] ?? "submitted"}`;
  if (f.kind === "conversation") return "Comment in the conversation";
  const where = f.path ? ` on ${f.path}${f.line ? `:${f.line}` : ""}` : "";
  return `${f.reply ? "Reply" : "Comment"}${where}`;
}

/**
 * Whose a review or comment is: the pull request's author's, a bot's, or
 * another person's. A bot that opened the pull request is its author there,
 * as the Action and the server have it: what it says on its own pull request
 * is no review.
 */
export type By = "people" | "bots" | "author";
export const byOf = (f: PullFeedback, author: string): By => (f.author === author ? "author" : f.bot ? "bots" : "people");

/** What one person or bot did on a pull request. */
export type FeedbackRow = Pick<PullReviewer, "author" | "reviews" | "changes_requested" | "inline" | "replies" | "conversation">;

export interface FeedbackCount {
  by: By;
  /** Who they were, most active first, then by name. None for a group nobody is in. */
  rows: FeedbackRow[];
}

/**
 * A pull request's reviews and comments by whose they are, one row each:
 * reviewers who are people, bots, and the author (whose own comments are
 * answers, not review). All as the server counted them (`ReviewSplit`), in
 * its order: nothing is counted here. Nobody, from a server from before it
 * did (null).
 */
export function countFeedback(split: Pick<ReviewSplit, "reviewers" | "author"> | null): FeedbackCount[] {
  const shown = ({ author, reviews, changes_requested, inline, replies, conversation }: FeedbackRow): FeedbackRow => ({ author, reviews, changes_requested, inline, replies, conversation });
  const reviewers = split?.reviewers ?? [];
  return [
    { by: "people", rows: reviewers.filter((r) => !r.bot).map(shown) },
    { by: "bots", rows: reviewers.filter((r) => r.bot).map(shown) },
    { by: "author", rows: split?.author ? [shown(split.author)] : [] },
  ];
}

type Rounds = NonNullable<ReviewSplit["rounds"]>;
const roundsWord = (n: number): string => (n === 1 ? "round" : "rounds");

/** Rounds by whose feedback they followed: "2 after bots only, 1 after people only, 1 after both". Those with none are left out. */
export function roundsByWho(rounds: Rounds): string {
  return [
    rounds.bots > 0 && `${count(rounds.bots)} after bots only`,
    rounds.people > 0 && `${count(rounds.people)} after people only`,
    rounds.both > 0 && `${count(rounds.both)} after both`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The split of a pull request's rounds, when it is known and is of the
 * rounds shown: the server keeps one only when it comes to as many, and one
 * that does not (a server and a page of different versions) is not shown
 * beside another number.
 */
function splitOf(p: Pick<PullRow, "review_rounds" | "review_split">): Rounds | null {
  const rounds = p.review_split?.rounds;
  return rounds && rounds.bots + rounds.people + rounds.both === p.review_rounds ? rounds : null;
}

type Reviewed = Pick<PullRow, "review_comments" | "bot_review_comments" | "review_rounds" | "review_split">;

/**
 * Under the review comments: how many by people and by bots, in how many
 * rounds, and whose feedback the rounds followed when that is known.
 */
export function reviewNote(p: Reviewed): string {
  const start = `${count(p.review_comments)} by people, ${count(p.bot_review_comments)} by bots, in ${count(p.review_rounds)} ${roundsWord(p.review_rounds)}`;
  const rounds = splitOf(p);
  return rounds && p.review_rounds > 0 ? `${start}: ${roundsByWho(rounds)}` : `${start} of review`;
}

/** The same split for the rounds of a pull request in a list, as a title. Nothing where there are no rounds. */
export function roundsTitle(p: Pick<PullRow, "review_rounds" | "review_split">): string | undefined {
  if (p.review_rounds === 0) return undefined;
  const rounds = splitOf(p);
  if (!rounds) return "Whose feedback they followed is not known";
  return roundsByWho(rounds);
}

/** Why the rounds' split is not known, as the server says it (`ReviewSplit.unknown`), and what would make it known. */
const UNKNOWN_ROUNDS: Record<NonNullable<ReviewSplit["unknown"]>, string> = {
  action_did_not_say:
    "Not known: its last report was from an Action that counts the rounds and does not say whose feedback each followed. A report from version 0.4.0 of the Action or later says it.",
  not_kept:
    "Not known: what its Action said of them was not kept when it was last reported. Its next report brings it: run its workflow again. (Never on one with more than 300 rounds, 50 names in one round or 2,000 in all: the Action names none for it.)",
};

/**
 * Whose feedback a pull request's rounds followed, as a sentence for its
 * page; and when that is not known, why not, and what would make it known.
 */
export function roundsLine(p: Pick<PullDetail, "review_rounds" | "review_split">): string {
  const rounds = splitOf(p);
  const split = p.review_split;
  if (rounds && p.review_rounds === 0) return "No round: no feedback was followed by a commit.";
  if (rounds) return `${roundsByWho(rounds)}.`;
  if (!split) return "Not worked out yet.";
  return (split.unknown && UNKNOWN_ROUNDS[split.unknown]) || "Not known.";
}

/**
 * How current a pull request's figures are: when the Action last reported
 * it, and when its lines were matched to sessions if that was later. `when`
 * writes a time out.
 */
export function matchedLine(
  p: Pick<PullRow, "updated_at" | "matched_at" | "matchable">,
  when: (iso: string | null) => string = dateTime,
): string {
  const reported = `Last reported by the Action ${when(p.updated_at)}`;
  if (!p.matchable) {
    return `${reported}, before what its lines are matched by was kept: sessions uploaded since then count with its next report.`;
  }
  // A report matches the lines as it is stored: the two times are then one.
  const since = p.matched_at != null && Date.parse(p.matched_at) - Date.parse(p.updated_at) > 1000;
  return since
    ? `${reported}; its lines were matched to sessions again ${when(p.matched_at)}.`
    : `${reported}. Sessions uploaded since then are not counted yet.`;
}

/**
 * Match again every pull request the filters choose. The server does some
 * at a time: `send` is asked until none remain, and `progress` hears how
 * many are done after each answer.
 */
export async function matchAll(
  send: (body: Record<string, string | undefined>) => Promise<PullMatches>,
  filters: { repo?: string; state?: string; since?: string },
  progress: (done: number) => void = () => {},
): Promise<{ matched: number; needs_report: number; failed: number }> {
  let matched = 0;
  let started: string | undefined;
  let left = Infinity;
  for (;;) {
    const answer = await send({ ...filters, started });
    matched += answer.matched;
    started = answer.started;
    progress(matched);
    // An answer that got no further would be asked for forever: what remains could not be matched.
    const stuck = answer.matched === 0 && answer.remaining >= left;
    if (answer.remaining === 0 || stuck) return { matched, needs_report: answer.needs_report, failed: answer.remaining };
    left = answer.remaining;
  }
}

const HISTORY_EVENTS: Record<string, string> = {
  opened: "Opened",
  synchronize: "Pushed",
  reopened: "Reopened",
  ready_for_review: "Marked ready",
  closed: "Closed",
  review: "Reviewed",
  review_comment: "Commented",
  manual: "Reported by hand",
  match: "Matched again",
};

/** What prompted a report, in the words the history shows. */
export function historyEvent(event: string): string {
  return HISTORY_EVENTS[event] ?? event.replaceAll("_", " ");
}

/** The part of a history reason that sits beside the headline figure. */
export function figureBecause(reason: string): string {
  return (reason.split(":")[0] ?? reason).trim();
}

/**
 * The sentence beside the agent figure when that figure moved: what it was
 * until this report, and why. Null when there is nothing earlier, or when
 * the agent lines are the same as then.
 */
export function figureShift(
  history: readonly { at: string; agent_lines: number; change: { reason: string | null } }[],
  when: (iso: string) => string,
  amount: (n: number) => string,
): string | null {
  const latest = history[0];
  const previous = history[1];
  if (!latest?.change.reason || !previous || previous.agent_lines === latest.agent_lines) return null;
  return `Was ${amount(previous.agent_lines)} until ${when(latest.at)}: ${figureBecause(latest.change.reason)}.`;
}

type AfterMerge = { checkpoint: "7d" | "30d"; agent_lines: number; surviving: number; age_seconds: number };
const AFTER_DAYS = { "7d": 7, "30d": 30 } as const;

/**
 * A pull request's reports and the counts made after it was merged, as one
 * list by time, newest first: two kinds of thing, shown in one table. A
 * count made at the same moment as a report comes after it.
 */
export function timeline<R extends { at: string }, C extends { at: string }>(
  history: readonly R[],
  counts: readonly C[] | null | undefined,
): ({ at: string; report: R; count?: undefined } | { at: string; count: C; report?: undefined })[] {
  return [...history.map((report) => ({ at: report.at, report })), ...(counts ?? []).map((count) => ({ at: count.at, count }))].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at) || Number("count" in a) - Number("count" in b),
  );
}

/** What a count after merging is called in the list: "7 days after merge". */
export const afterMergeName = (row: Pick<AfterMerge, "checkpoint">): string => `${AFTER_DAYS[row.checkpoint]} days after merge`;

/**
 * A count after merging, in words: "30 days after merge: 498 of 520 agent
 * lines still there". One counted a day or more late says on which day.
 */
export function afterMergeLine(row: AfterMerge, amount: (n: number) => string = String): string {
  const days = AFTER_DAYS[row.checkpoint];
  const day = Math.floor(row.age_seconds / 86_400);
  const late = day > days ? ` (counted on day ${day})` : "";
  return `${days} days after merge: ${amount(row.surviving)} of ${amount(row.agent_lines)} agent ${row.agent_lines === 1 ? "line" : "lines"} still there${late}`;
}

/**
 * The tile of a merged pull request's agent lines 30 days on: the share,
 * and what it is of. Until that count is made, a dash, with the count at 7
 * days if there is one, or when the first is to come.
 */
export function afterMergeTile(
  rows: readonly AfterMerge[] | null | undefined,
  mergedAt: string | null,
  share: (part: number, whole: number) => string,
  amount: (n: number) => string = String,
  now: number = Date.now(),
): { value: string; part: number | null; note: string } {
  const at = (age: "7d" | "30d") => (rows ?? []).find((row) => row.checkpoint === age);
  const of = (row: AfterMerge) => `${amount(row.surviving)} of ${amount(row.agent_lines)} agent lines`;
  const seven = at("7d");
  const thirty = at("30d");
  if (thirty) {
    const day = Math.floor(thirty.age_seconds / 86_400);
    return {
      value: share(thirty.surviving, thirty.agent_lines),
      part: thirty.agent_lines > 0 ? thirty.surviving / thirty.agent_lines : null,
      note: `${of(thirty)}${day > 30 ? `, counted on day ${day}` : ""}${seven ? `; ${share(seven.surviving, seven.agent_lines)} at 7 days` : ""}`,
    };
  }
  const age = mergedAt ? (now - Date.parse(mergedAt)) / 86_400_000 : NaN;
  if (seven) {
    // Past day 30 with no count is not waiting for the day: no run has counted it.
    const thirtieth = age >= 30 ? "not counted at 30 days" : "not 30 days yet";
    return { value: "–", part: null, note: `${thirtieth}; at 7 days ${share(seven.surviving, seven.agent_lines)}, ${of(seven)}` };
  }
  if (age < 7) return { value: "–", part: null, note: "counted 7 and 30 days after it was merged" };
  return { value: "–", part: null, note: "not counted: a scheduled run of the Action does it, for lines whose sessions are kept" };
}
