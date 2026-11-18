import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { testDb, tokenFor } from "./helpers.ts";
import { attribute, breakdown, type Claim, MATCH_AT_ONCE, writers } from "../src/pulls.ts";

// Hashes are 16 hex digits; these stand for lines.
const h = (n: number) => n.toString(16).padStart(16, "0");
const file = (path: string, ...lines: number[]) => ({ path, hashes: lines.map(h) });
const claim = (tool: string, model: string | null, path: string, started: number, ...lines: number[]): Claim => ({
  tool,
  model,
  path,
  hashes: lines.map(h),
  started,
});

test("lines are put down to the agent that added them to that file", () => {
  const claims = [
    claim("claude-code", "opus", "src/a.ts", 1, 1, 2, 3),
    // a session in a worktree reports a longer path
    claim("cursor", null, "~/work/repo-wt/src/a.ts", 2, 4),
    // also a worktree kept inside the repository
    claim("claude-code", "opus", ".claude/worktrees/agent-1f/src/a.ts", 1, 51),
    claim("claude-code", "opus", ".claude/worktrees/agent-1f/deep/src/a.ts", 1, 52),
    // the same line in another file is somebody else's, also in a folder
    // of the repository whose path merely ends the same
    claim("grok", "grok-4", "src/b.ts", 3, 9),
    claim("grok", "grok-4", "other/src/c.ts", 3, 7),
  ];
  const pr = [file("src/a.ts", 1, 2, 4, 9, 50, 51, 52), file("src/c.ts", 7), file("lib/b.ts", 9)];
  const a = attribute(pr, pr, claims);
  assert.deepEqual(a.first, { lines: 9, agent_lines: 4 });
  assert.deepEqual(a.now, {
    lines: 9,
    agent_lines: 4,
    by: [
      { tool: "claude-code", model: "opus", lines: 3 },
      { tool: "cursor", model: null, lines: 1 },
    ],
  });
  assert.deepEqual(a.by, [
    { tool: "claude-code", model: "opus", lines: 3, surviving: 3 },
    { tool: "cursor", model: null, lines: 1, surviving: 1 },
  ]);
});

test("a line counts once per time it was added, for the latest session that added it", () => {
  const claims = [
    claim("claude-code", "opus", "a.ts", 1, 1, 1),
    claim("grok", "grok-4", "a.ts", 5, 1),
  ];
  // three copies in the pull request, and a fourth nobody claims
  const a = attribute([file("a.ts", 1, 1, 1, 1)], [file("a.ts", 1, 1, 1, 1)], claims);
  assert.equal(a.now.agent_lines, 3);
  assert.deepEqual(a.now.by, [
    { tool: "claude-code", model: "opus", lines: 2 },
    { tool: "grok", model: "grok-4", lines: 1 },
  ]);
  // with one copy, the session that started last has it
  assert.deepEqual(attribute([file("a.ts", 1)], [file("a.ts", 1)], claims).now.by, [
    { tool: "grok", model: "grok-4", lines: 1 },
  ]);
});

test("review survival: the agents' first lines that are still there", () => {
  const claims = [claim("claude-code", "opus", "a.ts", 1, 1, 2, 3, 4), claim("cursor", "sonnet", "b.ts", 1, 8, 9)];
  const first = [file("a.ts", 1, 2, 3, 4, 70), file("b.ts", 8, 9)];
  // review: two of opus's lines rewritten by hand, b.ts dropped, an agent line added later
  const claimsLater = [...claims, claim("claude-code", "opus", "a.ts", 9, 30)];
  const now = [file("a.ts", 1, 2, 70, 71, 72, 30)];
  const a = attribute(first, now, claimsLater);
  assert.deepEqual(a.first, { lines: 7, agent_lines: 6 });
  assert.deepEqual(a.by, [
    { tool: "claude-code", model: "opus", lines: 4, surviving: 2 },
    { tool: "cursor", model: "sonnet", lines: 2, surviving: 0 },
  ]);
  assert.deepEqual(a.now, { lines: 6, agent_lines: 3, by: [{ tool: "claude-code", model: "opus", lines: 3 }] });
  // nothing claimed, nothing attributed
  assert.deepEqual(attribute(first, now, []).by, []);
});

