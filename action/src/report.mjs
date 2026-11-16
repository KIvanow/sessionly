// From what GitHub says about a pull request to what Sessionly is told.
import { addedHashes } from "./lines.mjs";

const isBot = (user) => user?.type === "Bot" || /\[bot\]$/.test(user?.login ?? "");

/**
 * Times review feedback was followed by a new commit: a round of review.
 * Feedback is a review that comments or asks for changes, or a comment on
 * the diff, from anyone but the author.
 */
export function reviewRounds(author, reviews, comments, commits) {
  const events = [];
  for (const review of reviews) {
    const feedback = review.state === "CHANGES_REQUESTED" || review.state === "COMMENTED";
    if (feedback && review.user?.login !== author && review.submitted_at) {
      events.push([Date.parse(review.submitted_at), "feedback"]);
    }
  }
  for (const comment of comments) {
    if (comment.user?.login !== author && comment.created_at) {
      events.push([Date.parse(comment.created_at), "feedback"]);
    }
  }
  for (const commit of commits) {
    const at = commit.commit?.committer?.date ?? commit.commit?.author?.date;
    if (at) events.push([Date.parse(at), "commit"]);
  }
  events.sort((a, b) => a[0] - b[0]);
  let rounds = 0;
  let waiting = false;
  for (const [, kind] of events) {
    if (kind === "feedback") waiting = true;
    else if (waiting) {
      rounds += 1;
      waiting = false;
    }
  }
  return rounds;
}

/**
 * The report for one pull request. `pull`, `files`, `reviews`, `comments`
 * and `commits` are GitHub's REST answers; `host` is the host of the GitHub
 * server (`github.com`); `ignored` says which paths to leave out.
 */
export function buildReport({ pull, files, reviews, comments, commits, event, host, ignored }) {
  const author = pull.user?.login ?? "unknown";
  const submitted = reviews.filter((r) => r.user?.login !== author && r.state !== "PENDING");
  const others = comments.filter((c) => c.user?.login !== author);
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
    created_at: pull.created_at,
    merged_at: pull.merged_at ?? null,
    closed_at: pull.closed_at ?? null,
    event,
    commits: commits.length,
    reviews: submitted.length,
    changes_requested: submitted.filter((r) => r.state === "CHANGES_REQUESTED").length,
    review_comments: others.filter((c) => !isBot(c.user)).length,
    bot_review_comments: others.filter((c) => isBot(c.user)).length,
    review_rounds: reviewRounds(author, reviews, comments, commits),
    files: reported,
    files_without_diff: withoutDiff,
  };
}

const TOOLS = { "claude-code": "Claude Code", cursor: "Cursor", grok: "Grok", codex: "Codex" };
const count = (n) => n.toLocaleString("en-US");
/** A share as a whole percentage: 100% only for all of it, 0% only for none. */
function percent(part, whole) {
  if (!(whole > 0)) return "–";
  const rounded = Math.round((part / whole) * 100);
  return `${part < whole ? Math.min(rounded, 99) : part > 0 ? Math.max(rounded, 1) : rounded}%`;
}

/** Marks the comment this Action keeps up to date. */
export const MARKER = "<!-- sessionly-pull-request-report -->";

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
  out.push(
    "",
    "<details>",
    "<summary>How this is counted</summary>",
    "",
    "Added lines that have a letter or digit are counted. A line counts as an agent's when a session " +
      "uploaded to Sessionly added it to the same file; everything else, including agents nobody " +
      "captured, counts as not an agent's. On a person's own machine, what an agent changed with a shell " +
      "command is not counted, only what it changed with its file tools.",
    "",
    "</details>",
  );
  return out.join("\n");
}
