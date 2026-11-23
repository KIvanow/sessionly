import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { all, branchFor, fileOn, filesAt, FILES_AT_ONCE, github } from "../src/github.mjs";
import { addedHashes, fileHashes, ignoring, lineHash } from "../src/lines.mjs";
import { ask, eventName, MOST_AT_ONCE, MOST_FILES, run, send, wanted, whenOpened } from "../src/main.mjs";
import { buildReport, feedbackOf, MARKER, render, roundAuthors } from "../src/report.mjs";

const ACTION_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("lines hash exactly as in the sessionly binary", () => {
  const { cases } = JSON.parse(readFileSync(new URL("./line-hashes.json", import.meta.url), "utf8"));
  assert.ok(cases.length > 20);
  for (const { line, hash } of cases) assert.equal(lineHash(line), hash, JSON.stringify(line));
});

const PATCH = [
  "@@ -1,4 +1,6 @@",
  " fn main() {",
  "-    old();",
  "+    one();",
  "+",
  "+    }",
  "+    two();   ",
  " }",
  "\\ No newline at end of file",
].join("\n");

test("only the tracked lines a patch adds are hashed", () => {
  assert.deepEqual(addedHashes(PATCH), [lineHash("one();"), lineHash("two();")]);
  assert.deepEqual(addedHashes("@@ -1 +0,0 @@\n-gone();"), []);
  // a line of the file that itself starts with + or -
  assert.deepEqual(addedHashes("@@ -0,0 +1,2 @@\n++x;\n+-- note"), [lineHash("+x;"), lineHash("-- note")]);
});

test("files can be left out by name, path or pattern", () => {
  const ignored = ignoring("package-lock.json, *.min.js\n docs/generated/*\n\n/exact/path.txt");
  for (const path of ["package-lock.json", "apps/web/package-lock.json", "a/b.min.js", "docs/generated/x/y.md"]) {
    assert.ok(ignored(path), path);
  }
  for (const path of ["package.json", "src/min.js", "other/docs/generated/x.md", "my-package-lock.json"]) {
    assert.ok(!ignored(path), path);
  }
  assert.ok(!ignoring("")("anything"));
});

