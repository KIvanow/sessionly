// Outcomes: what later commits on a base branch did to a merged pull
// request's lines. A scheduled run reads the branch's history with git, in
// the runner, and tells the server which lines each commit removed and
// added in the files the server named, and what its message and pull
// request say of it. The server knows which of those lines were the pull
// request's, and the agents'; messages, titles, bodies and labels never
// leave the runner, only what they are read as.
//
// What a message says is read word by word, as the sessionly binary reads
// it (`crates/sessionly/src/outcomes.rs`): test/outcome-signals.json holds
// the words and the cases both must read the same way.
import { SPACE } from "./lines.mjs";

/** The default word lists, from the fixture the binary is tested against too. */
export const FIX_WORDS = ["fix", "fixes", "fixed", "fixing", "bug", "bugs", "bugfix", "hotfix", "regression", "broken", "crash", "crashes", "crashed", "typo"];
export const FIX_TYPES = ["fix", "hotfix", "bugfix"];
export const BUG_LABELS = ["bug", "regression", "defect", "incident"];

// What Rust's `char::is_alphanumeric` accepts, and what it takes for white space.
const NOT_LETTER_OR_DIGIT = /[^\p{Alphabetic}\p{N}]+/u;
const SPACES = new RegExp(`[${SPACE}]+`, "u");
const ENDS = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

/** A text's words: lowercased, split on everything that is not a letter or digit. */
export const words = (text) => text.split(NOT_LETTER_OR_DIGIT).filter(Boolean).map((w) => w.toLowerCase());

/** Whether `text` is one word as a subject is read: letters and digits only. */
const isWord = (text) => text !== "" && !NOT_LETTER_OR_DIGIT.test(text);

/** A message's first line, as Rust's `lines()` gives it, without white space at its ends. */
const subjectOf = (message) => (message.split("\n")[0] ?? "").replace(/\r$/, "").replace(ENDS, "");

/**
 * The words a commit is read for: the defaults, or a comma-separated list
 * instead of the fix words or the bug labels (the `fix-words` and
 * `bug-labels` inputs). Of a list, only what is one word counts; with none
 * that is, the defaults do.
 */
export function wordsOf(fixWords = "", bugLabels = "") {
  const given = (text, defaults) => {
    const list = String(text ?? "").split(/[\n,]/).map((w) => w.replace(ENDS, "")).filter(isWord).map((w) => w.toLowerCase());
    return new Set(list.length > 0 ? list : defaults);
  };
  return { fixWords: given(fixWords, FIX_WORDS), fixTypes: new Set(FIX_TYPES), bugLabels: given(bugLabels, BUG_LABELS) };
}

/** A conventional commit subject (`fix(scope)!: rest`): its type and the rest; null if it is not one. */
function conventional(subject) {
  const colon = subject.indexOf(":");
  if (colon < 0) return null;
  const head = subject.slice(0, colon);
  let kind = head.endsWith("!") ? head.slice(0, -1) : head;
  const paren = kind.indexOf("(");
  if (paren >= 0) {
    if (!kind.endsWith(")")) return null;
    kind = kind.slice(0, paren);
  }
  return /^[A-Za-z]+$/.test(kind) ? { kind: kind.toLowerCase(), rest: subject.slice(colon + 1) } : null;
}

/**
 * What a commit message says of itself: `fix_message` (a fix word in the
 * subject line), `fix_conventional` (a `fix:` type), `revert_subject` (it
 * begins with "revert", after a conventional type if it has one). Only the
 * subject line is read.
 */
export function signals(message, of = wordsOf()) {
  const subject = subjectOf(message);
  const found = [];
  if (words(subject).some((w) => of.fixWords.has(w))) found.push("fix_message");
  const typed = conventional(subject);
  if (typed && of.fixTypes.has(typed.kind)) found.push("fix_conventional");
  const reverting = typed ? typed.kind === "revert" || words(typed.rest)[0] === "revert" : words(subject)[0] === "revert";
  if (reverting) found.push("revert_subject");
  return found;
}

/**
 * The commits a message says it reverts: each `This reverts commit <sha>`,
 * the words apart by any white space, the SHA 7 to 64 hex digits (SHA-1 or
 * SHA-256), lowercased.
 */
export function reverts(message) {
  const tokens = message.split(SPACES).filter(Boolean);
  const found = [];
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    const [a, b, c] = tokens.slice(i, i + 3).map((t) => t.toLowerCase());
    if (a !== "this" || b !== "reverts" || c !== "commit") continue;
    const sha = tokens[i + 3].replace(/[.,;:)]+$/, "");
    if (/^[0-9a-fA-F]{7,64}$/.test(sha)) found.push(sha.toLowerCase());
  }
  return found;
}

/**
 * Whether a commit puts lines back rather than lands them: a revert, or
 * the revert of a revert (`Reapply "…"`), as the binary reads one.
 */
export function putsBack(message) {
  const first = words(subjectOf(message))[0];
  return reverts(message).length > 0 || first === "revert" || first === "reapply";
}

/**
 * What the pull request a commit was merged with says of it, beside its
 * own message: `fix_branch` (the branch's first part, before a `/`, is a
 * fix type: `fix/login`), `fix_pr_title` (a fix word in its title),
 * `revert_pr_title` (its title begins `Revert "`, as GitHub's revert button
 * writes it), `bug_issue` (an issue it closes has a label with a bug word).
 * And the pull requests of `repo` its body says it reverts (`Reverts
 * owner/name#12`, as that button writes it). Nothing of the text is kept.
 */
export function pullSignals({ title, head_ref, body, labels = [] }, repo, of = wordsOf()) {
  const found = [];
  const branch = String(head_ref ?? "").split("/")[0].toLowerCase();
  if (of.fixTypes.has(branch)) found.push("fix_branch");
  const heading = String(title ?? "");
  if (words(heading).some((w) => of.fixWords.has(w))) found.push("fix_pr_title");
  if (heading.replace(ENDS, "").startsWith('Revert "')) found.push("revert_pr_title");
  if (labels.some((label) => words(String(label)).some((w) => of.bugLabels.has(w)))) found.push("bug_issue");
  const pulls = [];
  const tokens = String(body ?? "").split(SPACES).filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i].toLowerCase() !== "reverts") continue;
    const named = /^([^/\s#]+\/[^/\s#]+)#(\d{1,9})[.,;:)]*$/.exec(tokens[i + 1]);
    if (named && named[1].toLowerCase() === repo.toLowerCase()) pulls.push(Number(named[2]));
  }
  return { signals: found, reverts: [...new Set(pulls)] };
}
