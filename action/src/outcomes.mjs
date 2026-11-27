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
import { commitOf, isAncestor, isSha, parseList, readHistory } from "./history.mjs";
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

/** Commit times are the committer's clock: the history is read this much further either way, in seconds. */
const SLACK = 86_400;
/** No fewer GitHub requests than this are left for others: a run stops asking there. */
export const RATE_FLOOR = 100;
/** No more commits than this go in one request to the server, nor much more than this much JSON. */
export const COMMITS_AT_ONCE = 500;
const BYTES_AT_ONCE = 8 * 1024 * 1024;
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
    if (!tracked.has(from)) continue;
    const key = JSON.stringify([from, to]);
    byMove.set(key, [...(byMove.get(key) ?? []), ...Array(n).fill(hash)]);
  }
  const moves = [...byMove].map(([key, hashes]) => {
    const [from, to] = JSON.parse(key);
    return { from, to, hashes: hashes.sort() };
  });
  return { files, moves };
}

/** The pull requests GitHub says a commit belongs to, and the one it landed on `base` with. */
async function pullsOf(api, repo, sha, base) {
  const found = await api.request("GET", `/repos/${repo}/commits/${sha}/pulls?per_page=100`);
  const list = Array.isArray(found) ? found : [];
  return { list, landed: list.find((p) => p.merged_at && p.base?.ref === base) };
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
      const why = String(err.message ?? err).replace(/\r?\n/g, " ");
      log(`::warning title=Sessionly::The labels of the issues pull requests close could not be read (${why}), so bug_issue is not known for them. It needs issues: read.`);
      break;
    }
  }
  return labels;
}

/**
 * Read one base branch's later commits for the pull requests due on it:
 * what the server is told of them, oldest landed first. Each that removes a
 * line in a file read is looked up on GitHub (the pull request it came with,
 * when that was merged, what it says of it); when fewer than `RATE_FLOOR`
 * requests are left, that commit and those after it are left for the next
 * run, and `scanned_until` stops before them. Null when the branch is not
 * in the checkout.
 */
export async function scanBranch({ git, api, repo, host, branch, words: of = wordsOf(), log = () => {}, now = Date.now() }) {
  const tip = commitOf(git, `refs/remotes/origin/${branch.base_ref}`)?.sha;
  if (!tip) {
    log(`::warning title=Sessionly::origin/${branch.base_ref} is not in the checkout, so its later commits were not read. Check it out with fetch-depth: 0.`);
    return null;
  }
  const readAt = Math.floor(now / 1000);
  // Which commit each pull request was merged as, whether that is in this
  // history, and so which commits come after it: only those saw its lines.
  const pulls = [];
  for (const pull of branch.pulls) {
    let sha = pull.merge_commit_sha;
    if (!sha) {
      const read = await api.request("GET", `/repos/${repo}/pulls/${pull.number}`).catch(() => null);
      sha = isSha(read?.merge_commit_sha ?? "") ? read.merge_commit_sha : null;
    }
    const found = Boolean(sha && commitOf(git, sha) && isAncestor(git, sha, tip));
    const after = new Set(found ? parseList(git(["rev-list", "--ancestry-path", "--timestamp", `${sha}..${tip}`])).map((c) => c.sha) : []);
    pulls.push({ number: pull.number, merge_commit_sha: sha, found, after });
  }
  // From a day before the earliest due, to a day past the latest end of 30 days.
  const since = Math.max(0, Math.floor(Date.parse(branch.since) / 1000) - SLACK);
  const until = Math.min(readAt, Math.floor(Date.parse(branch.until) / 1000) + SLACK);
  const { commits, paths } = readHistory(git, tip, since, until, [...new Set(branch.pulls.flatMap((p) => p.paths))]);
  const tracked = new Set(paths);
  const kept = [];
  let stoppedAt = null;
  for (const commit of commits) {
    // The one a pull request was merged as is its own, not later.
    if (pulls.some((p) => p.merge_commit_sha === commit.sha)) continue;
    const { files, moves } = toSend(commit, tracked);
    if (files.length === 0 && moves.length === 0) continue;
    const named = reverts(commit.message).slice(0, 20);
    const sent = {
      sha: commit.sha,
      url: `https://${host}/${repo}/commit/${commit.sha}`,
      landed_at: new Date(commit.at * 1000).toISOString(),
      pulls: [],
      after: pulls.filter((p) => p.after.has(commit.sha)).map((p) => p.number),
      signals: signals(commit.message, of),
      reverts: { shas: named, pulls: [] },
      removed_total: commit.removedTotal,
      files,
      ...(moves.length > 0 ? { moves } : {}),
    };
    // A revert of a commit that is itself a revert (or a reapply) puts lines back, and reverts nothing.
    const reverted = named.map((sha) => commitOf(git, sha)).filter(Boolean);
    if (reverted.some((r) => putsBack(r.message))) sent.reapply = true;
    if (files.some((f) => f.removed.length > 0)) {
      if (api.remaining !== undefined && api.remaining < RATE_FLOOR) {
        stoppedAt = commit.at;
        break;
      }
      try {
        const { list, landed } = await pullsOf(api, repo, commit.sha, branch.base_ref);
        sent.pulls = list.map((p) => p.number).filter(Number.isInteger);
        if (landed) {
          sent.landed_at = new Date(landed.merged_at).toISOString();
          sent.meta = landed;
        }
        // The pull requests of the commits it reverts (a rebase merge's, which no SHA of the pull request names).
        if (!sent.reapply) {
          for (const r of reverted) {
            const theirs = await pullsOf(api, repo, r.sha, branch.base_ref);
            if (theirs.landed) sent.reverts.pulls.push(theirs.landed.number);
          }
        }
      } catch (err) {
        if (err.status !== 403 && err.status !== 429) throw err;
        stoppedAt = commit.at;
        break;
      }
    }
    kept.push(sent);
  }
  // What the pull requests the commits came with say: their title, branch, body and linked issues' labels.
  const metas = kept.filter((c) => c.meta);
  const labels = metas.length > 0 ? await closedLabels(api, repo, [...new Set(metas.map((c) => c.meta.number))], log) : new Map();
  for (const commit of metas) {
    const { title, head, body, number } = commit.meta;
    const said = pullSignals({ title, head_ref: head?.ref, body, labels: labels.get(number) ?? [] }, repo, of);
    commit.signals = [...new Set([...commit.signals, ...said.signals])];
    if (!commit.reapply) commit.reverts.pulls = [...new Set([...commit.reverts.pulls, ...said.reverts])];
    delete commit.meta;
  }
  // In the order they landed; those that landed together, as git walked them.
  const ordered = kept
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Date.parse(a.c.landed_at) - Date.parse(b.c.landed_at) || a.i - b.i)
    .map(({ c }) => c);
  return {
    tip,
    scanned_until: new Date((stoppedAt === null ? until : Math.min(until, stoppedAt - 1)) * 1000).toISOString(),
    stopped: stoppedAt !== null,
    pulls: pulls.map(({ number, merge_commit_sha, found }) => ({ number, merge_commit_sha, found })),
    commits: ordered,
  };
}

