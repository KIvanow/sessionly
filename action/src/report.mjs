// From what GitHub says about a pull request to what Sessionly is told.
import { readFileSync } from "node:fs";
import { addedHashes } from "./lines.mjs";

/**
 * This Action's version, from its package.json. Bump it with every change
 * to what a report contains, and the same string on the server
 * (`CURRENT_ACTION` in apps/server/src/pulls.ts).
 */
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Whose a review or comment is. An account deleted since has no user, and is "unknown" wherever it is named. */
const loginOf = (user) => user?.login ?? "unknown";

/** A full commit SHA: SHA-1 or SHA-256, in lowercase hex. */
export const isSha = (text) => typeof text === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text);

const isBot = (user) => user?.type === "Bot" || /\[bot\]$/.test(user?.login ?? "");

/** The server takes no more rounds than this for one pull request, no more names for one round, and no more names in all. */
export const MAX_ROUNDS = 300;
export const MAX_ROUND_AUTHORS = 50;
export const MAX_ROUND_NAMES = 2000;

/** Whether the server takes these rounds' names (`MAX_ROUNDS` and the two beside it). */
const fits = (rounds) =>
  rounds.length <= MAX_ROUNDS &&
  rounds.every((round) => round.length <= MAX_ROUND_AUTHORS) &&
  rounds.reduce((names, round) => names + round.length, 0) <= MAX_ROUND_NAMES;

/**
 * The rounds of review, oldest first: for each time review feedback was
 * followed by a new commit (how many there are is `review_rounds`), who
 * gave the feedback it followed, as
 * `{ author, bot }`, by login. Feedback is a review that comments or asks
 * for changes, or a comment on the diff, from anyone but the author.
 */
export function roundAuthors(author, reviews, comments, commits) {
  const events = [];
  for (const review of reviews) {
    const feedback = review.state === "CHANGES_REQUESTED" || review.state === "COMMENTED";
    if (feedback && loginOf(review.user) !== author && review.submitted_at) {
      events.push([Date.parse(review.submitted_at), "feedback", review.user]);
    }
  }
  // A comment written in a review is nobody's to act on until the review is submitted, though it
  // is dated when it was drafted: it is feedback from then.
  const submitted = new Map(reviews.filter((r) => r.id != null && r.submitted_at).map((r) => [r.id, Date.parse(r.submitted_at)]));
  for (const comment of comments) {
    if (loginOf(comment.user) !== author && comment.created_at) {
      const seen = Math.max(Date.parse(comment.created_at), submitted.get(comment.pull_request_review_id) ?? -Infinity);
      events.push([seen, "feedback", comment.user]);
    }
  }
  for (const commit of commits) {
    const at = commit.commit?.committer?.date ?? commit.commit?.author?.date;
    if (at) events.push([Date.parse(at), "commit"]);
  }
  events.sort((a, b) => a[0] - b[0]);
  const rounds = [];
  let waiting = new Map();
  for (const [, kind, user] of events) {
    if (kind === "feedback") {
      // An account that was deleted since has no user: its feedback is feedback all the same.
      const login = loginOf(user);
      waiting.set(login, { author: login, bot: waiting.get(login)?.bot === true || isBot(user) });
    } else if (waiting.size > 0) {
      rounds.push([...waiting.values()].sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : 0)));
      waiting = new Map();
    }
  }
  return rounds;
}

/** Marks the comment this Action keeps up to date. */
export const MARKER = "<!-- sessionly-pull-request-report -->";

/** The server takes no more reviews and comments than this for one pull request. */
const MAX_FEEDBACK = 2000;

/**
 * A pull request's reviews and comments, oldest first: who, when, where, and
 * the address of each on GitHub. What they say is not among it, and is never
 * sent. The Action's own comment is left out.
 */