const at = (minute) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`;
const commit = (minute, email = "Ann@Example.com") => ({
  commit: { author: { email }, committer: { email: "noreply@github.com", date: at(minute) } },
});
const review = (login, state, minute, type = "User") => ({ user: { login, type }, state, submitted_at: at(minute) });
const comment = (login, minute, type = "User") => ({ user: { login, type }, created_at: at(minute) });

test("a round of review is feedback followed by a commit", () => {
  const rounds = (reviews, comments, commits) => roundAuthors("ann", reviews, comments, commits).length;
  assert.equal(rounds([], [], [commit(1), commit(2)]), 0);
  // two reviews, then one push: one round; then a bot comment and a push: two
  assert.equal(
    rounds(
      [review("bob", "COMMENTED", 5), review("cy", "CHANGES_REQUESTED", 6), review("bob", "APPROVED", 30)],
      [comment("coderabbitai[bot]", 12, "Bot")],
      [commit(1), commit(10), commit(11), commit(20)],
    ),
    2,
  );
  // feedback nobody acted on, an approval, and the author's own replies are not rounds
  assert.equal(rounds([review("bob", "CHANGES_REQUESTED", 5)], [], [commit(1)]), 0);
  assert.equal(rounds([review("bob", "APPROVED", 5)], [comment("ann", 6)], [commit(1), commit(9)]), 0);
});

test("each round says whose feedback it followed, by login, a bot's marked", () => {
  const rounds = (reviews, comments, commits) => roundAuthors("ann", reviews, comments, commits);
  assert.deepEqual(rounds([], [], [commit(1), commit(2)]), []);
  assert.deepEqual(
    rounds(
      [review("bob", "COMMENTED", 5), review("cy", "CHANGES_REQUESTED", 6), review("bob", "COMMENTED", 7), review("bob", "APPROVED", 30)],
      // the first comes before any commit after it; the last has no commit after it
      [comment("coderabbitai[bot]", 12, "Bot"), comment("ann", 13), comment("sonar", 14, "Bot"), comment("dee", 25)],
      [commit(1), commit(10), commit(11), commit(20)],
    ),
    [
      [{ author: "bob", bot: false }, { author: "cy", bot: false }],
      [{ author: "coderabbitai[bot]", bot: true }, { author: "sonar", bot: true }],
    ],
  );
  // feedback of an account deleted since is feedback, and no commit
  const gone = { user: null, created_at: at(6) };
  assert.deepEqual(rounds([], [comment("bob", 5), gone], [commit(1)]), []);
  assert.deepEqual(rounds([], [comment("bob", 5), gone, comment("bob", 7)], [commit(1), commit(9)]), [[{ author: "bob", bot: false }, { author: "unknown", bot: false }]]);
  assert.deepEqual(rounds([], [gone], [commit(1), commit(9)]), [[{ author: "unknown", bot: false }]]);
  // the author's account was deleted too: what it said on its own pull request is the author's, and no feedback
  assert.deepEqual(roundAuthors("unknown", [], [gone, comment("bob", 7)], [commit(1), commit(9)]), [[{ author: "bob", bot: false }]]);
  assert.deepEqual(roundAuthors("unknown", [], [gone], [commit(1), commit(9)]), []);
  // a comment drafted in a review before a push, in a review submitted after it: feedback from when it was submitted
  const drafted = { ...comment("bob", 5), pull_request_review_id: 77 };
  const sent = { ...review("bob", "COMMENTED", 12), id: 77 };
  assert.deepEqual(rounds([sent], [drafted], [commit(1), commit(10)]), []);
  assert.deepEqual(rounds([sent], [drafted], [commit(1), commit(10), commit(20)]), [[{ author: "bob", bot: false }]]);
  // the report counts as many rounds as it names
  const some = buildReport({ ...GITHUB, event: "synchronize", host: "github.com", ignored: () => false });
  assert.equal(some.review_round_authors.length, some.review_rounds);
  // more rounds than the server takes: the report says how many, and not whose
  const many = Array.from({ length: 1001 }, (_, i) => i);
  const long = buildReport({
    ...GITHUB,
    reviews: [],
    comments: many.map((i) => ({ user: { login: "bob", type: "User" }, created_at: new Date(Date.UTC(2026, 10, 10, 10, 0, 2 * i)).toISOString() })),
    commits: many.map((i) => ({ commit: { author: { email: "a@b.c" }, committer: { date: new Date(Date.UTC(2026, 10, 10, 10, 0, 2 * i + 1)).toISOString() } } })),
    event: "synchronize", host: "github.com", ignored: () => false,
  });
  assert.deepEqual([long.review_rounds, "review_round_authors" in long], [1001, false]);
});

const PULL = {
  number: 7,
  title: "Add the parser",
  html_url: "https://github.com/acme/web/pull/7",
  user: { login: "ann" },
  state: "open",
  merged: false,
  draft: false,
  created_at: at(0),
  head: { ref: "parser", repo: { full_name: "ann/web" } },
  base: { ref: "main", repo: { full_name: "acme/web" } },
};
const FILES = [
  { filename: "src/parser.rs", status: "modified", additions: 4, patch: PATCH },
  { filename: "pnpm-lock.yaml", status: "modified", additions: 900, patch: "@@ -1 +1 @@\n+lock: 1" },
  { filename: "src/gone.rs", status: "removed", additions: 0, patch: "@@ -1 +0,0 @@\n-x();" },
  { filename: "data/huge.json", status: "added", additions: 90000 },
  { filename: "logo.png", status: "added", additions: 0 },
  { filename: "src/braces.rs", status: "modified", additions: 1, patch: "@@ -1 +1,2 @@\n }\n+}" },
];
const GITHUB = {
  pull: PULL,
  files: FILES,
  reviews: [
    review("coderabbitai[bot]", "COMMENTED", 5, "Bot"),
    review("bob", "CHANGES_REQUESTED", 6),
    review("ann", "COMMENTED", 7),
    review("bob", "PENDING", 8),
  ],
  comments: [comment("coderabbitai[bot]", 5, "Bot"), comment("coderabbitai[bot]", 5, "Bot"), comment("bob", 6), comment("ann", 7)],
  commits: [commit(1), commit(15)],
};
const build = (overrides = {}) =>
  buildReport({ ...GITHUB, event: "synchronize", host: "github.com", ignored: ignoring("pnpm-lock.yaml"), ...overrides });

test("a report names this Action and the version in package.json", () => {
  assert.deepEqual(build().reporter, { name: "sessionly-action", version: ACTION_VERSION });
});

test("a report says where the pull request stands and what it adds", () => {
  assert.deepEqual(build(), {
    repo: "github.com/acme/web",
    head_repo: "github.com/ann/web",
    commit_emails: ["ann@example.com"],
    number: 7,
    title: "Add the parser",
    url: "https://github.com/acme/web/pull/7",
    author: "ann",
    state: "open",
    draft: false,
    head_ref: "parser",
    base_ref: "main",
    created_at: at(0),
    merged_at: null,
    closed_at: null,
    event: "synchronize",
    commits: 2,
    reviews: 2,
    changes_requested: 1,
    review_comments: 1,
    bot_review_comments: 2,
    review_rounds: 1,
    review_round_authors: [[{ author: "bob", bot: false }, { author: "coderabbitai[bot]", bot: true }]],
    files: [{ path: "src/parser.rs", hashes: [lineHash("one();"), lineHash("two();")] }],
    files_without_diff: 1,
    feedback: [
      { kind: "review", url: null, author: "coderabbitai[bot]", bot: true, at: at(5), state: "commented" },
      { kind: "inline", url: null, author: "coderabbitai[bot]", bot: true, at: at(5), path: null, line: null, reply: false },
      { kind: "inline", url: null, author: "coderabbitai[bot]", bot: true, at: at(5), path: null, line: null, reply: false },
      { kind: "review", url: null, author: "bob", bot: false, at: at(6), state: "changes_requested" },
      { kind: "inline", url: null, author: "bob", bot: false, at: at(6), path: null, line: null, reply: false },
      { kind: "review", url: null, author: "ann", bot: false, at: at(7), state: "commented" },
      { kind: "inline", url: null, author: "ann", bot: false, at: at(7), path: null, line: null, reply: false },
    ],
    feedback_total: 7,
    reporter: { name: "sessionly-action", version: ACTION_VERSION },
  });
  const merged = build({ pull: { ...PULL, state: "closed", merged: true, merged_at: at(40), closed_at: at(40) } });
  assert.deepEqual([merged.state, merged.merged_at], ["merged", at(40)]);
  assert.equal(build({ pull: { ...PULL, state: "closed" } }).state, "closed");
  // a branch in the same repository is not a fork
  const same = { ...PULL, head: { ref: "parser", repo: { full_name: "acme/web" } } };
  assert.equal(build({ pull: same }).head_repo, null);
});

const ATTRIBUTION = {
  from_open: true,
  first: { lines: 1000, agent_lines: 400 },
  now: {
    lines: 1200,
    agent_lines: 450,
    by: [
      { tool: "claude-code", model: "claude-opus-5-5", lines: 300 },
      { tool: "cursor", model: null, lines: 150 },
    ],
  },
  by: [
    { tool: "claude-code", model: "claude-opus-5-5", lines: 300, surviving: 240 },
    { tool: "cursor", model: null, lines: 100, surviving: 100 },
  ],
};

test("reviews and comments are reported as who, when, where and a link, never as what they say", () => {
  const said = "this parser leaks SECRET_TEXT";
  const reviews = [
    { id: 1, user: { login: "bob", type: "User" }, state: "APPROVED", submitted_at: at(9), body: said, html_url: "https://github.com/acme/web/pull/7#pullrequestreview-1" },
    // not submitted yet: nobody else can see it
    { id: 2, user: { login: "bob", type: "User" }, state: "PENDING", body: said },
  ];
  const comments = [
    { id: 3, user: { login: "coderabbitai[bot]", type: "Bot" }, created_at: at(4), body: said, diff_hunk: said, path: "src/parser.rs", line: 12, html_url: "https://github.com/acme/web/pull/7#discussion_r3" },
    // an answer, on a line that has since changed
    { id: 4, user: { login: "ann", type: "User" }, created_at: at(6), body: said, path: "src/parser.rs", line: null, original_line: 12, in_reply_to_id: 3, html_url: "https://github.com/acme/web/pull/7#discussion_r4" },
  ];
  const conversation = [
    { id: 5, user: { login: "vercel[bot]", type: "Bot" }, created_at: at(1), body: said, html_url: "https://github.com/acme/web/pull/7#issuecomment-5" },
    // the Action's own comment is not feedback
    { id: 6, user: { login: "github-actions[bot]", type: "Bot" }, created_at: at(2), body: `${MARKER}\n### Sessionly` },
  ];
  const feedback = feedbackOf(reviews, comments, conversation);
  assert.deepEqual(feedback, [
    { kind: "conversation", url: "https://github.com/acme/web/pull/7#issuecomment-5", author: "vercel[bot]", bot: true, at: at(1) },
    { kind: "inline", url: "https://github.com/acme/web/pull/7#discussion_r3", author: "coderabbitai[bot]", bot: true, at: at(4), path: "src/parser.rs", line: 12, reply: false },
    { kind: "inline", url: "https://github.com/acme/web/pull/7#discussion_r4", author: "ann", bot: false, at: at(6), path: "src/parser.rs", line: 12, reply: true },
    { kind: "review", url: "https://github.com/acme/web/pull/7#pullrequestreview-1", author: "bob", bot: false, at: at(9), state: "approved" },
  ]);
  // Nothing anyone wrote is in the report, whatever else changes in it.
  const report = buildReport({ ...GITHUB, reviews, comments, conversation, event: "review", host: "github.com", ignored: ignoring("") });
  assert.deepEqual(report.feedback, feedback);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_TEXT|leaks/);
  // The comments under a pull request change none of the counts.
  assert.deepEqual([report.reviews, report.review_comments, report.bot_review_comments], [1, 0, 1]);
  assert.equal(report.feedback_total, 4);
  // More than the server takes: the latest are sent, with how many there are.
  const many = Array.from({ length: 2100 }, (_, i) => ({ user: { login: "bob" }, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  const latest = buildReport({ ...GITHUB, reviews: [], comments: [], conversation: many, event: "review", host: "github.com", ignored: ignoring("") });
  assert.deepEqual([latest.feedback.length, latest.feedback_total], [2000, 2100]);
  assert.equal(latest.feedback.at(-1).at, "2026-01-01T00:34:59.000Z");
});

test("the figures as text", () => {
  const text = render(build(), ATTRIBUTION);
  assert.ok(text.startsWith(MARKER));
  // Headed by the mark and the name, which leads to the server's page of pull requests when the server is known.
  assert.match(text, /^### <img src="https:\/\/www\.sessionly\.dev\/favicon\.svg" width="20" height="20" align="top" alt=""> Sessionly$/m);
  assert.match(render(build(), ATTRIBUTION, "https://sessionly.example.com/"), /> \[Sessionly\]\(https:\/\/sessionly\.example\.com\/#\/pulls\)$/m);
  // The figures at a glance, then by tool and model.
  assert.match(text, /\| Lines added \| By an agent \| Share \|\n\|---:\|---:\|---:\|\n\| 1,200 \| 450 \| 38% \|/);
  // How it is counted is there for whoever asks, folded away.
  assert.match(text, /<details>\n<summary>How this is counted<\/summary>\n\n[^\n]*shell command is counted only where it is sure[^\n]*\n\n<\/details>$/);
  assert.match(text, /\*\*38% of the lines this pull request adds were written by a coding agent\*\* \(450 of 1,200\)/);
  assert.match(text, /\| Claude Code \| claude-opus-5-5 \| 300 \|/);
  assert.match(text, /\| Cursor \| not known \| 150 \|/);
  assert.match(text, /Of the 400 agent lines it had when it was opened, 340 are still there \(85%\)/);
  assert.doesNotMatch(render(build(), { ...ATTRIBUTION, from_open: false }), /still there/);
  // nearly all is not all
  const nearly = { ...ATTRIBUTION, by: [{ tool: "cursor", model: null, lines: 400, surviving: 399 }] };
  assert.match(render(build(), nearly), /399 are still there \(99%\)/);
  assert.match(text, /1 changed files were too large/);
  // in italics, that what arrives later, and what is common, change them, ahead of how it is counted
  assert.match(text, /\n_These figures can still change\. [^\n]*not be counted yet[^\n]*such as an import[^\n]*_\n\n<details>/);
  // when it has just been opened there is nothing to compare with yet
  assert.doesNotMatch(render(build({ event: "opened" }), ATTRIBUTION), /still there/);
  const none = { first: { lines: 9, agent_lines: 0 }, now: { lines: 9, agent_lines: 0, by: [] }, by: [] };
  assert.match(render(build(), none), /No lines of this pull request were matched/);
  assert.match(render(build(), none), /\| 9 \| 0 \| 0% \|/);
  assert.doesNotMatch(render(build(), none), /\| Tool \|/);
  const empty = { first: { lines: 0, agent_lines: 0 }, now: { lines: 0, agent_lines: 0, by: [] }, by: [] };
  assert.match(render(build(), empty), /adds no lines to track/);
  assert.doesNotMatch(render(build(), empty), /\| Lines added \|/);
  assert.doesNotMatch(render(build(), empty), /can still change/);
  // a cloud agent's pull request whose session nobody captured says so
  const uncaptured = { ...none, cloud: { agents: ["cursor"], sessions: 0 } };
  assert.match(render(build(), uncaptured), /A cloud agent worked on this pull request \(Cursor\), and no session of it was captured/);
  assert.doesNotMatch(render(build(), { ...ATTRIBUTION, cloud: { agents: ["cursor"], sessions: 1 } }), /cloud agent/);
  assert.doesNotMatch(render(build(), { ...ATTRIBUTION, cloud: null }), /cloud agent/);
});

test("events are named for the server", () => {
  assert.equal(eventName("pull_request", "opened"), "opened");
  assert.equal(eventName("pull_request_target", "closed"), "closed");
  assert.equal(eventName("pull_request_review", "submitted"), "review");
  assert.equal(eventName("pull_request_review_comment", "created"), "review_comment");
  assert.equal(eventName("workflow_dispatch"), "manual");
});

/** A stand-in for GitHub's API that remembers what was asked of it. */
function fakeGithub(comments = []) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push([method, path.replace(/[?&]per_page=.*$/, ""), body]);
    if (method !== "GET") return {};
    if (path.includes("/issues/")) return comments;
    if (path.includes("/files")) return FILES;
    if (path.includes("/reviews")) return GITHUB.reviews;
    if (path.includes("/comments")) return GITHUB.comments;
    if (path.includes("/commits")) return GITHUB.commits;
    return PULL;
  };
  return { request, calls };
}

function environment(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sessionly-action-"));
  const event = join(dir, "event.json");
  writeFileSync(event, JSON.stringify({ action: "opened", pull_request: { number: 7 } }));
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  return {
    SESSIONLY_URL: "https://sessionly.example.com/",
    SESSIONLY_TOKEN: "sly_secret",
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: event,
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    SESSIONLY_IGNORE: "pnpm-lock.yaml",
    ...extra,
  };
}

test("a run reads the pull request, reports it, and writes the summary and outputs", async () => {
  const api = fakeGithub();
  const sent = [];
  const env = environment();
  const deliver = async (url, token, report) => (sent.push([url, token, report]), ATTRIBUTION);
  const logged = [];
  await run(env, { api, deliver, log: (line) => logged.push(line) });

  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][0], sent[0][1]], ["https://sessionly.example.com/", "sly_secret"]);
  assert.deepEqual([sent[0][2].repo, sent[0][2].number, sent[0][2].event], ["github.com/acme/web", 7, "opened"]);
  assert.equal(sent[0][2].aliases, undefined);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "lines=1200\nagent-lines=450\n");
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /38% of the lines/);
  // the one thing written to the pull request is the comment, and the token is not logged
  assert.deepEqual(
    api.calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`),
    ["POST /repos/acme/web/issues/7/comments"],
  );
  assert.ok(!logged.join("\n").includes("sly_secret"));
});

test("the figures are posted as one comment, kept up to date rather than repeated, unless switched off", async () => {
  const deliver = async () => ATTRIBUTION;
  const writes = (api) => api.calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`);

  // On by default, and when said so.
  const fresh = fakeGithub();
  const { text } = await run(environment({ SESSIONLY_SUMMARY: "false" }), { api: fresh, deliver, log() {} });
  assert.deepEqual(writes(fresh), ["POST /repos/acme/web/issues/7/comments"]);
  assert.equal(fresh.calls.find(([method]) => method === "POST")[2].body, text);
  assert.ok(text.startsWith(MARKER));
  const asked = fakeGithub();
  await run(environment({ SESSIONLY_COMMENT: "true" }), { api: asked, deliver, log() {} });
  assert.deepEqual(writes(asked), ["POST /repos/acme/web/issues/7/comments"]);

  // The comment that is there is changed, among whatever else was said on the pull request.
  const stale = fakeGithub([{ id: 41, body: "unrelated" }, { id: 42, body: `${MARKER}\nold figures` }]);
  await run(environment(), { api: stale, deliver, log() {} });
  assert.deepEqual(writes(stale), ["PATCH /repos/acme/web/issues/comments/42"]);

  // One that already says the same is left alone: no notification for nothing.
  const current = fakeGithub([{ id: 42, body: text }]);
  await run(environment(), { api: current, deliver, log() {} });
  assert.deepEqual(writes(current), []);

  // Switched off: nothing is written to the pull request.
  for (const off of ["false", "FALSE", "0", "no", "off", ""]) {
    const quiet = fakeGithub();
    await run(environment({ SESSIONLY_COMMENT: off }), { api: quiet, deliver, log() {} });
    assert.ok(quiet.calls.every(([method]) => method === "GET"), `"${off}"`);
  }
  // The comments under the pull request are read once, for the report and for finding the Action's own.
  const reads = (api) => api.calls.filter(([method, path]) => method === "GET" && path.includes("/issues/")).length;
  assert.equal(reads(stale), 1);
  // When the Action's own is not among them they are read again before one is
  // written: another run may have written it since.
  assert.equal(reads(fresh), 2);
  const raced = fakeGithub();
  const answer = raced.request;
  let read = 0;
  raced.request = async (method, path, body) => {
    const answered = await answer(method, path, body);
    if (method !== "GET" || !path.includes("/issues/")) return answered;
    return read++ === 0 ? [] : [{ id: 43, body: `${MARKER}\nthe other run's figures` }];
  };
  await run(environment(), { api: raced, deliver, log() {} });
  assert.deepEqual(writes(raced), ["PATCH /repos/acme/web/issues/comments/43"]);
});

