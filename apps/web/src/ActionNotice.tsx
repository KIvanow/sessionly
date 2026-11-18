import { actionNoticeText, NOTICE_CODE, rerunNoticeText, type PullWord } from "./actionNotice.ts";

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const marked = new RegExp(`(${NOTICE_CODE.map(escape).join("|")})`, "g");

/** The same words, with the workflow path and `@main` set apart. */
function notice(text: string) {
  return text.split(marked).map((part, i) =>
    (NOTICE_CODE as readonly string[]).includes(part) ? <code key={i}>{part}</code> : part,
  );
}

/**
 * How to move a pinned Action, and what a re-run does.
 *
 * `pull` is "this pull request" on its page and "the pull request" on the list.
 * `rerun` is left out when this pull request was already reported by the current Action.
 * `move` asks to change a pin. Not when a later report already shows the current Action.
 */
export function ActionNotice({
  pull,
  rerun,
  move = true,
}: {
  pull: PullWord;
  /** Left out when this pull request is already current. The re-run notice does not use it. */
  rerun: boolean;
  move?: boolean;
}) {
  return <>{notice(move ? actionNoticeText(pull, rerun) : rerunNoticeText(pull))}</>;
}