export function feedbackOf(reviews, comments, conversation) {
  const who = (item) => ({ url: item.html_url ?? null, author: loginOf(item.user), bot: isBot(item.user) });
  const all = [];
  for (const review of reviews) {
    if (review.state === "PENDING" || !review.submitted_at) continue;
    all.push({ kind: "review", ...who(review), at: review.submitted_at, state: String(review.state ?? "").toLowerCase() || null });
  }
  for (const comment of comments) {
    if (!comment.created_at) continue;
    all.push({
      kind: "inline",
      ...who(comment),
      at: comment.created_at,
      path: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      reply: comment.in_reply_to_id != null,
    });
  }
  for (const comment of conversation) {
    if (!comment.created_at || comment.body?.includes(MARKER)) continue;
    all.push({ kind: "conversation", ...who(comment), at: comment.created_at });
  }
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The report for one pull request. `pull`, `files`, `reviews`, `comments`,
 * `conversation` and `commits` are GitHub's REST answers; `host` is the host of the GitHub
 * server (`github.com`); `ignored` says which paths to leave out.
 */
export function buildReport({ pull, files, reviews, comments, conversation = [], commits, event, host, ignored }) {
  const author = loginOf(pull.user);
  const submitted = reviews.filter((r) => loginOf(r.user) !== author && r.state !== "PENDING");
  const others = comments.filter((c) => loginOf(c.user) !== author);
  const reported = [];
  let withoutDiff = 0;
  for (const file of files) {
    if (file.status === "removed" || ignored(file.filename)) continue;
    if (typeof file.patch !== "string") {
      // No diff for a file with additions: too large for the API to show.
      if ((file.additions ?? 0) > 0) withoutDiff += 1;
      continue;
    }
    const hashes = addedHashes(file.patch);
    if (hashes.length > 0) reported.push({ path: file.filename, hashes });
  }
  // GitHub's own address, on commits made in its web pages, is nobody's.
  const emails = new Set();
  for (const { commit } of commits) {
    for (const who of [commit?.author, commit?.committer]) {
      const email = who?.email?.trim().toLowerCase();
      if (email && email !== "noreply@github.com") emails.add(email);
    }
  }
  const repo = pull.base?.repo?.full_name;
  const headRepo = pull.head?.repo?.full_name;
  const feedback = feedbackOf(reviews, comments, conversation);
  const rounds = roundAuthors(author, reviews, comments, commits);
  return {
    repo: `${host}/${repo}`,
    head_repo: headRepo && headRepo !== repo ? `${host}/${headRepo}` : null,
    commit_emails: [...emails].sort(),
    number: pull.number,
    title: pull.title ?? null,
    url: pull.html_url ?? null,
    author,
    state: pull.merged || pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
    draft: pull.draft === true,
    head_ref: pull.head?.ref ?? null,
    base_ref: pull.base?.ref ?? null,
    // Which commits: the head as reported, and once merged the one it was
    // merged as, from which later commits on the base branch are read.
    ...(isSha(pull.head?.sha) ? { head_sha: pull.head.sha } : {}),
    ...(isSha(pull.merge_commit_sha) && (pull.merged || pull.merged_at) ? { merge_commit_sha: pull.merge_commit_sha } : {}),
    created_at: pull.created_at,
    merged_at: pull.merged_at ?? null,
    closed_at: pull.closed_at ?? null,
    event,
    commits: commits.length,
    reviews: submitted.length,
    changes_requested: submitted.filter((r) => r.state === "CHANGES_REQUESTED").length,
    review_comments: others.filter((c) => !isBot(c.user)).length,
    bot_review_comments: others.filter((c) => isBot(c.user)).length,
    review_rounds: rounds.length,
    // Whose feedback each round followed. Left out where there is more of it
    // than the server takes, which would refuse the report: it is then not known.
    ...(fits(rounds) ? { review_round_authors: rounds } : {}),
    files: reported,
    files_without_diff: withoutDiff,
    // On a pull request with more than the server takes, the latest are sent,
    // with how many there are: what is counted from them is then not all of it.
    feedback: feedback.slice(-MAX_FEEDBACK),
    feedback_total: feedback.length,
    reporter: { name: "sessionly-action", version: VERSION },
  };
}

const TOOLS = { "claude-code": "Claude Code", cursor: "Cursor", grok: "Grok", codex: "Codex", opencode: "OpenCode" };
const count = (n) => n.toLocaleString("en-US");
/** A share as a whole percentage: 100% only for all of it, 0% only for none. */
function percent(part, whole) {
  if (!(whole > 0)) return "–";
  const rounded = Math.round((part / whole) * 100);
  return `${part < whole ? Math.min(rounded, 99) : part > 0 ? Math.max(rounded, 1) : rounded}%`;
}

/** Sessionly's mark, which GitHub shows in a comment through its own image proxy. */
const MARK = "https://www.sessionly.dev/favicon.svg";

/**
 * The figures as Markdown, for the run summary and the comment on the pull
 * request. `server` is the Sessionly server's address: the heading then leads
 * to its page of pull requests.
 */
export function render(report, attribution, server) {
  const { first, now, by } = attribution;
  const home = server ? `${String(server).replace(/\/+$/, "")}/#/pulls` : null;
  const name = home ? `[Sessionly](${home})` : "Sessionly";
  const out = [MARKER, `### <img src="${MARK}" width="20" height="20" align="top" alt=""> ${name}`, ""];
  if (now.lines === 0) {
    out.push("This pull request adds no lines to track.");
  } else if (now.agent_lines === 0) {
    out.push(`No lines of this pull request were matched to a coding agent session (${count(now.lines)} lines added).`);
  } else {
    out.push(
      `**${percent(now.agent_lines, now.lines)} of the lines this pull request adds were written by a coding agent** ` +
        `(${count(now.agent_lines)} of ${count(now.lines)}).`,
    );
  }
  if (now.lines > 0) {
    out.push(
      "",
      "| Lines added | By an agent | Share |",
      "|---:|---:|---:|",
      `| ${count(now.lines)} | ${count(now.agent_lines)} | ${percent(now.agent_lines, now.lines)} |`,
    );
  }
  if (now.agent_lines > 0) {
    out.push(
      "",
      "| Tool | Model | Lines |",
      "|---|---|---:|",
      ...now.by.map((b) => `| ${TOOLS[b.tool] ?? b.tool} | ${b.model ?? "not known"} | ${count(b.lines)} |`),
    );
  }
  // A cloud agent commits under its own name: without its session, what it
  // wrote cannot be told from what a person wrote.
  const cloud = attribution.cloud;
  if (cloud && cloud.sessions === 0 && now.lines > 0) {
    const agents = cloud.agents.map((tool) => TOOLS[tool] ?? tool).join(" and ");
    out.push(
      "",
      `A cloud agent worked on this pull request (${agents}), and no session of it was captured, ` +
        "so its lines count as not an agent's. `sessionly install --repo` in the repository captures them.",
    );
  }
  const surviving = by.reduce((sum, b) => sum + b.surviving, 0);
  // What review changed is only known for a pull request reported since it was opened.
  const changed = attribution.from_open && report.event !== "opened" && first.agent_lines > 0;
  if (changed) {
    out.push(
      "",
      `Of the ${count(first.agent_lines)} agent lines it had when it was opened, ` +
        `${count(surviving)} are still there (${percent(surviving, first.agent_lines)}).`,
    );
  }
  if (report.files_without_diff > 0) {
    out.push("", `${count(report.files_without_diff)} changed files were too large for GitHub to give a diff for and are not counted.`);
  }
  // What is uploaded later, and what is common, change these figures: the
  // reader should know before taking them as the last word.
  if (now.lines > 0) {
    out.push(
      "",
      "_These figures can still change. A session's lines reach Sessionly when it ends or finishes a turn, so " +
        "lines an agent wrote after this pull request was opened may not be counted yet: Sessionly counts them " +
        "as they arrive, and this comment catches up the next time the pull request is reported, as on a push or its merge. A line many sessions have added to " +
        "the same file, such as an import, counts as an agent's only for a session that wrote other lines of " +
        "this pull request, or every line of a file of it._",
    );
  }
  out.push(
    "",
    "<details>",
    "<summary>How this is counted</summary>",
    "",
    "Added lines that have a letter or digit are counted. A line counts as an agent's when a session " +
      "uploaded to Sessionly added it to the same file; everything else, including agents nobody " +
      "captured, counts as not an agent's. On a person's own machine, what an agent changed with a shell " +
      "command is counted only where it is sure to be the agent's: a long command's changes mostly are not.",
    "",
    "</details>",
  );
  return out.join("\n");
}

/**
 * The figures of several pull requests reported in one run, as Markdown for
 * the run summary: one row each, the latest first as they were reported.
 */
export function renderMany(reported, server, failed = []) {
  const home = server ? `${String(server).replace(/\/+$/, "")}/#/pulls` : null;
  const out = [`### ${home ? `[Sessionly](${home})` : "Sessionly"}`, ""];
  // The run's warnings say why.
  const not = failed.length > 0 ? ["", `Could not be reported: ${failed.map((n) => `#${n}`).join(", ")}.`] : [];
  if (reported.length === 0) return [...out, "No pull requests were reported.", ...not].join("\n");
  out.push(
    `Reported ${count(reported.length)} pull ${reported.length === 1 ? "request" : "requests"}.`,
    "",
    "| Pull request | Lines added | By an agent | Share |",
    "|---|---:|---:|---:|",
    ...reported.map(({ report, attribution: { now } }) => {
      // A title is someone's text: nothing in it may end the cell or start a link.
      const title = (report.title ?? "").replace(/[|\[\]<>`\r\n]/g, " ").trim();
      const name = `#${report.number}${title ? ` ${title}` : ""}`;
      return `| ${name} | ${count(now.lines)} | ${count(now.agent_lines)} | ${percent(now.agent_lines, now.lines)} |`;
    }),
    ...not,
  );
  return out.join("\n");
}

/**
 * What a run that counted merged pull requests again found, as Markdown for
 * the run summary: one row for each count.
 */
export function renderAfterMerge(counted, server, failed = []) {
  const home = server ? `${String(server).replace(/\/+$/, "")}/#/pulls` : null;
  const out = [`### ${home ? `[Sessionly](${home})` : "Sessionly"}`, ""];
  const not = failed.length > 0 ? ["", `Could not be counted: ${failed.map((n) => `#${n}`).join(", ")}.`] : [];
  if (counted.length === 0) return [...out, "No merged pull request was due to be counted again.", ...not].join("\n");
  out.push(
    "Agent lines still there after merging.",
    "",
    "| Pull request | After | Agent lines | Still there | Share |",
    "|---|---|---:|---:|---:|",
    ...counted.map(
      (row) =>
        `| #${row.number} | ${row.checkpoint === "7d" ? "7 days" : "30 days"} | ${count(row.agent_lines)} | ${count(row.surviving)} | ${percent(row.surviving, row.agent_lines)} |`,
    ),
    ...not,
  );
  return out.join("\n");
}
