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
import { commitOf, isAncestor, isSha, MOST_SHOWN, parseList, placeOf, readHistory, regionOf, revList, shasOf } from "./history.mjs";
import { SPACE } from "./lines.mjs";

/** A pull request number as the server keeps one. */
const isNumber = (n) => Number.isInteger(n) && n >= 1 && n <= 2 ** 31 - 1;

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
 * SHA-256), lowercased. Only in a revert's message, as git writes one: its
 * subject begins with "revert" or "reapply", or the body begins with that
 * line. A squash merge's message, which lists its branch's commits (a
 * `Revert "wip"` among them, with its line), says it reverts nothing.
 */
export function reverts(message) {
  const first = words(subjectOf(message))[0];
  let tokens = message.split(SPACES).filter(Boolean);
  if (first !== "revert" && first !== "reapply") {
    tokens = firstParagraph(message).split(SPACES).filter(Boolean);
    const begins = tokens.length >= 3 && ["this", "reverts", "commit"].every((word, i) => tokens[i].toLowerCase() === word);
    if (!begins) return [];
  }
  const found = [];
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    const [a, b, c] = tokens.slice(i, i + 3).map((t) => t.toLowerCase());
    if (a !== "this" || b !== "reverts" || c !== "commit") continue;
    const sha = tokens[i + 3].replace(/[.,;:)]+$/, "");
    if (/^[0-9a-fA-F]{7,64}$/.test(sha)) found.push(sha.toLowerCase());
  }
  return found;
}

/** A message's first paragraph after its subject line: up to the next empty line. */
function firstParagraph(message) {
  const rest = message.split("\n").slice(1).map((line) => line.replace(/\r$/, ""));
  const blank = (line) => line.replace(ENDS, "") === "";
  let from = 0;
  while (from < rest.length && blank(rest[from])) from += 1;
  let to = from;
  while (to < rest.length && !blank(rest[to])) to += 1;
  return rest.slice(from, to).join("\n");
}

/**
 * Whether a commit puts lines back rather than lands them: a revert, or
 * the revert of a revert (`Reapply "…"`), as git and GitHub write one, and
 * as the binary reads one: its subject begins with `Revert` or `Reapply`,
 * or its body with git's own `This reverts commit <sha>.` A squash commit
 * whose body lists the branch's commits, a revert among them
 * (`* Revert "wip"`), is none.
 */
export function putsBack(message) {
  const first = words(subjectOf(message))[0];
  return first === "revert" || first === "reapply" || reverts(message).length > 0;
}

/** How deep a subject says a commit is in a chain of reverts: one for each `Revert` it begins with, two for each `Reapply`; one at least for a revert that names a commit. */
function subjectDepth(message) {
  let depth = 0;
  for (const word of words(subjectOf(message))) {
    if (word === "revert") depth += 1;
    else if (word === "reapply") depth += 2;
    else break;
  }
  return depth === 0 && reverts(message).length > 0 ? 1 : depth;
}

/** How many reverts in a row are followed through the commits they name. */
const MOST_REVERTS = 20;

/**
 * How deep a commit is in a chain of reverts, as the binary counts it: 0
 * for one that reverts nothing, 1 for a revert of such a one, 2 for a
 * revert of that (`Reapply "…"`, or `Revert "Revert "…""`), and so on,
 * through the commits each names that are in the history here (`find`, a
 * SHA to `commitOf`'s commit or null). One that names none here is as deep
 * as its subject says. One at an even depth puts the lines back.
 */
export function revertDepth(message, find) {
  let text = message;
  let hops = 0;
  while (hops < MOST_REVERTS && putsBack(text)) {
    const named = reverts(text).map(find).find(Boolean);
    if (!named) break;
    hops += 1;
    text = named.message;
  }
  return hops + subjectDepth(text);
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
    if (named && named[1].toLowerCase() === repo.toLowerCase() && isNumber(Number(named[2]))) pulls.push(Number(named[2]));
  }
  return { signals: found, reverts: [...new Set(pulls)] };
}

