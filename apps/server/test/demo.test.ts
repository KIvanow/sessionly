import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db, OrgDb } from "../src/db.ts";
import { copyRepo, demoFrom, inRepo, shown } from "../src/demo.ts";
import { newOrg, testDb, tokenFor } from "./helpers.ts";

const h = (n: number) => n.toString(16).padStart(16, "0");
const REPO = "github.com/acme/shown";

let db: Db;
let app: Hono<Env>;
// Where the work is uploaded, and where the one repository is shown.
const work = { admin: "", ann: "" };
const demo = { admin: "", ci: "" };
const from = <T>(fn: (db: OrgDb) => Promise<T>) => db.asOrg("work", fn);
const to = <T>(fn: (db: OrgDb) => Promise<T>) => db.asOrg("demo", fn);
const copy = () => copyRepo(from, to, { repo: REPO, hide: ["notes"] });

before(async () => {
  db = await testDb();
  app = createApp(db, {});
  await newOrg(db, "work");
  await newOrg(db, "demo");
  work.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" }, "work");
  work.ann = await tokenFor(db, { email: "ann@example.com", role: "member" }, "work");
  demo.admin = await tokenFor(db, { email: "host@example.com", role: "admin" }, "demo");
  demo.ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, "demo");
});
after(() => db.close());

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
}

/** A session with everything a person would not want shown, in a repository. */
function session(id: string, remote: string, lines: number[] = [1, 2, 3]) {
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      source: "claude-code",
      machine_id: "m1",
      session_id: id,
      content: "previews",
      title: "SECRET the title says what was asked",
      user: { name: "Ann", email: "ann@example.com" },
      started_at: "2026-11-10T09:00:00Z",
      ended_at: "2026-11-10T10:00:00Z",
      active_ms: 60_000,
      cwd: "/home/ann/SECRET-client/web",
      repo: { root: "/home/ann/SECRET-client/web", remote, branch: "work" },
      models: ["claude-opus-5-5"],
      cost: { total_usd: 6, source: "recorded" },
      counts: { prompts: 1, tool_calls: 2, files_changed: 2, lines_added: 3 },
      prompts: [
        { prompt_id: "p1", at: "2026-11-10T09:00:00Z", ended_at: "2026-11-10T09:30:00Z", outcome: "completed", error: "SECRET error", text: { sha256: "a".repeat(64), chars: 31, preview: "SECRET here is my token sly_abc" } },
      ],
      tool_calls: [
        { tool_use_id: "t1", prompt_id: "p1", tool: "Edit", model: "claude-opus-5-5", status: "ok", file_path: "src/a.ts", input_sha256: "b".repeat(64), input_summary: "SECRET what it was given", lines_added: 3 },
        { tool_use_id: "t2", prompt_id: "p1", tool: "Bash", status: "failed", file_path: "/home/ann/SECRET-client/.env", input_summary: "SECRET cat .env", error: "SECRET output" },
      ],
      files: [
        { path: "src/a.ts", writes: 1, lines_added: 3 },
        { path: "notes/SECRET-plan.md", writes: 1 },
        { path: "~/SECRET/.zshrc", reads: 1 },
        { path: "../SECRET-other/b.ts", reads: 1 },
      ],
      subagents: [{ agent_id: "a1", agent_type: "Explore", description: "SECRET what it was sent to find", tool_calls: 4 }],
      instruction_files: ["CLAUDE.md", "~/.claude/SECRET.md"],
    },
    rewrite: { files_measured: 2, files: [{ path: "src/a.ts", lines_added: 3, lines_surviving: 3 }, { path: "/home/ann/SECRET-client/x.ts" }] },
    lines: [
      { path: "src/a.ts", model: "claude-opus-5-5", hashes: lines.map(h) },
      { path: "notes/SECRET-plan.md", model: null, hashes: [h(900)] },
    ],
  };
}

const put = (s: ReturnType<typeof session>) => call(work.ann, "PUT", `/sessions/m1/claude-code/${s.session.session_id}`, s);
const shownIds = async () => (await call(demo.admin, "GET", "/sessions")).body.sessions.map((s: any) => s.session_id).sort();

test("a path of the repository that may be shown, and one that is somewhere else", () => {
  for (const path of ["src/a.ts", "README.md", ".claude/worktrees/w1/src/a.ts", "notesy/a.md"]) assert.ok(inRepo(path, ["notes"]), path);
  for (const path of ["/etc/passwd", "~/x", "../up/a.ts", "src/../../a.ts", "C:\\Users\\ann\\a.ts", "\\\\host\\share", "notes", "notes/a.md", "", null, undefined]) {
    assert.ok(!inRepo(path, ["notes"]), String(path));
  }
  // a folder may be named with its slash
  assert.ok(!inRepo("notes/a.md", ["notes/"]));
});

test("a session as it is shown holds nothing that was typed or run, and nothing outside the repository", () => {
  const made = shown(session("s1", REPO) as never, ["notes"]);
  assert.doesNotMatch(JSON.stringify(made), /SECRET|sly_|sha256/);
  const s = made.session!;
  // who, when, with what and for how much stay
  assert.deepEqual(
    [s.user, s.models, s.cost, s.repo, s.content, s.title, s.cwd],
    [{ name: "Ann", email: "ann@example.com" }, ["claude-opus-5-5"], { total_usd: 6, source: "recorded" }, { remote: REPO, branch: "work" }, "metadata", null, null],
  );
  assert.deepEqual(s.prompts, [{ prompt_id: "p1", at: "2026-11-10T09:00:00Z", ended_at: "2026-11-10T09:30:00Z", outcome: "completed" }]);
  assert.deepEqual(s.tool_calls!.map((t) => [t.tool, t.status, t.file_path]), [["Edit", "ok", "src/a.ts"], ["Bash", "failed", null]]);
  assert.deepEqual(s.files!.map((f) => f.path), ["src/a.ts"]);
  assert.deepEqual(s.subagents, [{ agent_id: "a1", agent_type: "Explore", description: null, tool_calls: 4 }]);
  assert.deepEqual(s.instruction_files, ["CLAUDE.md"]);
  assert.deepEqual(made.rewrite!.files!.map((f) => f.path), ["src/a.ts"]);
  assert.deepEqual(made.lines, [{ path: "src/a.ts", model: "claude-opus-5-5", hashes: [h(1), h(2), h(3)] }]);
});