/**
 * A branch's scan cut into requests the server takes: at most
 * `COMMITS_AT_ONCE` commits each, and about `BYTES_AT_ONCE`, cut only
 * between commits that landed at different times. Each but the last says it
 * was read up to just before the next one's first commit landed, so that
 * one that fails leaves those after it for the next run.
 */
export function chunks(scan) {
  const out = [];
  let current = [];
  let bytes = 0;
  for (const commit of scan.commits) {
    const size = JSON.stringify(commit).length;
    const full = current.length >= COMMITS_AT_ONCE || bytes + size > BYTES_AT_ONCE;
    if (full && current.length > 0 && current.at(-1).landed_at !== commit.landed_at) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(commit);
    bytes += size;
  }
  out.push(current);
  return out.map((commits, i) => ({
    commits,
    scanned_until:
      i + 1 < out.length ? new Date(Math.min(Date.parse(out[i + 1][0].landed_at) - 1, Date.parse(scan.scanned_until))).toISOString() : scan.scanned_until,
  }));
}

/** How long a run waits when the server says it is asked too often, and how many times. */
const WAIT_AT_MOST = 60_000;
const TRIES = 3;

/**
 * Read the later commits of merged pull requests that are due, on the
 * branches they were merged into, and tell the server: it says which are
 * due and which files, and keeps what those commits did to the pull
 * requests' lines. Needs the repository checked out with its history
 * (`fetch-depth: 0`). A server from before this is said, and skipped.
 */
export async function runOutcomes(env, { api, server, repo, host, log, git, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const name = `${host}/${repo}`;
  const since = (env.SESSIONLY_OUTCOMES_SINCE ?? "").trim();
  if (since && Number.isNaN(Date.parse(since))) throw new Error(`the outcomes-since input is not a date: ${since}`);
  let due;
  try {
    due = await server("GET", `/prs/outcomes/due?repo=${encodeURIComponent(name)}${since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : ""}`);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      log(`::warning title=Sessionly::The Sessionly server does not read later commits of merged pull requests (${err.message}): it is from before that. Nothing else is affected.`);
      return { skipped: true, stored: [] };
    }
    throw err;
  }
  const branches = Array.isArray(due?.branches) ? due.branches : [];
  if (branches.length === 0) {
    log("No merged pull request was due for its later commits to be read.");
    return { stored: [], left: false };
  }
  // A shallow checkout has no history to read.
  let shallow;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim();
  } catch (err) {
    throw new Error(`the repository is not checked out here (${err.message}): add actions/checkout with fetch-depth: 0 before this step`);
  }
  if (shallow !== "false") throw new Error("the checkout has only the latest commits: give actions/checkout fetch-depth: 0, so the base branch's history can be read");
  const of = wordsOf(env.SESSIONLY_FIX_WORDS, env.SESSIONLY_BUG_LABELS);
  const stored = [];
  let left = false;
  for (const branch of branches) {
    const scan = await scanBranch({ git, api, repo, host, branch, words: of, log });
    if (!scan) continue;
    if (scan.stopped) {
      left = true;
      log(`::warning title=Sessionly::GitHub allows this run few more requests, so later commits of ${branch.base_ref} from ${scan.scanned_until} on are left for the next run.`);
    }
    for (const part of chunks(scan)) {
      const body = { repo: name, base_ref: branch.base_ref, tip: scan.tip, scanned_until: part.scanned_until, pulls: scan.pulls, commits: part.commits };
      for (let tries = 1; ; tries += 1) {
        try {
          const answer = await server("PUT", "/prs/outcomes", body);
          stored.push(...(answer.stored ?? []));
          break;
        } catch (err) {
          if (err.status !== 429 || tries >= TRIES) throw err;
          await wait(Math.min(WAIT_AT_MOST, (Number(err.retryAfter) || 10) * 1000));
        }
      }
    }
  }
  const said = { revert: "a revert", fix: "a fix", rework: "rework" };
  for (const row of stored) log(`#${row.number}: ${row.sha.slice(0, 12)} changed its lines (${said[row.kind] ?? row.kind}).`);
  log(`Read later commits for ${branches.reduce((n, b) => n + b.pulls.length, 0)} merged pull requests of ${repo}: ${stored.length === 0 ? "none" : stored.length} changed their lines.`);
  return { stored, left };
}