test("a job that may not comment still reports, and says what to change", async () => {
  // The workflow's token with pull-requests: read, as most were set up.
  const api = fakeGithub();
  const request = api.request;
  api.request = async (method, path, body) => {
    if (method !== "GET") throw new Error(`GitHub answered 403 to ${method} ${path}: {"message":"Resource not accessible by integration"}`);
    return request(method, path, body);
  };
  const sent = [];
  const logged = [];
  const env = environment();
  const out = await run(env, { api, deliver: async (...args) => (sent.push(args), ATTRIBUTION), log: (line) => logged.push(line) });
  // The report went, the outputs and the summary are written, and the run does not fail.
  assert.equal(sent.length, 1);
  assert.equal(out.attribution, ATTRIBUTION);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "lines=1200\nagent-lines=450\n");
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /38% of the lines/);
  const warnings = logged.filter((line) => line.startsWith("::warning"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be posted as a comment \(GitHub answered 403 .*Resource not accessible by integration.*\)/);
  assert.match(warnings[0], /`pull-requests: write`, or set `comment: false`/);
  assert.ok(!warnings[0].includes("\n"));
});

test("backfill first reports a pull request as it was when opened", async () => {
  const sha = (minute, id) => ({ sha: id, ...commit(minute) });
  const pull = { ...PULL, state: "closed", merged: true, merged_at: at(50), closed_at: at(50), base: { ...PULL.base, sha: "base0" } };
  // opened at minute 0 with one commit; two more pushed during review
  const commits = [sha(0, "c1"), sha(20, "c2"), sha(30, "c3")];
  const early = [{ filename: "src/parser.rs", status: "added", additions: 1, patch: "@@ -0,0 +1 @@\n+early();" }];
  const calls = [];
  const api = {
    request: async (method, path) => {
      calls.push(path.replace(/[?&]per_page=.*$/, ""));
      if (path.includes("/compare/")) return { files: early };
      if (path.includes("/files")) return FILES;
      if (path.includes("/reviews")) return GITHUB.reviews;
      if (path.includes("/comments")) return GITHUB.comments;
      if (path.includes("/commits")) return commits;
      return pull;
    },
  };
  const sent = [];
  const deliver = async (url, token, report) => (sent.push(report), ATTRIBUTION);
  const env = environment({ SESSIONLY_BACKFILL: "true", SESSIONLY_OTHER_NAMES: "oldco/web" });
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ action: "closed", pull_request: { number: 7 } }));
  await run(env, { api, deliver, log() {} });

  assert.ok(calls.includes("/repos/acme/web/compare/base0...c1"));
  assert.equal(sent.length, 2);
  const [opened, closed] = sent;
  assert.deepEqual(
    [opened.event, opened.state, opened.merged_at, opened.commits, opened.reviews, opened.review_rounds],
    ["opened", "open", null, 1, 0, 0],
  );
  assert.deepEqual(opened.files, [{ path: "src/parser.rs", hashes: [lineHash("early();")] }]);
  assert.deepEqual(opened.aliases, ["github.com/oldco/web"]);
  // The first says nothing of reviews and comments, rather than that there
  // are none: the server would drop those it has until the second arrives.
  assert.deepEqual(["feedback" in opened, "feedback_total" in opened], [false, false]);
  assert.equal(closed.feedback_total, closed.feedback.length);
  assert.ok(closed.feedback.length > 0);
  assert.deepEqual([closed.event, closed.state, closed.commits, closed.reviews], ["closed", "merged", 3, 2]);
  assert.equal(closed.files[0].hashes.length, 2);

  // nothing pushed after opening, or commits all dated later (a rebase): one report
  const none = { request: async () => assert.fail("nothing to compare") };
  assert.equal(await whenOpened(none, "acme/web", { pull, commits: [sha(0, "c1")] }), null);
  assert.equal(await whenOpened(none, "acme/web", { pull, commits: [sha(20, "c2"), sha(30, "c3")] }), null);
});