/** Commit times are the committer's clock: a reading by time reads this much further either way, in milliseconds. */
const SLACK = 86_400_000;
/** The runner's clock and the server's may differ: the history is read up to this long ago, and no later. */
const SKEW = 5 * 60_000;
const LONGEST = 30 * 86_400_000;
/** No fewer GitHub requests than this are left for others: a run stops asking there. */
export const RATE_FLOOR = 100;
/**
 * What the server takes in one request: no more commits than this, nor
 * much more than this much JSON, nor more line hashes or files and moves in
 * all; and of one commit, no more files or moves, or line hashes, than this
 * (`checkOutcomes`). A commit larger than that is not counted, as one too
 * large to read whole is not.
 */
export const COMMITS_AT_ONCE = 500;
const BYTES_AT_ONCE = 8 * 1024 * 1024;
const HASHES_AT_ONCE = 500_000;
const FILES_AT_ONCE = 100_000;
const MOST_FILES = 5000;
const MOST_HASHES = 200_000;
const MOST_PATH = 4096;
/** No more pull requests than this in a commit's lists. */
const MOST_LISTED = 100;
/** Pull requests whose linked issues are asked for in one GraphQL question. */
const LABELS_AT_ONCE = 20;

/** The lines of a map of hash counts, each as often as it is there, in order. */
const spread = (counts) => [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([hash, n]) => Array(n).fill(hash));

/** Of what git says of a commit, what the server is told: its lines in the files read, and those it moved out of them. */
function toSend(commit, tracked) {
  const files = [...commit.files]
    .filter(([path, d]) => tracked.has(path) && (d.removed.size > 0 || d.added.size > 0))
    .map(([path, d]) => ({ path, removed: spread(d.removed), added: spread(d.added) }));
  const byMove = new Map();
  for (const [from, to, hash, n] of commit.moves) {
    // A path longer than the server keeps is not followed there.
    if (!tracked.has(from) || to.length > MOST_PATH) continue;
    const key = JSON.stringify([from, to]);
    byMove.set(key, [...(byMove.get(key) ?? []), ...Array(n).fill(hash)]);
  }
  const moves = [...byMove].map(([key, hashes]) => {
    const [from, to] = JSON.parse(key);
    return { from, to, hashes: hashes.sort() };
  });
  return { files, moves };
}

/** How many line hashes a commit as sent has. */
const hashesIn = (c) => c.files.reduce((n, f) => n + f.removed.length + f.added.length, 0) + (c.moves ?? []).reduce((n, m) => n + m.hashes.length, 0);

/** Text as one line, for a warning. */
const oneLine = (err) => String(err?.message ?? err).replace(/\r?\n/g, " ");

/**
 * Asking GitHub which pull requests a commit belongs to: once for each
 * commit in a run (`of`, null when it cannot be asked). When GitHub allows
 * few more requests (`RATE_FLOOR`), or none, or does not answer, `stop`
 * says why and nothing more is asked. A token that may not read pull
 * requests is said once, and commits are read without what theirs say.
 */
export function asking(api, repo, log) {
  const known = new Map();
  const state = { stop: null, refused: false };
  const of = async (sha) => {
    if (known.has(sha)) return known.get(sha);
    if (state.refused) return [];
    if (state.stop) return null;
    if (api.remaining !== undefined && api.remaining < RATE_FLOOR) {
      state.stop = "GitHub allows this run few more requests";
      return null;
    }
    let list;
    try {
      const found = await api.request("GET", `/repos/${repo}/commits/${sha}/pulls?per_page=100`);
      list = (Array.isArray(found) ? found : []).filter((p) => isNumber(p?.number));
    } catch (err) {
      if (err.status === 404 || err.status === 422) {
        // A commit GitHub does not know: it belongs to none.
        list = [];
      } else if (err.status === 403 && !err.rateLimited) {
        state.refused = true;
        log(
          `::warning title=Sessionly::GitHub would not say which pull requests later commits came with (${oneLine(err)}). ` +
            "Give the job pull-requests: read (and contents: read). Later commits are read without what their pull requests say of them.",
        );
        return [];
      } else {
        state.stop = err.rateLimited || err.status === 429 ? `GitHub's rate limit stopped this run (${oneLine(err)})` : `GitHub did not answer (${oneLine(err)})`;
        return null;
      }
    }
    known.set(sha, list);
    return list;
  };
  return { of, state };
}

