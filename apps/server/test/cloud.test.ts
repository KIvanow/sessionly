// Sessions that ran in a cloud agent's sandbox: whose they are, how they are
// kept apart from local ones, and how they are tied to a pull request.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { testDb, tokenFor } from "./helpers.ts";

let db: Db;
let app: Hono<Env>;
const tokens = { admin: "", ann: "", env: "", ci: "" };

before(async () => {
  db = await testDb();
  app = createApp(db, {});
  tokens.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" });
  tokens.ann = await tokenFor(db, { email: "ann@example.com", role: "member" });
  tokens.env = await tokenFor(db, { email: "cloud@example.com", name: "Cloud environment", role: "env" });
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

const h = (n: number) => n.toString(16).padStart(16, "0");

interface Shape {
  source?: string;
  machine?: string;
  /** Who the platform named; null for nobody. */
  person?: string | null;
  cloud?: boolean;
  branch?: string;
  prompts?: number;
  lines?: number[];
}

function session(id: string, shape: Shape = {}) {
  const source = shape.source ?? "claude-code";
  const cloud = shape.cloud ?? true;
  const person = shape.person === undefined ? "Dee@Example.com" : shape.person;
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      source,
      machine_id: shape.machine ?? (cloud ? "cloud" : "laptop-1"),
      session_id: id,
      content: "metadata",
      user: person ? { name: null, email: person } : null,
      runtime: cloud ? { kind: "cloud", id: `cse_${id}` } : null,
      started_at: "2026-11-14T10:00:00Z",
      repo: { root: "/home/user/web", remote: "github.com/acme/web", branch: shape.branch ?? "main" },
      models: ["claude-opus-5-5"],
      counts: { prompts: shape.prompts ?? 1, tool_calls: 3 },
    },
    rewrite: null,
    lines: shape.lines ? [{ path: "src/parser.ts", model: "claude-opus-5-5", hashes: shape.lines.map(h) }] : [],
  };
}

const put = (token: string, s: ReturnType<typeof session>) =>
  call(token, "PUT", `/sessions/${s.session.machine_id}/${s.session.source}/${s.session.session_id}`, s);

const ownerOf = async (id: string, source = "claude-code", machine = "cloud") =>
  (await call(tokens.admin, "GET", `/sessions/${machine}/${source}/${id}`)).body.owner_email;

test("an environment's token files a cloud session under whoever started it", async () => {
  assert.deepEqual((await put(tokens.env, session("c-dee"))).body, { stored: true });
  assert.equal(await ownerOf("c-dee"), "dee@example.com");

  // The platform named nobody: the environment's own address stands in,
  // until a later upload of the same session names someone.
  await put(tokens.env, session("c-late", { person: null }));
  assert.equal(await ownerOf("c-late"), "cloud@example.com");
  assert.equal((await put(tokens.env, session("c-late", { person: "eve@example.com" }))).status, 200);
  assert.equal(await ownerOf("c-late"), "eve@example.com");
  // Once it is someone's, it stays theirs.
  assert.equal((await put(tokens.env, session("c-late", { person: "mallory@example.com" }))).status, 409);
  assert.equal((await put(tokens.env, session("c-dee", { person: "not an address" }))).status, 409);

  // Only a cloud session is filed by what it says. Anything else an
  // environment's token uploads is the environment's.
  await put(tokens.env, session("c-local", { cloud: false }));
  assert.equal(await ownerOf("c-local", "claude-code", "laptop-1"), "cloud@example.com");
});

test("a person's own token files a cloud session under that person", async () => {
  // Ann put her own token in her own environment; the record names someone else.
  await put(tokens.ann, session("c-ann", { person: "someone@else.example" }));
  assert.equal(await ownerOf("c-ann"), "ann@example.com");
  const mine = await call(tokens.ann, "GET", "/sessions");
  assert.deepEqual(mine.body.sessions.map((s: any) => s.session_id), ["c-ann"]);
  assert.equal(mine.body.sessions[0].runtime, "cloud");
});

test("an environment's token uploads sessions and does nothing else", async () => {
  assert.equal((await call(tokens.env, "GET", "/ping")).body.role, "env");
  for (const path of ["/sessions", "/summary", "/files", "/filters", "/prs", "/tokens", "/me"]) {
    assert.equal((await call(tokens.env, "GET", path)).status, 403, path);
  }
  assert.equal((await call(tokens.env, "GET", "/sessions/cloud/claude-code/c-dee")).status, 403);
  assert.equal((await call(tokens.env, "PUT", "/prs", {})).status, 403);
  assert.equal((await call(tokens.env, "POST", "/tokens", { email: "x@example.com" })).status, 403);
  // An admin makes one like any other token.
  const made = await call(tokens.admin, "POST", "/tokens", { email: "agents@example.com", role: "env" });
  assert.equal(made.status, 201);
  assert.equal(made.body.role, "env");
  assert.equal((await put(made.body.token, session("c-made"))).status, 200);
});

test("a sandbox that saw less of a session does not replace what is there", async () => {
  await put(tokens.env, session("c-long", { prompts: 5 }));
  // The session moved to a new sandbox, which captured its last two turns.
  const partial = await put(tokens.env, session("c-long", { prompts: 2 }));
  assert.deepEqual(partial, { status: 200, body: { stored: false } });
  const kept = await call(tokens.admin, "GET", "/sessions/cloud/claude-code/c-long");
  assert.equal(kept.body.upload.session.counts.prompts, 5);
  // The same or more is stored as usual.
  assert.deepEqual((await put(tokens.env, session("c-long", { prompts: 6 }))).body, { stored: true });
  // A session on someone's machine is replaced by whatever is sent, as before.
  await put(tokens.ann, session("l-1", { cloud: false, prompts: 5 }));
  assert.deepEqual((await put(tokens.ann, session("l-1", { cloud: false, prompts: 2 }))).body, { stored: true });
});