test("a run that is not about a pull request, or lacks an input, says so", async () => {
  const env = environment();
  writeFileSync(env.GITHUB_EVENT_PATH, "{}");
  await assert.rejects(run(env, { api: fakeGithub(), deliver: async () => ATTRIBUTION }), /pr-number/);
  // the input names one
  const named = await run({ ...env, SESSIONLY_PR_NUMBER: "7", GITHUB_EVENT_NAME: "workflow_dispatch" }, {
    api: fakeGithub(),
    deliver: async () => ATTRIBUTION,
    log() {},
  });
  assert.equal(named.report.event, "manual");
  // names the repository used to have, on a GitHub server of one's own
  const moved = await run(
    { ...env, SESSIONLY_PR_NUMBER: "7", SESSIONLY_OTHER_NAMES: "oldco/website, ann/web-old", GITHUB_SERVER_URL: "https://git.example.com" },
    { api: fakeGithub(), deliver: async () => ATTRIBUTION, log() {} },
  );
  assert.deepEqual(moved.report.aliases, ["git.example.com/oldco/website", "git.example.com/ann/web-old"]);
  assert.equal(moved.report.repo, "git.example.com/acme/web");
  await assert.rejects(run({ ...env, SESSIONLY_TOKEN: "" }, { api: fakeGithub() }), /token input is missing/);
});