/** The labels of the issues each pull request closes, by number. Not known (and said) where GitHub would not answer. */
async function closedLabels(api, repo, numbers, log) {
  const [owner, name] = repo.split("/");
  const labels = new Map();
  for (let from = 0; from < numbers.length; from += LABELS_AT_ONCE) {
    const some = numbers.slice(from, from + LABELS_AT_ONCE);
    const query =
      "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { " +
      some
        .map((n, i) => `p${i}: pullRequest(number: ${Number(n)}) { closingIssuesReferences(first: 10) { nodes { labels(first: 20) { nodes { name } } } } }`)
        .join(" ") +
      " } }";
    try {
      const found = (await api.graphql(query, { owner, name })).repository ?? {};
      some.forEach((n, i) => {
        const issues = found[`p${i}`]?.closingIssuesReferences?.nodes ?? [];
        labels.set(n, issues.flatMap((issue) => (issue?.labels?.nodes ?? []).map((label) => String(label?.name ?? ""))));
      });
    } catch (err) {
      log(`::warning title=Sessionly::The labels of the issues pull requests close could not be read (${oneLine(err)}), so bug_issue is not known for them. It needs issues: read.`);
      break;
    }
  }
  return labels;
}

/**
 * What the server is told of `commits` (read, in the order they are to be
 * walked, each with its `landing` time in `landings`), up to `end`: one
 * that landed later is in no due pull request's 30 days. Each that removes a
 * line in a file read is looked up on GitHub (the pull request it came
 * with, what that says of it). The reading stops at `cut` (the first commit
 * not read whole) and at the first commit GitHub cannot be asked of: `stop`
 * is that commit and why.
 */
async function examine({ git, github, api, repo, base, of, log, commits, tracked, landings, end, cut, afterOf }) {
  const kept = [];
  let stop = null;
  const seen = new Map();
  const find = (sha) => {
    if (!seen.has(sha)) seen.set(sha, commitOf(git, sha));
    return seen.get(sha);
  };
  const meta = new Map();
  for (const commit of commits) {
    const landing = landings.get(commit.sha);
    if (landing > end) break;
    if (commit.sha === cut) {
      stop = { at: commit, why: `more than ${MOST_SHOWN} of them are to be read whole` };
      break;
    }
    const { files, moves } = toSend(commit, tracked);
    if (files.length === 0 && moves.length === 0) continue;
    const named = reverts(commit.message).slice(0, 20);
    const sent = {
      sha: commit.sha,
      landed_at: new Date(landing).toISOString(),
      pulls: [],
      after: afterOf(commit).slice(0, MOST_LISTED),
      signals: signals(commit.message, of),
      reverts: { shas: named, pulls: [] },
      removed_total: commit.removedTotal,
      files,
      ...(moves.length > 0 ? { moves } : {}),
    };
    // More than the server takes of one commit: not counted.
    if (files.length > MOST_FILES || moves.length > MOST_FILES || hashesIn(sent) > MOST_HASHES || JSON.stringify(sent).length > BYTES_AT_ONCE) continue;
    // A revert of a revert puts lines back, and a revert of that takes them out again.
    const reverting = putsBack(commit.message);
    const depth = reverting ? revertDepth(commit.message, find) : 0;
    if (depth >= 2 && depth % 2 === 0) sent.reapply = true;
    if (files.some((f) => f.removed.length > 0)) {
      const list = await github.of(commit.sha);
      if (!list) {
        stop = { at: commit, why: github.state.stop };
        break;
      }
      sent.pulls = list.map((p) => p.number).slice(0, MOST_LISTED);
      const landed = list.find((p) => p.merged_at && p.base?.ref === base);
      if (landed) meta.set(sent, landed);
      // The pull requests of the commits it reverts (a rebase merge's, which no SHA of the pull request names).
      if (reverting) {
        let asked = true;
        for (const r of named.map(find).filter(Boolean)) {
          const theirs = await github.of(r.sha);
          if (!theirs) {
            asked = false;
            break;
          }
          const by = theirs.find((p) => p.merged_at && p.base?.ref === base);
          if (by) sent.reverts.pulls.push(by.number);
        }
        if (!asked) {
          stop = { at: commit, why: github.state.stop };
          break;
        }
      }
    }
    kept.push(sent);
  }
  // What the pull requests the commits came with say: their title, branch, body and linked issues' labels.
  const numbers = [...new Set([...meta.values()].map((p) => p.number))];
  const labels = numbers.length > 0 ? await closedLabels(api, repo, numbers, log) : new Map();
  for (const [commit, pull] of meta) {
    const said = pullSignals({ title: pull.title, head_ref: pull.head?.ref, body: pull.body, labels: labels.get(pull.number) ?? [] }, repo, of);
    commit.signals = [...new Set([...commit.signals, ...said.signals])];
    commit.reverts.pulls = [...new Set([...commit.reverts.pulls, ...said.reverts])].slice(0, MOST_LISTED);
  }
  return { kept, stop };
}