test("a pull request's lines, file by file and session by session", () => {
  const from = (id: string, c: Claim): Claim => ({ ...c, session: { machine_id: "m1", source: c.tool, session_id: id } });
  const claims = [
    from("s1", claim("claude-code", "opus", "src/a.ts", 1, 1, 2, 3)),
    from("s1", claim("claude-code", "haiku", "src/b.ts", 1, 10)),
    // a later session wrote line 3 again: it is that session's
    from("s2", claim("cursor", null, "src/a.ts", 2, 3, 4)),
    // a claim that names no session still counts for the file
    claim("grok", "grok-4", "src/b.ts", 3, 11),
  ];
  const now = [file("src/b.ts", 10, 11), file("src/a.ts", 1, 2, 3, 4, 99), file("README.md", 60)];
  assert.deepEqual(breakdown(now, writers(now, claims)), {
    files: [
      { path: "src/a.ts", lines: 5, agent_lines: 4 },
      { path: "src/b.ts", lines: 2, agent_lines: 2 },
      { path: "README.md", lines: 1, agent_lines: 0 },
    ],
    sessions: [
      { machine_id: "m1", source: "claude-code", session_id: "s1", lines: 3 },
      { machine_id: "m1", source: "cursor", session_id: "s2", lines: 2 },
    ],
  });
  // the sessions add up to what `attribute` counts for agents with a session
  assert.equal(attribute(now, now, claims).now.agent_lines, 6);
  assert.equal(attribute(now, now, claims, writers(now, claims)).now.agent_lines, 6);
  assert.deepEqual(breakdown([], writers([], claims)), { files: [], sessions: [] });
});

let db: Db;
let app: Hono<Env>;
const tokens = { admin: "", ann: "", ci: "" };

before(async () => {
  db = await testDb();
  app = createApp(db, {});
  tokens.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" });
  tokens.ann = await tokenFor(db, { email: "ann@example.com", role: "member" });
  tokens.ci = await tokenFor(db, { email: "ci@example.com", role: "ci" });
});
after(() => db.close());

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

function session(id: string, source: string, model: string, started: string, lines: unknown[]) {
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      source,
      machine_id: "m1",
      session_id: id,
      content: "metadata",
      started_at: started,
      repo: { root: "~/src/web", remote: "github.com/acme/web" },
      models: model ? [model] : [],
    },
    rewrite: null,
    lines,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    repo: "github.com/acme/web",
    number: 7,
    title: "Add the parser",
    url: "https://github.com/acme/web/pull/7",
    author: "ann",
    state: "open",
    created_at: "2026-11-10T12:00:00Z",
    event: "opened",
    commits: 1,
    reviews: 0,
    changes_requested: 0,
    review_comments: 0,
    bot_review_comments: 0,
    review_rounds: 0,
    files: [file("src/parser.ts", 1, 2, 3, 4, 90), file("README.md", 60)],
    ...overrides,
  };
}

