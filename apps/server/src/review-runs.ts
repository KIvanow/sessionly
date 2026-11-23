// Which of a session's review runs are a pull request's. `localReviewsIn`
// (pulls.ts) finds the sessions that may have reviewed one; the rule for each
// of their runs is here, and nowhere else.
import type { ReviewRun } from "@sessionly/schema";

/** The efforts a review command takes. What was sent as one is a string: any other is not counted by. */
export const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

/** A pull request and a session that may have reviewed it, as they were found. */
export interface Reviewed {
  /** The pull request's number. */
  number: number;
  /** When it was merged or closed, in milliseconds. Null while it is open. */
  ended: number | null;
  /**
   * When the pull requests before it on the same branch (those there with a
   * lower number) were all merged or closed: the last of those times. Null
   * when there is none, or none of them has ended.
   */
  after: number | null;
  /** The session has lines in the pull request. */
  matched: boolean;
  /**
   * The session started on the pull request's own branch, in the repository
   * that branch is in (a fork's branch is the fork's), and the branch is not
   * the one the pull request merges into.
   */
  onBranch: boolean;
}

/**
 * True for a run that is this pull request's:
 *
 * - Not one refused before it began (denied, or declined): no review ran.
 * - One that names a pull request is that one's, whenever it ran.
 * - One that names none is of the pull requests its session is matched to,
 *   and of the one whose branch its session is on, only while that pull
 *   request was not yet merged or closed: a session may go on to other work,
 *   and a branch's name may be used again.
 * - On a branch that has one pull request after another, as `develop` does,
 *   one that names none is not of a pull request while the one before it
 *   there was still open. A run with no time is of neither then.
 */
export function belongs(to: Reviewed, run: ReviewRun): boolean {
  if (run.status === "denied" || run.status === "rejected") return false;
  if (run.pull_number != null) return run.pull_number === to.number;
  const at = run.at == null ? null : Date.parse(run.at);
  if (at !== null && to.ended !== null && at > to.ended) return false;
  return to.matched || (to.onBranch && (to.after === null || (at !== null && at > to.after)));
}
