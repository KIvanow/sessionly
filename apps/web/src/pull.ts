// A pull request's page: where it is, how current its figures are, and its
// reviews and comments counted by whose they are.
import type { PullFeedback, PullMatches, PullRow } from "@sessionly/schema";
import { dateTime } from "./format.ts";

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
): Promise<{ matched: number; needs_report: number }> {
  let matched = 0;
  let started: string | undefined;
  for (;;) {
    const answer = await send({ ...filters, started });
    matched += answer.matched;
    started = answer.started;
    progress(matched);
    // An answer that matched none would be asked for forever.
    if (answer.remaining === 0 || answer.matched === 0) return { matched, needs_report: answer.needs_report };
  }
}