test("the Action reports a pull request through review; admins read how the agents' lines fared", async () => {
  const put = (s: ReturnType<typeof session>) =>
    call(tokens.ann, "PUT", `/sessions/m1/${s.session.source}/${s.session.session_id}`, s);
  assert.equal((await put(session("s1", "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [
    { path: "src/parser.ts", model: "claude-opus-5-5", hashes: [h(1), h(2), h(3)] },
    { path: "src/parser.ts", model: "claude-haiku-5-5", hashes: [h(4)] },
  ]))).status, 200);
  // Cursor names no model for these lines: the session's main model stands in (it has none)
  assert.equal((await put(session("s2", "cursor", "", "2026-11-10T10:00:00Z", [
    { path: "~/src/web-wt/README.md", model: null, hashes: [h(60)] },
  ]))).status, 200);
  // far too old to have gone into this pull request
  await put(session("s0", "grok", "grok-4", "2026-01-01T00:00:00Z", [{ path: "src/parser.ts", model: null, hashes: [h(90)] }]));

  const opened = await call(tokens.ci, "PUT", "/prs", report());
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.attribution.first, { lines: 6, agent_lines: 5 });
  assert.equal(opened.body.attribution.from_open, true);

  // review: CodeRabbit comments, a person asks for changes, two of opus's lines are redone
  const merged = await call(tokens.ci, "PUT", "/prs", report({
    state: "merged",
    merged_at: "2026-11-11T12:00:00Z",
    event: "closed",
    commits: 3,
    reviews: 2,
    changes_requested: 1,
    review_comments: 2,
    bot_review_comments: 5,
    review_rounds: 2,
    files: [file("src/parser.ts", 1, 4, 90, 91, 92), file("README.md", 60)],
  }));
  assert.deepEqual(merged.body.attribution.by, [
    { tool: "claude-code", model: "claude-opus-5-5", lines: 3, surviving: 1 },
    { tool: "claude-code", model: "claude-haiku-5-5", lines: 1, surviving: 1 },
    { tool: "cursor", model: null, lines: 1, surviving: 1 },
  ]);
  await call(tokens.ci, "PUT", "/prs", report({ number: 8, author: "bob", files: [file("docs/x.md", 77)] }));

  const list = await call(tokens.admin, "GET", "/prs");
  assert.equal(list.body.total, 2);
  const seven = list.body.pulls.find((p: any) => p.number === 7);
  assert.deepEqual(
    [seven.state, seven.first_event, seven.review_rounds, seven.bot_review_comments, seven.title],
    ["merged", "opened", 2, 5, "Add the parser"],
  );
  assert.deepEqual(seven.attribution.now, {
    lines: 6,
    agent_lines: 3,
    by: [
      { tool: "claude-code", model: "claude-haiku-5-5", lines: 1 },
      { tool: "claude-code", model: "claude-opus-5-5", lines: 1 },
      { tool: "cursor", model: null, lines: 1 },
    ],
  });
  assert.deepEqual((await call(tokens.admin, "GET", "/prs?state=open")).body.pulls.map((p: any) => p.number), [8]);
  assert.equal((await call(tokens.admin, "GET", "/prs?repo=acme/api")).body.total, 0);
  assert.equal((await call(tokens.admin, "GET", "/prs?since=2026-11-11")).body.total, 1);
  assert.equal((await call(tokens.admin, "GET", "/prs?state=maybe")).status, 400);

  const summary = (await call(tokens.admin, "GET", "/prs/summary?state=merged")).body;
  assert.deepEqual(summary.total, {
    pulls: 1,
    pulls_with_agent_lines: 1,
    lines: 6,
    agent_lines: 3,
    pulls_from_open: 1,
    opened_agent_lines: 5,
    agent_lines_surviving: 3,
    cloud_pulls: 0,
    cloud_pulls_without_session: 0,
  });
  assert.deepEqual(summary.by_model.find((m: any) => m.model === "claude-opus-5-5"), {
    tool: "claude-code",
    model: "claude-opus-5-5",
    pulls: 1,
    lines: 1,
    opened_lines: 3,
    surviving: 1,
    review_rounds: 2,
    changes_requested: 1,
    review_comments: 2,
    bot_review_comments: 5,
  });
  assert.equal(summary.by_model.length, 3);
  assert.equal((await call(tokens.admin, "GET", "/prs/summary")).body.total.pulls, 2);

  // a pull request first reported when it was already under review: its lines
  // count, but nothing can be said about what review changed
  await call(tokens.ci, "PUT", "/prs", report({ number: 20, event: "review", state: "merged", files: [file("src/parser.ts", 1, 2)] }));
  assert.equal((await call(tokens.admin, "GET", "/prs?state=merged")).body.pulls.find((p: any) => p.number === 20).attribution.from_open, false);
  const late = (await call(tokens.admin, "GET", "/prs/summary?state=merged")).body;
  assert.deepEqual(
    [late.total.pulls, late.total.agent_lines, late.total.pulls_from_open, late.total.opened_agent_lines],
    [2, 5, 1, 5],
  );
  const opus = late.by_model.find((m: any) => m.model === "claude-opus-5-5");
  assert.deepEqual([opus.pulls, opus.lines, opus.opened_lines, opus.surviving], [2, 3, 3, 1]);
});

test("a session uploaded after the pull request was opened still counts", async () => {
  await call(tokens.ci, "PUT", "/prs", report({ number: 9, files: [file("late.ts", 500, 501)] }));
  await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-late", session(
    "s-late", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z",
    [{ path: "late.ts", model: null, hashes: [h(500)] }],
  ));
  const again = await call(tokens.ci, "PUT", "/prs", report({ number: 9, event: "synchronize", files: [file("late.ts", 500, 501)] }));
  // the model falls back to the session's main one
  assert.deepEqual(again.body.attribution.by, [{ tool: "claude-code", model: "claude-opus-5-5", lines: 1, surviving: 1 }]);
});

