import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import { createToken } from "../src/auth.ts";
import { openDb, type Db } from "../src/db.ts";
import { attribute, type Claim } from "../src/pulls.ts";

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

let db: Db;
let app: Hono<Env>;
const tokens = { admin: "", ann: "", ci: "" };

before(async () => {
  db = await openDb("memory://");
  app = createApp(db, {});
  tokens.admin = (await createToken(db, { email: "boss@example.com", role: "admin" })).token;
  tokens.ann = (await createToken(db, { email: "ann@example.com", role: "member" })).token;
  tokens.ci = (await createToken(db, { email: "ci@example.com", role: "ci" })).token;
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