test("cloud and local sessions can be told apart and counted apart", async () => {
  const ids = async (query: string) =>
    (await call(tokens.admin, "GET", `/sessions${query}`)).body.sessions.map((s: any) => s.session_id).sort();
  assert.deepEqual(await ids("?runtime=local"), ["c-local", "l-1"]);
  assert.deepEqual(await ids("?runtime=cloud"), ["c-ann", "c-dee", "c-late", "c-long", "c-made"]);
  assert.equal((await call(tokens.admin, "GET", "/sessions?runtime=orbit")).status, 400);

  const summary = await call(tokens.admin, "GET", "/summary?by=runtime");
  const counts = Object.fromEntries(summary.body.groups.map((g: any) => [g.key, g.sessions]));
  assert.deepEqual(counts, { cloud: 5, local: 2 });
  assert.deepEqual((await call(tokens.admin, "GET", "/filters")).body.runtimes, ["cloud", "local"]);
});

function report(overrides: Record<string, unknown> = {}) {
  return {
    repo: "github.com/acme/web",
    number: 21,
    author: "claude",
    state: "open",
    created_at: "2026-11-14T12:00:00Z",
    event: "opened",
    commits: 1,
    reviews: 0,
    changes_requested: 0,
    review_comments: 0,
    bot_review_comments: 0,
    review_rounds: 0,
    files: [{ path: "src/parser.ts", hashes: [h(1), h(2), h(3), h(90)] }],
    ...overrides,
  };
}

test("a cloud session counts toward the pull request of its branch", async () => {
  // The agent's commits are its own, not Dee's: her session is found by its branch.
  await put(tokens.env, session("c-pr", { branch: "ccr-4d29d410-k9pftj", lines: [1, 2, 3] }));
  // The same lines from a cloud session on another branch are someone else's work.
  await put(tokens.env, session("c-other", { branch: "ccr-ffffffff-zzzzzz", lines: [90] }));

  const agent = { commit_emails: ["noreply@anthropic.com"], head_ref: "ccr-4d29d410-k9pftj" };
  const stored = await call(tokens.ci, "PUT", "/prs", report(agent));
  assert.equal(stored.status, 200);
  assert.equal(stored.body.attribution.now.agent_lines, 3);
  assert.deepEqual(stored.body.attribution.now.by, [{ tool: "claude-code", model: "claude-opus-5-5", lines: 3 }]);
  assert.deepEqual(stored.body.attribution.cloud, { agents: ["claude-code"], sessions: 1 });

  // A person's commits on a branch of that name do not pull in a session
  // from someone's machine: only cloud sessions are matched by branch.
  await put(tokens.ann, session("l-branch", { cloud: false, person: "ann@example.com", branch: "feature", lines: [1, 2, 3] }));
  const bobs = await call(tokens.ci, "PUT", "/prs", report({ number: 22, commit_emails: ["bob@example.com"], head_ref: "feature" }));
  assert.equal(bobs.body.attribution.now.agent_lines, 0);
  assert.equal(bobs.body.attribution.cloud, null);
});

test("a cloud agent's pull request with no session is marked as such", async () => {
  const cursor = await call(
    tokens.ci,
    "PUT",
    "/prs",
    report({ number: 23, commit_emails: ["cursoragent@cursor.com"], head_ref: "cursor/greet-docstring-772c" }),
  );
  assert.equal(cursor.body.attribution.now.agent_lines, 0);
  assert.deepEqual(cursor.body.attribution.cloud, { agents: ["cursor"], sessions: 0 });
  // The branch name alone is enough: a person may have pushed on top.
  const mixed = await call(
    tokens.ci,
    "PUT",
    "/prs",
    report({ number: 24, commit_emails: ["ann@example.com"], head_ref: "claude/fix-login" }),
  );
  assert.deepEqual(mixed.body.attribution.cloud, { agents: ["claude-code"], sessions: 0 });
  const other = await call(
    tokens.ci,
    "PUT",
    "/prs",
    report({ number: 25, commit_emails: ["ann@example.com"], head_ref: "ccr-2d637c03-n5ayp2" }),
  );
  assert.deepEqual(other.body.attribution.cloud, { agents: ["claude-code"], sessions: 0 });

  const summary = await call(tokens.admin, "GET", "/prs/summary");
  assert.equal(summary.body.total.cloud_pulls, 4);
  assert.equal(summary.body.total.cloud_pulls_without_session, 3);
  const listed = await call(tokens.admin, "GET", "/prs");
  const cloud = Object.fromEntries(listed.body.pulls.map((p: any) => [p.number, p.attribution.cloud?.sessions ?? null]));
  assert.deepEqual(cloud, { 21: 1, 22: null, 23: 0, 24: 0, 25: 0 });
});

test("a session whose opening prompt was not captured is listed by its next one", async () => {
  // Cursor's cloud does not always run hooks for the prompt an agent starts with.
  const upload = session("c-unseen", { source: "cursor" });
  const text = (preview: string) => ({ preview, chars: preview.length, sha256: "0".repeat(64) });
  Object.assign(upload.session, {
    content: "previews",
    prompts: [{ text: text("") }, { text: text("and now run the tests") }],
  });
  assert.equal((await put(tokens.env, upload)).status, 200);
  const listed = await call(tokens.admin, "GET", "/sessions?tool=cursor");
  assert.equal(listed.body.sessions[0].first_prompt, "and now run the tests");
});