test("sessions from a fork, or from a clone with the repository's old name, count", async () => {
  const elsewhere = (id: string, remote: string, line: number) => {
    const s = session(id, "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "x.ts", model: null, hashes: [h(line)] }]);
    s.session.repo.remote = remote;
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  await elsewhere("s-fork", "github.com/ann/web", 700);
  await elsewhere("s-old", "github.com/oldco/website", 701);
  await elsewhere("s-other", "github.com/acme/api", 702);
  const files = [file("x.ts", 700, 701, 702)];
  const lines = async (overrides: Record<string, unknown>) =>
    (await call(tokens.ci, "PUT", "/prs", report({ number: 11, files, ...overrides }))).body.attribution.now.agent_lines;
  assert.equal(await lines({}), 0);
  assert.equal(await lines({ head_repo: "github.com/ann/web" }), 1);
  assert.equal(await lines({ head_repo: "github.com/ann/web", aliases: ["github.com/oldco/website"] }), 2);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ aliases: "github.com/oldco/website" }))).status, 422);
});

test("only sessions of the people who committed to a pull request count toward it", async () => {
  const by = (id: string, email: string | null, line: number) => {
    const s = session(id, "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "shared.ts", model: null, hashes: [h(line)] }]);
    (s.session as Record<string, unknown>).user = email ? { email } : null;
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  await by("s-cy", "Cy@Example.com", 800);
  await by("s-dee", "dee@example.com", 801);
  // no git email on that machine: the token's owner (ann) stands in
  await by("s-anon", null, 802);
  const files = [file("shared.ts", 800, 801, 802)];
  const lines = async (commit_emails?: unknown) =>
    (await call(tokens.ci, "PUT", "/prs", report({ number: 12, files, commit_emails }))).body.attribution.now.agent_lines;
  assert.equal(await lines(), 3);
  assert.equal(await lines([]), 3);
  assert.equal(await lines(["cy@example.com"]), 1);
  assert.equal(await lines(["CY@example.com ", "ann@example.com"]), 2);
  assert.equal(await lines(["someone@else.example"]), 0);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ commit_emails: "cy@example.com" }))).status, 422);
});

