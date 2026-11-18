// What a repository does about an older Action: move a pin, and what a re-run does.

/** "this" on a pull request's page, "the" on the list. */
export type PullWord = "this" | "the";

/** Words the notice sets apart. */
export const NOTICE_CODE = [".github/workflows/sessionly.yml", "@main"];

/** Move a pinned Action to a newer commit or tag. */
export function movePin(): string {
  return `If ${NOTICE_CODE[0]} pins the Action to a commit or tag, move it to a newer one.`;
}

/** A re-run keeps the Action a commit or tag names. `@main` fetches it again. */
export function pinnedRerun(pull: PullWord): string {
  return `For a pinned commit or tag, a re-run keeps the old version: push a commit for an open pull request, or start the workflow by hand with ${pull} pull request's number if it has been merged.`;
}

/** With `@main`, the job fetches the Action again. */
export function mainRerun(): string {
  return `With ${NOTICE_CODE[1]}, re-run the job: it fetches the Action again.`;
}

/**
 * What to change in the workflow, and what a re-run does. The re-run sentence
 * is left out when this pull request was already reported by the current Action.
 */
export function actionNoticeText(pull: PullWord, rerun: boolean): string {
  return [movePin(), ...(rerun ? [pinnedRerun(pull)] : []), mainRerun()].join(" ");
}

/**
 * What a re-run does, without asking to move a pin. A later report has already
 * shown that the repository uses the current Action.
 */
export function rerunNoticeText(pull: PullWord): string {
  return `${pinnedRerun(pull)} ${mainRerun()}`;
}