test("the pr-number input names one pull request, several, or the latest", () => {
  assert.deepEqual(wanted("7"), { number: 7 });
  assert.deepEqual(wanted(7), { number: 7 });
  assert.deepEqual(wanted(" ALL "), { all: true });
  assert.deepEqual(wanted("20-60"), { from: 20, to: 60 });
  assert.deepEqual(wanted("20 - 20"), { from: 20, to: 20 });
  for (const not of ["", undefined, "0", "-3", "1.5", "60-20", "0-5", "some", "7,8", "1-18014398509481984", "18014398509481984"]) assert.equal(wanted(not), null, String(not));
});

/**
 * A repository whose pull requests are `pulls` (number and when created, the
 * latest first). Numbers in `issues` are not pull requests, and those in
 * `broken` cannot be read.
 */
function fakeRepository(pulls, { issues = [], broken = [], limited = [], search = true } = {}) {
  const calls = [];
  const request = async (method, path) => {
    calls.push([method, path.replace(/[?&]per_page=.*$/, "")]);
    if (method !== "GET") return {};
    const listed = /\/pulls\?state=all.*&page=(\d+)$/.exec(path);
    if (listed) return pulls.slice((Number(listed[1]) - 1) * 100, Number(listed[1]) * 100);
    if (path.startsWith("/search/issues")) {
      if (!search) throw new Error(`GitHub answered 403 to GET ${path}: Resource not accessible by integration`);
      const from = Date.parse(/created:>=([^&\s]+)/.exec(decodeURIComponent(path))[1]);
      const within = pulls.filter((pull) => Date.parse(pull.created_at) >= from);
      return { total_count: within.length, items: within.slice(-1) };
    }
    if (path.includes("/issues/")) return [];
    if (path.includes("/files")) return FILES;
    if (path.includes("/reviews")) return GITHUB.reviews;
    if (path.includes("/comments")) return GITHUB.comments;
    if (path.includes("/commits")) return GITHUB.commits;
    const number = Number(/\/pulls\/(\d+)$/.exec(path)[1]);
    if (issues.includes(number)) throw new Error(`GitHub answered 404 to GET ${path}: {"message":"Not Found"}`);
    if (limited.includes(number)) throw new Error(`GitHub answered 403 to GET ${path}: {"message":"API rate limit exceeded for installation"}`);
    if (broken.includes(number)) throw new Error(`GitHub answered 502 to GET ${path}: Bad Gateway`);
    return { ...PULL, number, title: `Change | number ${number}` };
  };
  return { request, calls };
}