test("a pull request's page: its files, the sessions that wrote it, and links to its reviews and comments", async () => {
  const sessionOf = (id: string, source: string, line: number) =>
    call(tokens.ann, "PUT", `/sessions/m1/${source}/${id}`, {
      ...session(id, source, "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "page.ts", model: null, hashes: [h(line), h(line + 1)] }]),
    });
  await sessionOf("p-one", "claude-code", 900);
  await sessionOf("p-two", "codex", 910);
  const files = [file("page.ts", 900, 901, 910, 999), file("notes.md", 950)];
  const feedback = [
    { kind: "conversation", url: "https://github.com/acme/web/pull/30#issuecomment-1", author: "vercel[bot]", bot: true, at: "2026-11-10T12:01:00Z" },
    {
      kind: "inline", url: "https://github.com/acme/web/pull/30#discussion_r2", author: "bob", bot: false, at: "2026-11-10T12:05:00+02:00",
      path: "page.ts", line: 3, reply: false,
      // none of this is kept
      body: "what the comment says", diff_hunk: "+ the code it is about",
    },
    { kind: "review", url: "javascript:alert(1)", author: "bob", bot: false, at: "2026-11-10T12:06:00Z", state: "changes_requested", body: "what the review says" },
  ];
  const sent = await call(tokens.ci, "PUT", "/prs", report({ number: 30, head_ref: "page", base_ref: "main", draft: true, files, feedback }));
  assert.equal(sent.status, 200);

  const at = (number: number, repo = "github.com/acme/web") => call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=${number}`);
  const page = (await at(30)).body;
  assert.deepEqual([page.number, page.title, page.draft, page.head_ref, page.base_ref, page.closed_at], [30, "Add the parser", true, "page", "main", null]);
  assert.deepEqual(page.attribution.now.agent_lines, 3);
  assert.deepEqual(page.files, [
    { path: "page.ts", lines: 4, agent_lines: 3 },
    { path: "notes.md", lines: 1, agent_lines: 0 },
  ]);
  assert.deepEqual(page.sessions.map((s: any) => [s.source, s.session_id, s.lines, s.session.owner_email, s.session.primary_model, s.session.started_at]), [
    ["claude-code", "p-one", 2, "ann@example.com", "claude-opus-5-5", "2026-11-10T11:00:00.000Z"],
    ["codex", "p-two", 1, "ann@example.com", "claude-opus-5-5", "2026-11-10T11:00:00.000Z"],
  ]);
  // Who, when, where and a link: a link that is not a web address is dropped, and so is any text.
  assert.deepEqual(page.feedback, [
    { kind: "conversation", url: "https://github.com/acme/web/pull/30#issuecomment-1", author: "vercel[bot]", bot: true, at: "2026-11-10T12:01:00.000Z" },
    { kind: "inline", url: "https://github.com/acme/web/pull/30#discussion_r2", author: "bob", bot: false, at: "2026-11-10T10:05:00.000Z", path: "page.ts", line: 3, reply: false },
    { kind: "review", url: null, author: "bob", bot: false, at: "2026-11-10T12:06:00.000Z", state: "changes_requested" },
  ]);
  const [stored] = await db.query<{ all: string }>(`SELECT row_to_json(p)::text AS all FROM pull_requests p WHERE number = 30`);
  assert.doesNotMatch(stored!.all, /what the|the code it is about|javascript/);

  // An Action from before reviews and comments were sent says nothing of them: what is known stays.
  await call(tokens.ci, "PUT", "/prs", report({ number: 30, event: "synchronize", files }));
  assert.deepEqual([(await at(30)).body.feedback.length, (await at(30)).body.feedback_total], [3, 3]);
  // On a pull request with more than are sent, how many there are is kept too,
  // and through a report from an older Action like the rest.
  await call(tokens.ci, "PUT", "/prs", report({ number: 30, event: "synchronize", files, feedback, feedback_total: 2500 }));
  await call(tokens.ci, "PUT", "/prs", report({ number: 30, event: "synchronize", files }));
  assert.deepEqual([(await at(30)).body.feedback.length, (await at(30)).body.feedback_total], [3, 2500]);
  // Never fewer than were sent.
  await call(tokens.ci, "PUT", "/prs", report({ number: 30, event: "synchronize", files, feedback, feedback_total: 1 }));
  assert.equal((await at(30)).body.feedback_total, 3);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ number: 30, feedback, feedback_total: "many" }))).status, 422);
  // One that sends none says there are none.
  await call(tokens.ci, "PUT", "/prs", report({ number: 30, event: "synchronize", files, feedback: [] }));
  assert.deepEqual([(await at(30)).body.feedback, (await at(30)).body.feedback_total], [[], 0]);

  // A session that was deleted since is still counted, and leads nowhere.
  await db.query(`DELETE FROM sessions WHERE session_id = 'p-two'`);
  assert.deepEqual((await at(30)).body.sessions.map((s: any) => [s.session_id, s.lines, s.session?.owner_email ?? null]), [
    ["p-one", 2, "ann@example.com"],
    ["p-two", 1, null],
  ]);

  // A pull request stored before any of this was kept has none of it, rather than nothing.
  await db.query(`UPDATE pull_requests SET detail = NULL, feedback = NULL WHERE number = 30`);
  const old = (await at(30)).body;
  assert.deepEqual([old.files, old.sessions, old.feedback, old.attribution.now.agent_lines], [null, null, null, 3]);

  assert.equal((await at(31)).status, 404);
  assert.equal((await at(30, "github.com/acme/other")).status, 404);
  assert.equal((await call(tokens.admin, "GET", "/prs/detail?number=30")).status, 400);
  assert.equal((await call(tokens.admin, "GET", "/prs/detail?repo=github.com/acme/web&number=x")).status, 400);
  // Admins only, like the list.
  assert.equal((await at(30)).status, 200);
  for (const token of [tokens.ann, tokens.ci]) {
    assert.equal((await call(token, "GET", "/prs/detail?repo=github.com/acme/web&number=30")).status, 403);
  }
  // Reviews and comments that make no sense are refused.
  for (const bad of [
    "none",
    [{ kind: "note", author: "bob", at: "2026-11-10T12:00:00Z" }],
    [{ kind: "review", author: "", at: "2026-11-10T12:00:00Z" }],
    [{ kind: "review", author: "bob", at: "soon" }],
    Array.from({ length: 2001 }, () => ({ kind: "review", author: "bob", at: "2026-11-10T12:00:00Z" })),
  ]) {
    assert.equal((await call(tokens.ci, "PUT", "/prs", report({ number: 30, feedback: bad }))).status, 422);
  }
});

test("who may do what with pull requests", async () => {
  // a ci token reports pull requests and nothing else
  assert.equal((await call(tokens.ci, "GET", "/ping")).status, 200);
  for (const path of ["/prs", "/prs/summary", "/sessions", "/summary", "/tokens", "/me"]) {
    assert.equal((await call(tokens.ci, "GET", path)).status, 403, path);
  }
  assert.equal((await call(tokens.ci, "PUT", "/sessions/m1/claude-code/x", {})).status, 403);
  // members neither report nor read them
  assert.equal((await call(tokens.ann, "PUT", "/prs", report())).status, 403);
  assert.equal((await call(tokens.ann, "GET", "/prs")).status, 403);
  assert.equal((await call(tokens.ann, "GET", "/prs/summary")).status, 403);
  // admins can mint a ci token
  const made = await call(tokens.admin, "POST", "/tokens", { email: "bot@example.com", role: "ci" });
  assert.equal(made.status, 201);
  assert.equal((await call(made.body.token, "PUT", "/prs", report({ number: 10 }))).status, 200);
  assert.equal((await call(tokens.admin, "POST", "/tokens", { email: "x@example.com", role: "owner" })).status, 400);
});

test("a report that makes no sense is refused with a reason", async () => {
  const bad = async (overrides: Record<string, unknown>) => {
    const response = await call(tokens.ci, "PUT", "/prs", report(overrides));
    assert.equal(response.status, 422, JSON.stringify(overrides));
    return response.body.error as string;
  };
  assert.match(await bad({ repo: "" }), /repo/);
  assert.match(await bad({ number: 0 }), /number/);
  assert.match(await bad({ state: "draft" }), /state/);
  assert.match(await bad({ created_at: "soon" }), /created_at/);
  assert.match(await bad({ commits: -1 }), /commits/);
  assert.match(await bad({ files: [{ path: "a.ts", hashes: ["let x = 1;"] }] }), /hashes/);
  assert.match(await bad({ files: "none" }), /files/);
});

test("a pull request's lines are matched again when its sessions arrive after its last report", async () => {
  const repo = "github.com/acme/again";
  const upload = (id: string, email: string | null, hashes: string[]) => {
    const s = session(id, "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes }]);
    s.session.repo.remote = repo;
    if (email) (s.session as Record<string, unknown>).user = { email };
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  const about = { repo, commit_emails: ["ann@example.com"], files: [file("a.ts", 800, 801, 802)] };
  const merged = await call(tokens.ci, "PUT", "/prs", report({
    ...about, number: 1, state: "merged", event: "closed", reviews: 2,
    feedback: [{ kind: "review", author: "bob", at: "2026-11-10T13:00:00Z", state: "approved" }],
  }));
  assert.equal(merged.body.attribution.now.agent_lines, 0);
  const detail = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=${number}`)).body;
  const before = await detail(1);
  assert.deepEqual([before.matchable, before.matched_at != null, before.sessions], [true, true, []]);

  // the sessions come after the pull request was closed: no report follows
  await upload("s-after", null, [h(800), h(801)]);
  // someone else's, with the same line: not a committer of this pull request
  await upload("s-else", "eve@example.com", [h(802)]);
  assert.equal((await detail(1)).attribution.now.agent_lines, 0);

  const again = await call(tokens.admin, "POST", "/prs/match", { repo, number: 1 });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.attribution.now, {
    lines: 3,
    agent_lines: 2,
    by: [{ tool: "claude-code", model: "claude-opus-5-5", lines: 2 }],
  });
  const after = await detail(1);
  assert.equal(after.attribution.now.agent_lines, 2);
  assert.deepEqual(after.sessions.map((s: any) => [s.session_id, s.lines]), [["s-after", 2]]);
  assert.equal(after.matched_at, again.body.matched_at);
  assert.ok(Date.parse(after.matched_at) > Date.parse(before.matched_at));
  // nothing else about it changed: it is as the Action last reported it
  assert.deepEqual(
    [after.updated_at, after.state, after.reviews, after.first_event, after.feedback],
    [before.updated_at, "merged", 2, "closed", before.feedback],
  );

  // one last reported before what it is matched by was kept waits for its next report
  await call(tokens.ci, "PUT", "/prs", report({ ...about, number: 2 }));
  await db.query(`UPDATE pull_requests SET committers = NULL, aliases = NULL WHERE repo = $1 AND number = 2`, [repo]);
  const old = await call(tokens.admin, "POST", "/prs/match", { repo, number: 2 });
  assert.deepEqual([old.status, old.body.code], [409, "needs_report"]);
  assert.equal((await detail(2)).matchable, false);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ ...about, number: 2 }))).status, 200);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 2 })).status, 200);

  // whose sessions count is kept as hashes, never as the addresses the commits carry
  const [kept] = await db.query<{ committers: unknown }>(`SELECT committers::text AS committers FROM pull_requests WHERE repo = $1 AND number = 1`, [repo]);
  assert.match(String(kept!.committers), /^\["[0-9a-f]{64}"\]$/);
  // committers none of whom has a session here: nobody's lines, not everybody's
  const strangers = report({ ...about, number: 3, commit_emails: ["zed@elsewhere.example"] });
  assert.equal((await call(tokens.ci, "PUT", "/prs", strangers)).body.attribution.now.agent_lines, 0);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 3 })).body.attribution.now.agent_lines, 0);
  // a report that named no committers has every session in the repository looked at, then as before
  const anyone = report({ ...about, number: 4, commit_emails: [] });
  assert.equal((await call(tokens.ci, "PUT", "/prs", anyone)).body.attribution.now.agent_lines, 3);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 4 })).body.attribution.now.agent_lines, 3);
  // a cloud agent's commits are still known for what they are
  const cloud = report({ ...about, number: 5, commit_emails: ["noreply@anthropic.com"], head_ref: "claude/fix" });
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs", cloud)).body.attribution.cloud, { agents: ["claude-code"], sessions: 0 });
  await db.query(`UPDATE pull_requests SET head_ref = 'fix' WHERE repo = $1 AND number = 5`, [repo]);
  assert.deepEqual((await call(tokens.admin, "POST", "/prs/match", { repo, number: 5 })).body.attribution.cloud, { agents: ["claude-code"], sessions: 0 });

  // who may, and what is asked for
  assert.equal((await call(tokens.ci, "POST", "/prs/match", { repo, number: 1 })).status, 403);
  assert.equal((await call(tokens.ann, "POST", "/prs/match", { repo, number: 1 })).status, 403);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 99 })).status, 404);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { number: 1 })).status, 400);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: "1" })).status, 400);
});