/** The time every pull request's 30 days are over by, and a day for the clock. */
const endOf = (pulls) => Math.max(...pulls.map((p) => p.merged + LONGEST)) + SLACK;

/**
 * Read the later commits of the pull requests that have tips (`bottom`):
 * those on `tip` and not on their tips, whatever their dates, each landed
 * when the branch's own commit that brought it in was made (a merge
 * commit's time for its branch's commits), and never before its pull
 * request was last read up to (`since`), which it cannot have been.
 */
async function readByTips(ctx, pulls, paths, readAt) {
  const { git, tip } = ctx;
  const bottoms = [...new Map(pulls.map((p) => [JSON.stringify(p.bottom), p.bottom])).values()];
  const region = regionOf(git, tip, bottoms);
  for (const p of pulls) {
    const mine = region.of(p.bottom);
    if (!p.found) p.new = mine;
    else if (p.bottom.every((k) => k === p.merge_commit_sha || isAncestor(git, p.merge_commit_sha, k))) {
      // After the commit it was merged as: its lines were not there before.
      p.new = new Set(shasOf(git(["rev-list", "--ancestry-path", "--stdin"], [tip, `^${p.merge_commit_sha}`, ...p.bottom.map((k) => `^${k}`)].map((s) => `${s}\n`).join(""))));
    } else {
      const after = new Set(shasOf(git(["rev-list", "--ancestry-path", `${p.merge_commit_sha}..${tip}`])));
      p.new = new Set([...mine].filter((sha) => after.has(sha)));
    }
  }
  const { chain, place } = placeOf(region.nodes, tip);
  // When each of the branch's own commits landed: in order, and after what the pull requests it is new to were read up to.
  const landed = [];
  chain.forEach((sha, group) => {
    const read = Math.max(-Infinity, ...pulls.filter((p) => p.new.has(sha)).map((p) => p.since + 1));
    const made = Math.min(region.nodes.get(sha).at * 1000, readAt);
    const next = group > 0 ? Math.min(landed[group - 1] + 1, readAt) : -Infinity;
    landed[group] = Math.max(made, next, read);
  });
  const end = endOf(pulls);
  // Those new to one of them, that landed in one's 30 days.
  const wanted = new Set(pulls.flatMap((p) => [...p.new]).filter((sha) => place.has(sha) && landed[place.get(sha).group] <= end));
  const list = (some) => {
    const found = new Map();
    for (const bottom of bottoms) {
      for (const c of parseList(revList(git, ["--no-merges", "--full-history", "--timestamp"], [tip, ...bottom.map((k) => `^${k}`)], some))) {
        if (wanted.has(c.sha)) found.set(c.sha, c);
      }
    }
    return [...found.values()].sort((a, b) => place.get(a.sha).order - place.get(b.sha).order);
  };
  const { commits, paths: tracked, cut } = readHistory(git, list, paths);
  // Each commit its own time, in order, so that the server can be told them in parts cut anywhere:
  // a millisecond after the one before at least, so those made since the reading land one by one just after it.
  const landings = new Map();
  let last = -Infinity;
  for (const c of commits) {
    last = Math.max(landed[place.get(c.sha).group], last + 1);
    landings.set(c.sha, last);
  }
  const afterOf = (c) => pulls.filter((p) => p.new.has(c.sha)).map((p) => p.number);
  const { kept, stop } = await examine({ ...ctx, commits, tracked: new Set(tracked), landings, end, cut, afterOf });
  const groupOf = (c) => place.get(c.sha).group;
  // Read up to the branch's own commit `through` (an index of `chain`), or all.
  let sent = kept;
  let through = "end";
  let until = kept.reduce((most, c) => Math.max(most, Date.parse(c.landed_at)), Math.min(readAt, end));
  if (stop) {
    // Those that came with the one it stopped at go next time, all together, and those that landed with them.
    const stopped = landings.get(commits.find((c) => groupOf(c) === groupOf(stop.at)).sha);
    const group = groupOf(commits.find((c) => landings.get(c.sha) >= stopped));
    sent = kept.filter((c) => groupOf(c) < group);
    through = group - 1;
    until = landings.get(commits.find((c) => groupOf(c) === group).sha) - 1;
  }
  const isAt = new Map();
  const ancestor = (k, sha) => {
    const key = `${k} ${sha}`;
    if (!isAt.has(key)) isAt.set(key, isAncestor(git, k, sha));
    return isAt.get(key);
  };
  return {
    tip,
    pulls: pulls.map(({ number, merge_commit_sha }) => ({ number, merge_commit_sha, found: true })),
    commits: sent,
    scanned_until: new Date(until).toISOString(),
    stopped: stop?.why ?? null,
    through,
    // Read up to before a commit: the branch's own commits before the one it came with.
    before: (c) => groupOf(c) - 1,
    // A part ends best where one of the branch's own commits does.
    apart: (a, b) => groupOf(a) !== groupOf(b),
    from: ctx.known ? new Map(pulls.map((p) => [p.number, p.from])) : null,
    /** What each pull request was read up to, once what comes before `at` is told. */
    tipsAt: (at) =>
      new Map(
        pulls.map((p) => {
          if (at === "end") return [p.number, [tip]];
          const head = chain[at];
          if (at < 0 || !p.new.has(head)) return [p.number, p.bottom];
          return [p.number, [head, ...p.bottom.filter((k) => !ancestor(k, head))]];
        }),
      ),
  };
}