test("all of a repository's latest pull requests are reported in one run, and nothing is written on them", async () => {
  const day = (n) => ({ number: n, created_at: `2026-11-${String(n).padStart(2, "0")}T10:00:00Z` });
  const api = fakeRepository([day(12), day(11), day(10), day(9), day(3)], { broken: [10] });
  const sent = [];
  const logged = [];
  const env = environment({ SESSIONLY_PR_NUMBER: "all", SESSIONLY_SINCE: "2026-11-05", SESSIONLY_COMMENT: "true", GITHUB_EVENT_NAME: "workflow_dispatch" });
  const going = run(env, { api, deliver: async (url, token, report) => (sent.push(report), ATTRIBUTION), log: (line) => logged.push(line) });
  // one that cannot be read is said, the others are still reported, and the run says so at its end
  await assert.rejects(going, /1 of 4 pull requests could not be reported: #10/);
  assert.deepEqual(sent.map((report) => [report.number, report.event]), [[12, "manual"], [11, "manual"], [9, "manual"]]);
  assert.ok(logged.some((line) => /::warning title=Sessionly::#10 could not be reported \(GitHub answered 502/.test(line)));
  // no comment on any of them, though comments are on
  assert.deepEqual(api.calls.filter(([method]) => method !== "GET"), []);
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, /Reported 3 pull requests\./);
  // a title cannot end its cell
  assert.match(summary, /\| #12 Change {3}number 12 \| 1,200 \| 450 \| 38% \|/);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "");

  // ninety days back when since does not say; a since that is no date is refused
  const recent = fakeRepository([{ number: 2, created_at: new Date().toISOString() }, { number: 1, created_at: "2020-01-01T00:00:00Z" }]);
  const quiet = { deliver: async () => ATTRIBUTION, log() {} };
  const out = await run(environment({ SESSIONLY_PR_NUMBER: "all" }), { api: recent, ...quiet });
  assert.deepEqual(out.reported.map(({ report }) => report.number), [2]);
  await assert.rejects(run(environment({ SESSIONLY_PR_NUMBER: "all", SESSIONLY_SINCE: "lately" }), { api: recent, ...quiet }), /since input is not a date/);
  const nothing = environment({ SESSIONLY_PR_NUMBER: "all" });
  await run(nothing, { api: fakeRepository([]), ...quiet });
  assert.match(readFileSync(nothing.GITHUB_STEP_SUMMARY, "utf8"), /No pull requests were reported\./);
});

test("no more are reported at once than GitHub allows for, and the run says how to go on", async () => {
  const many = Array.from({ length: MOST_AT_ONCE + 30 }, (_, i) => ({ number: 500 - i, created_at: "2026-11-10T10:00:00Z" }));
  const logged = [];
  const quiet = { deliver: async () => ATTRIBUTION, log: (line) => logged.push(line) };
  const latest = await run(environment({ SESSIONLY_PR_NUMBER: "all", SESSIONLY_SINCE: "2026-01-01" }), { api: fakeRepository(many), ...quiet });
  assert.deepEqual([latest.reported.length, latest.more], [MOST_AT_ONCE, 30]);
  assert.equal(latest.reported.at(-1).report.number, 501 - MOST_AT_ONCE);
  assert.ok(logged.some((line) => line.includes(`30 more were left for another run`) && line.includes(`pr-number 371-${500 - MOST_AT_ONCE} `)), logged.join("\n"));
  // where GitHub's search will not say how many are left or where they begin, the run says what it can
  logged.length = 0;
  const unsaid = await run(environment({ SESSIONLY_PR_NUMBER: "all", SESSIONLY_SINCE: "2026-01-01" }), { api: fakeRepository(many, { search: false }), ...quiet });
  assert.deepEqual([unsaid.reported.length, unsaid.more], [MOST_AT_ONCE, null]);
  assert.ok(logged.some((line) => line.includes("More were left") && line.includes(`pr-number 1-${500 - MOST_AT_ONCE} `) && line.includes("narrow it")), logged.join("\n"));
  // the ones before `since` are not among those to go on with
  logged.length = 0;
  const old = [...many, { number: 300, created_at: "2025-06-01T10:00:00Z" }];
  await run(environment({ SESSIONLY_PR_NUMBER: "all", SESSIONLY_SINCE: "2026-01-01" }), { api: fakeRepository(old), ...quiet });
  assert.ok(logged.some((line) => line.includes(`pr-number 371-${500 - MOST_AT_ONCE} `)), logged.join("\n"));

  // by number: the latest first, issues in between passed over without a word
  logged.length = 0;
  const api = fakeRepository([], { issues: [41, 43] });
  const some = await run(environment({ SESSIONLY_PR_NUMBER: "40-44", SESSIONLY_BACKFILL: "true" }), { api, ...quiet });
  assert.deepEqual(some.reported.map(({ report }) => report.number), [44, 42, 40]);
  assert.ok(!logged.some((line) => line.includes("::warning")), logged.join("\n"));
  assert.deepEqual(api.calls.filter(([method]) => method !== "GET"), []);
  const wide = await run(environment({ SESSIONLY_PR_NUMBER: `1-${MOST_AT_ONCE + 5}` }), { api: fakeRepository([]), ...quiet });
  assert.deepEqual([wide.reported.length, wide.more, wide.reported.at(-1).report.number], [MOST_AT_ONCE, 5, 6]);
  assert.ok(logged.some((line) => line.includes("pr-number 1-5")), logged.join("\n"));

  // one that cannot be read is named on the summary page, and the rest go on
  logged.length = 0;
  const partly = environment({ SESSIONLY_PR_NUMBER: "10-12" });
  await assert.rejects(run(partly, { api: fakeRepository([], { broken: [11] }), ...quiet }), /1 of 3 pull requests could not be reported: #11/);
  assert.match(readFileSync(partly.GITHUB_STEP_SUMMARY, "utf8"), /Reported 2 pull requests\.[\s\S]*Could not be reported: #11\./);
  // the six requests for a number are not all made to learn it is an issue's
  const issue = fakeRepository([], { issues: [31] });
  await run(environment({ SESSIONLY_PR_NUMBER: "30-31" }), { api: issue, ...quiet });
  assert.deepEqual(issue.calls.filter(([, path]) => /\/(pulls|issues)\/31/.test(path)).map(([, path]) => path), ["/repos/acme/web/pulls/31"]);
  // a range with no pull request in it is more likely a token that cannot see the repository
  await assert.rejects(
    run(environment({ SESSIONLY_PR_NUMBER: "50-52" }), { api: fakeRepository([], { issues: [50, 51, 52] }), ...quiet }),
    /none of #50 to #52 is a pull request the github-token can read/,
  );
  // a server that refuses for a reason the next would meet too is not sent the rest
  logged.length = 0;
  const unread = fakeRepository([]);
  const refused = async () => {
    throw Object.assign(new Error("the Sessionly server answered 401: missing or unknown token"), { status: 401 });
  };
  await assert.rejects(run(environment({ SESSIONLY_PR_NUMBER: "60-70" }), { api: unread, deliver: refused, log: quiet.log }), /answered 401.*#70 and the ones before it were not reported/);
  assert.ok(!unread.calls.some(([, path]) => /\/pulls\/69$/.test(path)), "read on after the server refused");
  // one that the server finds wrong is its own trouble: the rest go on
  let sent = 0;
  const wrong = async () => {
    sent += 1;
    if (sent === 1) throw Object.assign(new Error("the Sessionly server answered 422: the report does not match the schema"), { status: 422 });
    return ATTRIBUTION;
  };
  await assert.rejects(run(environment({ SESSIONLY_PR_NUMBER: "60-62" }), { api: fakeRepository([]), deliver: wrong, log: quiet.log }), /1 of 3 pull requests could not be reported: #62/);
  // when GitHub allows no more requests, the ones left are not asked for
  logged.length = 0;
  const limited = fakeRepository([], { limited: [18, 17, 16] });
  await assert.rejects(run(environment({ SESSIONLY_PR_NUMBER: "15-20" }), { api: limited, ...quiet }), /#18 and the ones before it were not reported/);
  assert.ok(logged.some((line) => line.includes("pr-number 15-18 ")), logged.join("\n"));
  assert.ok(!limited.calls.some(([, path]) => /\/pulls\/1[5-7]$/.test(path)), "asked on after the limit");
});

/** A file GitHub will not answer whole among others. */
const TOO_LARGE = "large();\n";

/** GitHub with files on branches, and a server that says which merged pull requests are due. */
function afterMerge({ due, branches = { main: {} }, refuse = {} }) {
  const calls = [];
  const sent = [];
  const api = {
    calls,
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      const branch = /\/branches\/(.+)$/.exec(path)?.[1];
      if (branch !== undefined) {
        if (branches[decodeURIComponent(branch)]) return { commit: { sha: `sha-of-${decodeURIComponent(branch)}` } };
        throw Object.assign(new Error(`GitHub answered 404 to GET ${path}: Branch not found`), { status: 404 });
      }
      return { default_branch: "main" };
    },
    text: async (path) => {
      calls.push(`TEXT ${path}`);
      const [, file, ref] = /\/contents\/(.+)\?ref=sha-of-(.+)$/.exec(path);
      return branches[decodeURIComponent(ref)]?.[decodeURIComponent(file)] ?? null;
    },
    // Each file asked for as `<commit>:<path>`, many in one question.
    graphql: async (query, variables) => {
      const asked = Object.entries(variables).filter(([key]) => /^e\d+$/.test(key));
      calls.push(`GRAPHQL ${asked.map(([, at]) => at).join(" ")}`);
      const repository = {};
      for (const [key, at] of asked) {
        const [, branch, file] = /^sha-of-([^:]+):(.+)$/.exec(at);
        const text = branches[branch]?.[file];
        repository[`f${key.slice(1)}`] = text === undefined ? null : text === TOO_LARGE ? { text: "cut", isTruncated: true, isBinary: false } : { text, isTruncated: false, isBinary: false };
      }
      return { repository };
    },
  };
  const server = async (method, path, body) => {
    if (method === "GET") return { due };
    sent.push(body);
    if (refuse[body.number]) throw Object.assign(new Error(`the Sessionly server answered ${refuse[body.number]}: no`), { status: refuse[body.number] });
    // As the server would: every age it was asked for, with a count made up from what was sent.
    const there = body.files.reduce((sum, f) => sum + f.hashes.length, 0);
    return { stored: due.find((pull) => pull.number === body.number).checkpoints.map((checkpoint) => ({ checkpoint, agent_lines: 10, surviving: there, age_seconds: 1 })) };
  };
  return { api, server, sent, calls };
}

test("a file's tracked lines are hashed as the lines of a patch are", () => {
  assert.deepEqual(fileHashes("fn main() {\r\n    one();\n\n}\n  two();  "), [lineHash("fn main() {"), lineHash("one();"), lineHash("two();")]);
  assert.deepEqual(fileHashes(""), []);
});

test("on a schedule, merged pull requests that are due are counted again on the branch they were merged into", async () => {
  const due = [
    { number: 3, base_ref: "main", checkpoints: ["30d"], paths: ["src/a b.ts", "gone.ts"] },
    // merged into a branch that was merged itself and deleted: looked for on the default branch
    { number: 9, base_ref: "stack/base", checkpoints: ["7d", "30d"], paths: ["lib/c.ts"] },
  ];
  const world = afterMerge({ due, branches: { main: { "src/a b.ts": "one();\ntwo();\n}\n", "lib/c.ts": "three();\n" } } });
  const env = environment({ GITHUB_EVENT_NAME: "schedule", SESSIONLY_GITHUB_TOKEN: "gh" });
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ schedule: "17 5 * * *" }));
  const logged = [];
  const { counted } = await run(env, { api: world.api, server: world.server, log: (line) => logged.push(line), deliver: () => assert.fail("no pull request is reported") });

  // each file as it is on the branch now, as hashes; one that is gone has none
  // and the ages the files were read for go with them
  assert.deepEqual(world.sent, [
    { repo: "github.com/acme/web", number: 3, checkpoints: ["30d"], files: [{ path: "src/a b.ts", hashes: [lineHash("one();"), lineHash("two();")] }, { path: "gone.ts", hashes: [] }] },
    { repo: "github.com/acme/web", number: 9, checkpoints: ["7d", "30d"], files: [{ path: "lib/c.ts", hashes: [lineHash("three();")] }] },
  ]);
  // every file at the commit the branch was at, not at wherever the branch is by then
  assert.deepEqual(world.calls, [
    "GET /repos/acme/web/branches/main",
    "GRAPHQL sha-of-main:src/a b.ts sha-of-main:gone.ts",
    "GET /repos/acme/web/branches/stack/base",
    "GET /repos/acme/web",
    "GET /repos/acme/web/branches/main",
    "GRAPHQL sha-of-main:lib/c.ts",
  ]);
  assert.deepEqual(counted.map((row) => [row.number, row.checkpoint, row.surviving]), [[3, "30d", 2], [9, "7d", 1], [9, "30d", 1]]);
  assert.ok(logged.includes("#3: 2 of 10 agent lines are still on main, 30 days after it was merged."));
  assert.ok(logged.includes("Counted 2 merged pull requests of acme/web again."));
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, /\| #9 \| 7 days \| 10 \| 1 \| 10% \|/);
  // nothing is written on a pull request, and nothing to the outputs
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "");

  // with nothing due the run says so, and the input does the same without a schedule
  const none = afterMerge({ due: [] });
  const quiet = environment({ SESSIONLY_AFTER_MERGE: "true", SESSIONLY_GITHUB_TOKEN: "gh" });
  assert.deepEqual((await run(quiet, { ...none, log() {} })).counted, []);
  assert.match(readFileSync(quiet.GITHUB_STEP_SUMMARY, "utf8"), /No merged pull request was due/);
  assert.deepEqual(none.calls, []);
});

test("a scheduled run that names pull requests reports them, as it did before", async () => {
  const env = environment({ GITHUB_EVENT_NAME: "schedule", SESSIONLY_PR_NUMBER: "7", SESSIONLY_GITHUB_TOKEN: "gh" });
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ schedule: "17 5 * * *" }));
  const sent = [];
  const reported = await run(env, {
    api: fakeGithub(),
    deliver: async (url, token, report) => (sent.push(report.number), ATTRIBUTION),
    server: () => assert.fail("nothing is counted after merging"),
    log() {},
  });
  assert.deepEqual([sent, reported.report.event], [[7], "schedule"]);
  // both asked for at once is said, and neither is done
  await assert.rejects(
    run({ ...env, SESSIONLY_AFTER_MERGE: "true" }, { api: fakeGithub(), deliver: () => assert.fail("not reported"), server: () => assert.fail("not counted") }),
    /after-merge and pr-number inputs are both set/,
  );
});