test("one repository's sessions are shown in another organisation, and kept up to date there", async () => {
  assert.equal((await put(session("s1", REPO))).status, 200);
  assert.equal((await put(session("s2", REPO, [4, 5]))).status, 200);
  assert.equal((await put(session("other", "github.com/acme/SECRET-client"))).status, 200);
  // a pull request reported where it is shown, before the sessions that wrote it are there
  const report = {
    repo: REPO, number: 1, title: "Add a", url: `https://${REPO}/pull/1`, author: "ann", state: "open",
    created_at: "2026-11-10T12:00:00Z", event: "opened", commits: 1, reviews: 0, changes_requested: 0,
    review_comments: 0, bot_review_comments: 0, review_rounds: 0, commit_emails: ["ann@example.com"],
    files: [{ path: "src/a.ts", hashes: [h(1), h(2), h(3), h(77)] }],
  };
  assert.equal((await call(demo.ci, "PUT", "/prs", report)).body.attribution.now.agent_lines, 0);

  assert.deepEqual(await copy(), { copied: 2, removed: 0, failed: 0, matched: 1 });
  // only that repository's, and the pull request's lines are theirs now, at what they cost
  assert.deepEqual(await shownIds(), ["s1", "s2"]);
  const pull = (await call(demo.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body;
  assert.deepEqual([pull.attribution.now.agent_lines, pull.cost.usd, pull.sessions[0].session.owner_email], [3, 6, "ann@example.com"]);
  // nothing of what was typed or run is in anything the organisation it is shown in answers
  for (const path of ["/sessions", "/sessions/m1/claude-code/s1", "/files", "/summary?by=repo", "/filters", `/prs/detail?repo=${REPO}&number=1`]) {
    const answer = await call(demo.admin, "GET", path);
    assert.equal(answer.status, 200, path);
    assert.doesNotMatch(answer.text, /SECRET|sly_/, path);
  }
  // nor in what it keeps
  const kept = await db.query<{ payload: unknown }>(`SELECT payload FROM sessions WHERE org_id = 'demo'`);
  assert.doesNotMatch(JSON.stringify(kept), /SECRET|sly_/);
  // and where it was uploaded, everything is as it was
  assert.match((await call(work.admin, "GET", "/sessions/m1/claude-code/s1")).text, /SECRET here is my token/);

  // nothing new: nothing is done, and no pull request is matched again
  assert.deepEqual(await copy(), { copied: 0, removed: 0, failed: 0, matched: 0 });

  // one sent again is copied again; one taken back is gone there too, and from the pull request
  assert.equal((await put(session("s2", REPO, [4, 5, 6]))).status, 200);
  assert.equal((await call(work.ann, "DELETE", "/sessions/m1/claude-code/s1")).status, 200);
  assert.deepEqual(await copy(), { copied: 1, removed: 1, failed: 0, matched: 1 });
  assert.deepEqual(await shownIds(), ["s2"]);
  assert.equal((await call(demo.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body.attribution.now.agent_lines, 0);
  const lines = await db.query<{ n: unknown }>(`SELECT sum(hashed_lines) AS n FROM sessions WHERE org_id = 'demo'`);
  assert.equal(Number(lines[0]?.n), 3);

  // a session uploaded straight to where it is shown, from another repository, is left alone
  const direct = await tokenFor(db, { email: "host@example.com", role: "member" }, "demo");
  const own = session("own", "github.com/acme/elsewhere");
  assert.equal((await call(direct, "PUT", "/sessions/m1/claude-code/own", own)).status, 200);
  await copy();
  assert.deepEqual(await shownIds(), ["own", "s2"]);
});

test("the settings of a demo: all of them or none, and two organisations", () => {
  assert.equal(demoFrom({}), undefined);
  const all = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "demo" };
  assert.deepEqual(demoFrom(all), { from: "work", repo: REPO, org: "demo", hide: [], minutes: 30 });
  assert.deepEqual(
    demoFrom({ ...all, SESSIONLY_DEMO_HIDE: " docs/, ./notes ,\nprivate.md", SESSIONLY_DEMO_MINUTES: "5" }),
    { from: "work", repo: REPO, org: "demo", hide: ["docs/", "notes", "private.md"], minutes: 5 },
  );
  const problem = (env: NodeJS.ProcessEnv) => (demoFrom(env) as { problem: string }).problem;
  assert.match(problem({ SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_ORG: "demo" }), /needs all three/);
  // in one organisation, removing what is gone would remove everything else
  assert.match(problem({ ...all, SESSIONLY_DEMO_ORG: "work" }), /same organisation/);
  for (const minutes of ["0", "1.5", "soon", "100000"]) assert.match(problem({ ...all, SESSIONLY_DEMO_MINUTES: minutes }), /SESSIONLY_DEMO_MINUTES/);
});
