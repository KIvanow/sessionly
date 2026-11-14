import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { all, github } from "../src/github.mjs";
import { addedHashes, ignoring, lineHash } from "../src/lines.mjs";
import { eventName, run, send, whenOpened } from "../src/main.mjs";
import { buildReport, MARKER, render, reviewRounds } from "../src/report.mjs";

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
  const rounds = (reviews, comments, commits) => reviewRounds("ann", reviews, comments, commits);
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
    files: [{ path: "src/parser.rs", hashes: [lineHash("one();"), lineHash("two();")] }],
    files_without_diff: 1,
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

test("the figures as text", () => {
  const text = render(build(), ATTRIBUTION);
  assert.ok(text.startsWith(MARKER));
  assert.match(text, /\*\*38% of the lines this pull request adds were written by a coding agent\*\* \(450 of 1,200\)/);
  assert.match(text, /\| Claude Code \| claude-opus-5-5 \| 300 \|/);
  assert.match(text, /\| Cursor \| not known \| 150 \|/);
  assert.match(text, /Of the 400 agent lines it had when it was opened, 340 are still there \(85%\)/);
  assert.doesNotMatch(render(build(), { ...ATTRIBUTION, from_open: false }), /still there/);
  // nearly all is not all
  const nearly = { ...ATTRIBUTION, by: [{ tool: "cursor", model: null, lines: 400, surviving: 399 }] };
  assert.match(render(build(), nearly), /399 are still there \(99%\)/);
  assert.match(text, /1 changed files were too large/);
  // when it has just been opened there is nothing to compare with yet
  assert.doesNotMatch(render(build({ event: "opened" }), ATTRIBUTION), /still there/);
  const none = { first: { lines: 9, agent_lines: 0 }, now: { lines: 9, agent_lines: 0, by: [] }, by: [] };
  assert.match(render(build(), none), /No lines of this pull request were matched/);
  const empty = { first: { lines: 0, agent_lines: 0 }, now: { lines: 0, agent_lines: 0, by: [] }, by: [] };
  assert.match(render(build(), empty), /adds no lines to track/);
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
  // nothing is written to the pull request unless asked, and the token is not logged
  assert.ok(api.calls.every(([method]) => method === "GET"));
  assert.ok(!logged.join("\n").includes("sly_secret"));
});

test("the comment is opt-in and is kept up to date rather than repeated", async () => {
  const deliver = async () => ATTRIBUTION;
  const writes = (api) => api.calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`);

  const fresh = fakeGithub();
  const { text } = await run(environment({ SESSIONLY_COMMENT: "true", SESSIONLY_SUMMARY: "false" }), { api: fresh, deliver, log() {} });
  assert.deepEqual(writes(fresh), ["POST /repos/acme/web/issues/7/comments"]);

  const stale = fakeGithub([{ id: 41, body: "unrelated" }, { id: 42, body: `${MARKER}\nold figures` }]);
  await run(environment({ SESSIONLY_COMMENT: "true" }), { api: stale, deliver, log() {} });
  assert.deepEqual(writes(stale), ["PATCH /repos/acme/web/issues/comments/42"]);

  const current = fakeGithub([{ id: 42, body: text }]);
  await run(environment({ SESSIONLY_COMMENT: "true" }), { api: current, deliver, log() {} });
  assert.deepEqual(writes(current), []);
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

test("over the network: pages from GitHub, and the server's answer or refusal", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const page = Number(new URL(req.url, "http://x").searchParams.get("page"));
      if (req.url.startsWith("/list")) return reply(200, Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({ i })));
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

    assert.deepEqual(await send(`${base}/`, "good", build()), ATTRIBUTION);
    assert.equal(JSON.parse(seen.at(-1).body).number, 7);
    await assert.rejects(send(base, "bad", build()), /answered 403: reporting pull requests needs a ci or admin token/);
  } finally {
    server.close();
  }
});