test("a count the server refuses does not stop the rest, and a server that cannot take any stops the run", async () => {
  const due = [1, 2, 3].map((number) => ({ number, base_ref: "main", checkpoints: ["7d"], paths: ["a.ts"] }));
  const env = () => environment({ GITHUB_EVENT_NAME: "schedule", SESSIONLY_GITHUB_TOKEN: "gh" });
  const logged = [];
  const one = afterMerge({ due, refuse: { 2: 422 } });
  await assert.rejects(run(env(), { ...one, log: (line) => logged.push(line) }), /1 merged pull requests could not be counted: #2/);
  assert.deepEqual(one.sent.map((body) => body.number), [1, 2, 3]);
  assert.match(logged.join("\n"), /#2 could not be counted .*tried again at the next run/);

  const down = afterMerge({ due, refuse: { 2: 503 } });
  await assert.rejects(run(env(), { ...down, log() {} }), /answered 503: no: #2 and the ones after it were not counted/);
  assert.deepEqual(down.sent.map((body) => body.number), [1, 2]);

  // a server from before this refuses the question itself
  const old = { api: one.api, server: async () => { throw Object.assign(new Error("the Sessionly server answered 403: this token only reports pull requests"), { status: 403 }); } };
  await assert.rejects(run(env(), { ...old, log() {} }), /does not count pull requests after merging .*needs updating/);

  // no more files are read at once than GitHub allows for: the rest are due at the next run
  const many = [
    { number: 1, base_ref: "main", checkpoints: ["7d"], paths: Array.from({ length: MOST_FILES - 1 }, (_, i) => `f${i}.ts`) },
    { number: 2, base_ref: "main", checkpoints: ["7d"], paths: ["a.ts", "b.ts"] },
    { number: 3, base_ref: "main", checkpoints: ["7d"], paths: ["a.ts"] },
  ];
  const large = afterMerge({ due: many });
  const said = [];
  const { later } = await run(env(), { ...large, log: (line) => said.push(line) });
  assert.deepEqual([large.sent.map((body) => body.number), later], [[1, 3], 1]);
  assert.match(said.join("\n"), /1 more pull request is due and left for the next run/);
  // and they are asked for many at a time: a pull request of thousands of files is tens of requests
  assert.equal(large.calls.filter((call) => call.startsWith("GRAPHQL")).length, Math.ceil((MOST_FILES - 1) / FILES_AT_ONCE) + 1);
});

test("files are read many at a time at one commit, and one too large for that on its own", async () => {
  const paths = Array.from({ length: FILES_AT_ONCE + 2 }, (_, i) => `f${i}.ts`);
  const files = Object.fromEntries(paths.map((path, i) => [path, `line${i}();\n`]));
  files["f1.ts"] = TOO_LARGE;
  delete files["f3.ts"];
  const { api, calls } = afterMerge({ due: [], branches: { main: files } });
  const texts = await filesAt(api, "acme/web", "sha-of-main", paths);
  assert.deepEqual([...texts.keys()], paths);
  assert.deepEqual([texts.get("f0.ts"), texts.get("f1.ts"), texts.get("f3.ts"), texts.get(`f${FILES_AT_ONCE + 1}.ts`)], ["line0();\n", TOO_LARGE, null, `line${FILES_AT_ONCE + 1}();\n`]);
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["GRAPHQL", "TEXT", "GRAPHQL"]);
  assert.equal(calls[1], "TEXT /repos/acme/web/contents/f1.ts?ref=sha-of-main");
  // a folder where the file was, and a file that is not text
  const odd = { graphql: async () => ({ repository: { f0: {}, f1: { text: null, isTruncated: false, isBinary: true } } }) };
  assert.deepEqual([...(await filesAt(odd, "acme/web", "sha", ["dir", "logo.png"]))], [["dir", null], ["logo.png", ""]]);
});

test("over the network: pages from GitHub, and the server's answer or refusal", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept, body });
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const page = Number(new URL(req.url, "http://x").searchParams.get("page"));
      if (req.url.startsWith("/list")) return reply(200, Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({ i })));
      if (req.url.startsWith("/repos/acme/web/contents/src/")) return res.writeHead(200, { "content-type": "application/vnd.github.raw+json" }).end("one();\n");
      if (req.url === "/repos/acme/web/branches/main") return reply(200, { name: "main", commit: { sha: "abc123" } });
      if (req.url === "/repos/acme/web/branches/trunk") return reply(200, { name: "trunk", commit: { sha: "def456" } });
      if (req.url === "/graphql") return reply(200, { data: { repository: { f0: null } } });
      if (req.url === "/graphql-down") return reply(200, { errors: [{ message: "rate limited" }] });
      if (req.url === "/repos/acme/web") return reply(200, { default_branch: "trunk" });
      if (req.url.startsWith("/api/v1/prs/due")) return req.headers.authorization === "Bearer good" ? reply(200, { due: [] }) : reply(403, { error: "no" });
      if (req.url === "/api/v1/prs" && req.headers.authorization === "Bearer good") return reply(200, { stored: true, attribution: ATTRIBUTION });
      if (req.url === "/api/v1/prs") return reply(403, { error: "reporting pull requests needs a ci or admin token" });
      reply(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const api = github("gh-token", base);
    assert.equal((await all(api, "/list?state=all")).length, 103);
    assert.deepEqual(seen.map((s) => s.url), ["/list?state=all&per_page=100&page=1", "/list?state=all&per_page=100&page=2"]);
    assert.equal(seen[0].auth, "Bearer gh-token");
    await assert.rejects(api.request("GET", "/missing"), /GitHub answered 404 to GET \/missing/);

    // a file as text, one that is not there, and the branch to read it on
    assert.equal(await fileOn(api, "acme/web", "main", "src/a b.ts"), "one();\n");
    assert.equal(seen.at(-1).url, "/repos/acme/web/contents/src/a%20b.ts?ref=main");
    assert.equal(seen.at(-1).accept, "application/vnd.github.raw+json");
    assert.equal(await fileOn(api, "acme/web", "main", "gone.ts"), null);
    assert.deepEqual(await branchFor(api, "acme/web", "main"), { branch: "main", sha: "abc123" });
    assert.deepEqual(await branchFor(api, "acme/web", "deleted"), { branch: "trunk", sha: "def456" });
    assert.deepEqual(await branchFor(api, "acme/web", null), { branch: "trunk", sha: "def456" });
    // many files in one question, and a refusal said
    assert.deepEqual(await api.graphql("query { x }", { e0: "abc123:a.ts" }), { repository: { f0: null } });
    assert.equal(JSON.parse(seen.at(-1).body).variables.e0, "abc123:a.ts");
    await assert.rejects(github("gh-token", base, `${base}/graphql-down`).graphql("query { x }", {}), /GraphQL query: rate limited/);
    // the server asked and told
    assert.deepEqual(await ask(`${base}/`, "good", "GET", "/prs/due?repo=github.com%2Facme%2Fweb"), { due: [] });
    await assert.rejects(ask(base, "bad", "GET", "/prs/due?repo=x"), (err) => err.status === 403);

    assert.deepEqual(await send(`${base}/`, "good", build()), ATTRIBUTION);
    assert.equal(JSON.parse(seen.at(-1).body).number, 7);
    await assert.rejects(send(base, "bad", build()), /answered 403: reporting pull requests needs a ci or admin token/);
  } finally {
    server.close();
  }
});