/**
 * Read the later commits of the pull requests that have no tips to read
 * from, by time, as before there were any: those committed from a day
 * before the earliest was read up to, each landed when it was committed.
 * A commit merged in with a date before that is not read: tips are kept
 * once this is told, and a pull request is read from them from then on.
 */
async function readByTime(ctx, pulls, paths, readAt) {
  const { git, tip } = ctx;
  const since = Math.max(0, Math.min(...pulls.map((p) => p.since)) - SLACK);
  const end = endOf(pulls);
  const until = Math.min(readAt, end);
  const after = new Map();
  for (const p of pulls) {
    if (p.found) after.set(p.number, new Set(shasOf(git(["rev-list", "--ancestry-path", `${p.merge_commit_sha}..${tip}`]))));
  }
  const args = ["--no-merges", "--full-history", "--topo-order", "--reverse", "--timestamp", `--max-age=${Math.floor(since / 1000)}`, `--min-age=${Math.floor(until / 1000)}`];
  // In the order they were committed; those of the same second, as git walked them.
  const list = (some) => parseList(revList(git, args, [tip], some)).map((c, i) => ({ ...c, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  const { commits, paths: tracked, cut } = readHistory(git, list, paths);
  const landings = new Map();
  let previous = -Infinity;
  for (const c of commits) {
    previous = Math.max(c.at * 1000, previous + 1);
    landings.set(c.sha, previous);
  }
  const afterOf = (c) => pulls.filter((p) => after.get(p.number)?.has(c.sha)).map((p) => p.number);
  // Git reads no later than `until`; those of its last second are all read, a millisecond apart.
  const { kept, stop } = await examine({ ...ctx, commits, tracked: new Set(tracked), landings, end: Infinity, cut, afterOf });
  const last = kept.reduce((most, c) => Math.max(most, Date.parse(c.landed_at)), until);
  return {
    tip,
    pulls: pulls.map(({ number, merge_commit_sha, found }) => ({ number, merge_commit_sha, found })),
    commits: kept,
    scanned_until: new Date(stop ? landings.get(stop.at.sha) - 1 : last).toISOString(),
    stopped: stop?.why ?? null,
    through: stop ? null : "end",
    before: () => null,
    apart: () => true,
    from: ctx.known ? new Map(pulls.map((p) => [p.number, p.from])) : null,
    tipsAt: (at) => new Map(pulls.map((p) => [p.number, at === "end" ? [tip] : null])),
  };
}

/**
 * Read one base branch's later commits for the pull requests due on it:
 * what the server is told of them, in `scans` (one for those read from
 * their tips, one for those read by time), each in the order its commits
 * landed. A pull request is read from the tips the server keeps for it
 * when they are still in the history (not after a force-push), and one
 * never read from the commit it was merged as; the rest by time. When
 * GitHub cannot be asked, or more is to be read whole than at once, the
 * reading stops there, and the next run goes on from there. `tip` is null
 * when the branch is not in the checkout, and `gone` true when it is not on
 * GitHub either (deleted since). One renamed since is read by its new name,
 * and is gone when that is not in the checkout either.
 */
export async function scanBranch({ git, api, repo, branch, words: of = wordsOf(), log = () => {}, now = Date.now(), github = asking(api, repo, log) }) {
  let tip = commitOf(git, `refs/remotes/origin/${branch.base_ref}`)?.sha;
  if (!tip) {
    let gone = false;
    try {
      const answer = await api.request("GET", `/repos/${repo}/branches/${branch.base_ref.split("/").map(encodeURIComponent).join("/")}`);
      // Renamed since: GitHub answers the old name with the branch it is now. That one is read, or the old one is gone.
      const renamed = typeof answer?.name === "string" && answer.name !== "" && answer.name !== branch.base_ref ? answer.name : null;
      if (renamed) {
        tip = commitOf(git, `refs/remotes/origin/${renamed}`)?.sha;
        gone = !tip;
      }
    } catch (err) {
      gone = err.status === 404;
    }
    if (!tip) return { tip: null, gone, scans: [] };
  }
  const known = branch.pulls.some((p) => "tips" in p);
  // Whether a commit is in the history here and on the branch; the same tips are those of many.
  const onBranch = new Map();
  const on = (sha) => {
    if (!onBranch.has(sha)) onBranch.set(sha, Boolean(isSha(sha) && commitOf(git, sha) && isAncestor(git, sha, tip)));
    return onBranch.get(sha);
  };
  const pulls = [];
  for (const pull of branch.pulls) {
    let sha = pull.merge_commit_sha;
    if (!sha) {
      const read = await api.request("GET", `/repos/${repo}/pulls/${pull.number}`).catch(() => null);
      sha = isSha(read?.merge_commit_sha ?? "") ? read.merge_commit_sha : null;
    }
    const found = Boolean(sha && on(sha));
    const since = Date.parse(pull.since);
    const merged = Date.parse(pull.merged_at);
    // Its tips while they are on the branch (not after a force-push); one never read, from the commit it was merged as.
    const tips = Array.isArray(pull.tips) && pull.tips.length > 0 && pull.tips.every(on) ? [...new Set(pull.tips)] : null;
    const bottom = tips ?? (found && since <= merged ? [sha] : null);
    pulls.push({ number: pull.number, merge_commit_sha: sha, found, since, merged, bottom, from: pull.tips ?? null, paths: pull.paths });
  }
  const ctx = { git, github, api, repo, base: branch.base_ref, of, log, tip, known };
  const readAt = now - SKEW;
  const scans = [];
  const byTips = pulls.filter((p) => p.bottom);
  const byTime = pulls.filter((p) => !p.bottom);
  const pathsOf = (some) => [...new Set(some.flatMap((p) => p.paths))];
  if (byTips.length > 0) scans.push(await readByTips(ctx, byTips, pathsOf(byTips), readAt));
  if (byTime.length > 0) scans.push(await readByTime(ctx, byTime, pathsOf(byTime), readAt));
  return { tip, gone: false, scans };
}

/**
 * A scan cut into requests the server takes: at most `COMMITS_AT_ONCE`
 * commits each, about `BYTES_AT_ONCE` of JSON, and no more hashes or files
 * than it takes; cut only between commits that landed at different times,
 * and where the scan can (`apart`) where one of the branch's own commits
 * ends. Each but the last says it was read up to just before the next one's
 * first commit landed (`scanned_until`), and up to which of the branch's
 * own commits (`through`), so that one that fails leaves those after it for
 * the next run.
 */
export function chunks(scan) {
  const sizeOf = (c) => ({ bytes: JSON.stringify(c).length, hashes: hashesIn(c), files: c.files.length + (c.moves?.length ?? 0) });
  const over = (list) => {
    const sum = list.reduce((s, c) => ({ bytes: s.bytes + c.size.bytes, hashes: s.hashes + c.size.hashes, files: s.files + c.size.files }), { bytes: 0, hashes: 0, files: 0 });
    return list.length > COMMITS_AT_ONCE || sum.bytes > BYTES_AT_ONCE || sum.hashes > HASHES_AT_ONCE || sum.files > FILES_AT_ONCE;
  };
  const out = [];
  let current = [];
  for (const commit of scan.commits) {
    const next = { commit, size: sizeOf(commit) };
    if (current.length > 0 && over([...current, next])) {
      // Where it can be cut: between two that landed apart, at the end of one of the branch's own commits if there is one.
      const cuts = [];
      const all = [...current, next];
      for (let i = 1; i < all.length; i += 1) {
        const [a, b] = [all[i - 1].commit, all[i].commit];
        if (a.landed_at !== b.landed_at) cuts.push({ i, apart: scan.apart(a, b) });
      }
      const fits = cuts.filter((c) => !over(all.slice(c.i)));
      const cut = fits.filter((c) => c.apart).at(-1) ?? fits.at(-1);
      if (cut) {
        out.push(all.slice(0, cut.i).map((c) => c.commit));
        current = all.slice(cut.i);
        continue;
      }
    }
    current.push(next);
  }
  out.push(current.map((c) => c.commit));
  return out.map((commits, i) => {
    const next = out[i + 1]?.[0];
    return {
      commits,
      scanned_until: next ? new Date(Math.min(Date.parse(next.landed_at) - 1, Date.parse(scan.scanned_until))).toISOString() : scan.scanned_until,
      through: next ? scan.before(next) : scan.through,
    };
  });
}

/** How long a run waits when the server says it is asked too often, and how many times. */
const WAIT_AT_MOST = 300_000;
const WAIT_UNSAID = 60_000;
const TRIES = 3;

/** How long `Retry-After` says to wait (seconds, or a date), in milliseconds; a minute when it says nothing, as the server's limit is per minute. */
export function waitOf(retryAfter, now = Date.now()) {
  const text = String(retryAfter ?? "").trim();
  if (/^\d+$/.test(text)) return Math.min(WAIT_AT_MOST, Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? WAIT_UNSAID : Math.min(WAIT_AT_MOST, Math.max(0, at - now));
}

/**
 * Read the later commits of merged pull requests that are due, on the
 * branches they were merged into, and tell the server: it says which are
 * due and which files, and keeps what those commits did to the pull
 * requests' lines. Needs the repository checked out with its history
 * (`fetch-depth: 0`): without a checkout, that is said and nothing is read.
 * A server from before this is said, and skipped. A branch that cannot be
 * read is said and the others are read; the run fails at the end.
 */
export async function runOutcomes(env, { api, server, repo, host, log, git, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const name = `${host}/${repo}`;
  const since = (env.SESSIONLY_OUTCOMES_SINCE ?? "").trim();
  if (since && Number.isNaN(Date.parse(since))) throw new Error(`the outcomes-since input is not a date: ${since}`);
  let due;
  try {
    due = await server("GET", `/prs/outcomes/due?repo=${encodeURIComponent(name)}${since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : ""}`);
  } catch (err) {
    // A server from before this has no such address, and tells a ci token so.
    if (err.status === 404 || (err.status === 403 && /only reports pull requests/.test(err.message ?? ""))) {
      log(`::warning title=Sessionly::The Sessionly server does not read later commits of merged pull requests (${err.message}): it is from before that. Nothing else is affected.`);
      return { skipped: true, stored: [] };
    }
    if (err.status === 403) throw new Error(`the Sessionly server would not say which merged pull requests are due (${err.message}): the token needs the ci or admin role`);
    throw err;
  }
  const branches = Array.isArray(due?.branches) ? due.branches : [];
  if (branches.length === 0) {
    log("No merged pull request was due for its later commits to be read.");
    return { stored: [], left: false };
  }
  // Without a checkout there is no history to read: a job that only counts after merge has none.
  let shallow;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim();
  } catch (err) {
    log(
      `::notice title=Sessionly::Later commits of merged pull requests were not read: the repository is not checked out here (${oneLine(err)}). ` +
        "To read them, add actions/checkout with fetch-depth: 0 before this step; to stop this notice, set outcomes: false.",
    );
    return { skipped: true, stored: [] };
  }
  if (shallow !== "false") throw new Error("the checkout has only the latest commits: give actions/checkout fetch-depth: 0, so the base branch's history can be read");
  const of = wordsOf(env.SESSIONLY_FIX_WORDS, env.SESSIONLY_BUG_LABELS);
  const github = asking(api, repo, log);
  const stored = [];
  const failed = [];
  let left = false;
  /** Tell the server; a refusal is marked as its own, and a 429 waited out. */
  const put = async (body) => {
    for (let tries = 1; ; tries += 1) {
      try {
        return await server("PUT", "/prs/outcomes", body);
      } catch (err) {
        if (err.status !== 429 || tries >= TRIES) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { sending: true });
        await wait(waitOf(err.retryAfter));
      }
    }
  };
  for (const branch of branches) {
    try {
      const read = await scanBranch({ git, api, repo, branch, words: of, log, now: now(), github });
      if (!read.tip) {
        if (!read.gone) {
          log(`::warning title=Sessionly::origin/${branch.base_ref} is not in the checkout, so its later commits were not read. Check it out with fetch-depth: 0.`);
          continue;
        }
        // Deleted since (a branch others were stacked on goes once it is merged itself): the server stops asking.
        const gone = branch.pulls.map((p) => p.number).slice(0, MOST_LISTED);
        log(`::notice title=Sessionly::${branch.base_ref} is not on GitHub any more, so the later commits of ${gone.length} pull requests merged into it cannot be read. The server is told, and stops asking for them.`);
        await put({ repo: name, base_ref: branch.base_ref, tip: null, scanned_until: new Date(now()).toISOString(), pulls: [], commits: [], gone });
        continue;
      }
      // The files each was read in: one the server has matched with another meanwhile is left as it is.
      const paths = new Map(branch.pulls.filter((p) => Array.isArray(p.paths)).map((p) => [p.number, p.paths]));
      for (const scan of read.scans) {
        if (scan.stopped) {
          left = true;
          log(`::warning title=Sessionly::${scan.stopped}, so later commits of ${branch.base_ref} from ${scan.scanned_until} on are left for the next run.`);
        }
        let from = scan.from;
        for (const part of chunks(scan)) {
          const tips = scan.tipsAt(part.through);
          const pulls = scan.pulls.map((p) => ({
            ...p,
            ...(paths.has(p.number) ? { paths: paths.get(p.number) } : {}),
            ...(from ? { from: from.get(p.number) ?? null, tips: tips.get(p.number) ?? null } : {}),
          }));
          const body = { repo: name, base_ref: branch.base_ref, tip: scan.tip, scanned_until: part.scanned_until, pulls, commits: part.commits };
          const answer = await put(body);
          stored.push(...(answer.stored ?? []));
          if (from) from = tips;
        }
      }
    } catch (err) {
      // What the server says of one branch's report is about that one; anything else from it, the next would meet too.
      if (err.sending && ![400, 413, 422].includes(err.status)) throw err;
      failed.push(branch.base_ref);
      log(`::warning title=Sessionly::Later commits of ${branch.base_ref} could not be read (${oneLine(err)}). The other branches are read, and it is tried again at the next run.`);
    }
  }
  const said = { revert: "a revert", fix: "a fix", rework: "rework" };
  for (const row of stored) log(`#${row.number}: ${row.sha.slice(0, 12)} changed its lines (${said[row.kind] ?? row.kind}).`);
  log(`Read later commits for ${branches.reduce((n, b) => n + b.pulls.length, 0)} merged pull requests of ${repo}: ${stored.length === 0 ? "none" : stored.length} changed their lines.`);
  if (failed.length > 0) throw Object.assign(new Error(`later commits of ${failed.join(", ")} could not be read`), { stored, left });
  return { stored, left };
}
