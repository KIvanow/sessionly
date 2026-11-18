// A pull request's page: where it is, how current its figures are, and its
// reviews and comments counted by whose they are.
import type { PullCost, PullFeedback, PullMatches, PullRow } from "@sessionly/schema";
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

/** What a pull request's sessions cost it. */
export function pullCost(c: Pick<PullCost, "usd" | "estimated" | "sessions_without_cost" | "sessions_with_cost_partial"> | null, word?: string): string {
  return c ? costText(c.usd, c.estimated, costIsFloor(c), word) : "–";
}

/** The small print under a pull request's cost: what a line cost, and what the figure leaves out. */
export function pullCostNote(c: PullCost | null): string {
  if (!c) return "not known: its sessions were not kept at its last report";
  const opened = unsure(c.opened_is_floor, c.opened_estimated);
  if (c.sessions === 0) {
    return c.opened_usd != null
      ? `none of the agent lines it was opened with is left: they cost ${opened}${usdOf(c.opened_usd)}`
      : "no session was matched to its lines";
  }
  const without = c.sessions_without_cost - c.sessions_uncounted;
  const missing = [
    without > 0 ? `${count(without)} of ${count(c.sessions)} ${c.sessions === 1 ? "session" : "sessions"} ${without === 1 ? "has" : "have"} no cost figure` : null,
    c.sessions_uncounted > 0
      ? `the share of ${count(c.sessions_uncounted)} ${c.sessions_uncounted === 1 ? "session is" : "sessions is"} still being worked out since the upgrade`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  // Review replaced every agent line it was opened with: what those cost is in no other figure here.
  const gone =
    c.opened_usd != null && c.per_surviving_line_usd == null
      ? `none of the agent lines it was opened with is left: they cost ${opened}${usdOf(c.opened_usd)}`
      : null;
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
    c.per_agent_line_usd != null ? `${unsure(c.sessions_with_cost_partial > 0, false)}${usdEach(c.per_agent_line_usd)} per agent line` : null,
    // There when the cost now is not: the lines with a cost went, and ones without stayed.
    c.per_surviving_line_usd != null ? `${opened}${usdEach(c.per_surviving_line_usd)} per line that survived review` : null,
  ];
  return [...each, gone, missing, partial, unshared].filter(Boolean).join("; ");
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
  return [each, floor ?? "what the matched sessions cost, each for its share of lines", closed].filter(Boolean).join("; ");
}

/** Where a pull request's page is: the repository's name has slashes, so it goes in as one part. */
export function pullHref(p: { repo: string; number: number }): string {
  return `#/pull/${encodeURIComponent(p.repo)}/${p.number}`;
}

/** A link is only followed to a web address. */
export const web = (url: string | null | undefined): string | undefined => (url && /^https?:\/\//i.test(url) ? url : undefined);

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

/** Whose a review or comment is: a bot's, the pull request's author's, or another person's. */
export type By = "people" | "bots" | "author";
export const byOf = (f: PullFeedback, author: string): By => (f.bot ? "bots" : f.author === author ? "author" : "people");

export interface FeedbackCount {
  by: By;
  /** Who they were, most active first. */
  names: string[];
  reviews: number;
  changes_requested: number;
  inline: number;
  conversation: number;
}

/**
 * Reviews and comments counted by whose they are: reviewers who are people,
 * bots, and the author (whose own comments are answers, not review).
 */
export function countFeedback(feedback: PullFeedback[], author: string): FeedbackCount[] {
  const rows = (["people", "bots", "author"] as By[]).map((by) => ({ by, names: new Map<string, number>(), reviews: 0, changes_requested: 0, inline: 0, conversation: 0 }));
  for (const f of feedback) {
    const row = rows.find((r) => r.by === byOf(f, author))!;
    row.names.set(f.author, (row.names.get(f.author) ?? 0) + 1);
    if (f.kind === "review") {
      row.reviews += 1;
      if (f.state === "changes_requested") row.changes_requested += 1;
    } else row[f.kind] += 1;
  }
  return rows.map((r) => ({ ...r, names: [...r.names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name) }));
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