test("the pull requests the list's filters choose are matched again, some at a time", async () => {
  const repo = "github.com/acme/many";
  const count = MATCH_AT_ONCE + 3;
  for (let number = 1; number <= count; number += 1) {
    await call(tokens.ci, "PUT", "/prs", report({ repo, number, commit_emails: ["ann@example.com"], files: [file("b.ts", 900)] }));
  }
  await db.query(`UPDATE pull_requests SET committers = NULL WHERE repo = $1 AND number = 1`, [repo]);
  const s = session("s-many", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "b.ts", model: null, hashes: [h(900)] }]);
  s.session.repo.remote = repo;
  await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-many", s);

  const first = await call(tokens.admin, "POST", "/prs/match", { repo: "acme/many" });
  assert.equal(first.status, 200);
  assert.deepEqual(
    [first.body.matched, first.body.remaining, first.body.needs_report],
    [MATCH_AT_ONCE, 2, 1],
  );
  const second = await call(tokens.admin, "POST", "/prs/match", { repo: "acme/many", started: first.body.started });
  assert.deepEqual(
    [second.body.matched, second.body.remaining, second.body.needs_report, second.body.started],
    [2, 0, 1, first.body.started],
  );
  // all of them have the session's line now, but for the one that waits for a report
  const summary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/many")).body.total;
  assert.deepEqual([summary.pulls, summary.agent_lines], [count, count - 1]);
  // none of them is merged
  const third = await call(tokens.admin, "POST", "/prs/match", { repo: "acme/many", state: "merged" });
  assert.deepEqual([third.body.matched, third.body.remaining], [0, 0]);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { state: "maybe" })).status, 400);
});
