import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db, OrgDb } from "../src/db.ts";
import { demoFrom, hideFrom, importDemo, inRepo, repoOf, reportsShownIn, shown, shownReport, type Rules } from "../src/demo.ts";
import { unheeded } from "../src/run.ts";
import { newOrg, testDb, tokenFor } from "./helpers.ts";

const h = (n: number) => n.toString(16).padStart(16, "0");
/** A JSON column as one database or the other gives it back. */
const jsonOf = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const REPO = "github.com/acme/shown";

let db: Db;
let app: Hono<Env>;
// Where the work is uploaded, and where the one repository is shown.
const work = { admin: "", ann: "" };
const demo = { admin: "", ci: "" };
const from = <T>(fn: (db: OrgDb) => Promise<T>) => db.asOrg("work", fn);
const to = <T>(fn: (db: OrgDb) => Promise<T>) => db.asOrg("demo", fn);
const copy = (hide = ["notes"], repo = REPO) => importDemo(from, to, { repo, hide });
// The paths of the repository its pull requests have named, one of them hidden: what may be shown is the others.
const KNOWN: Rules = { hide: ["notes"], known: new Set(["src/a.ts", "CLAUDE.md", "notes/SECRET-plan.md"]) };

before(async () => {
  db = await testDb();
  app = createApp(db, { demo: { org: "demo", hide: ["notes"] } });
  await newOrg(db, "work");
  await newOrg(db, "demo");
  work.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" }, "work");
  work.ann = await tokenFor(db, { email: "ann@example.com", role: "member" }, "work");
  demo.admin = await tokenFor(db, { email: "host@example.com", role: "admin" }, "demo");
  demo.ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, "demo");
});
after(() => db.close());

async function call(token: string, method: string, path: string, body?: unknown, on: Hono<Env> = app) {
  const response = await on.request(`/api/v1${path}`, {
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
        { tool_use_id: "t3", prompt_id: "p1", tool: "Skill", skill: "acme:code-review", status: "ok" },
        { tool_use_id: "t4", prompt_id: "p1", tool: "Skill", skill: "SECRET-team-skill", status: "ok" },
      ],
      reviews: [
        { id: "t3", at: "2026-11-10T09:10:00Z", command: "acme:code-review", via: "skill", ran: "local", effort: "xhigh", pull_number: 7, status: "ok", subagents: 2, estimated_cost_usd: 1.5, findings: 3 },
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
    checkpoints: [{ checkpoint: "7d", added: 3, surviving: 2, measured_at: "2026-11-17T10:00:00.000Z", age_seconds: 604_800, ended_at: "2026-11-10T10:00:00.000Z" }],
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
  // what is hidden is hidden in a worktree's copy of the repository, and as a machine with Windows writes it
  for (const path of [".claude/worktrees/w1/notes/plan.md", "worktrees/w1/notes", "notes\\plan.md", ".claude\\worktrees\\w1\\notes\\plan.md", "..\\up\\a.ts"]) {
    assert.ok(!inRepo(path, ["notes"]), path);
  }
  assert.ok(inRepo("src\\a.ts", ["notes"]));
});

test("nothing a later version of the record adds, at any depth, is shown before it is put there", () => {
  // every object in a session, and the session, with a field nobody has heard of
  const mark = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(mark);
    if (value && typeof value === "object") {
      return { ...Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, mark(inner)])), LATER: "SECRET of a later version" };
    }
    return value;
  };
  const made = JSON.stringify(shown(mark(session("s1", REPO)) as never, KNOWN));
  assert.doesNotMatch(made, /LATER|SECRET/);
  // and what is shown of it is what was before
  assert.deepEqual(JSON.parse(made), JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, KNOWN))));
});

test("a session's review runs are shown, and of skills only a review's name", () => {
  const made = JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, KNOWN))).session;
  assert.deepEqual(made.reviews, [
    { id: "t3", at: "2026-11-10T09:10:00Z", command: "code-review", via: "skill", ran: "local", effort: "xhigh", pull_number: 7, status: "ok", subagents: 2, estimated_cost_usd: 1.5, findings: 3 },
  ]);
  assert.deepEqual(made.tool_calls.map((t: any) => t.skill ?? null), [null, null, "code-review", null]);
  // From a collector that did not count them: still not known.
  const older = session("s2", REPO) as any;
  delete older.session.reviews;
  assert.equal(shown(older, KNOWN).session?.counts?.reviews, undefined);
});

test("a pull request's report is kept without the files that are not shown", () => {
  const report = {
    repo: REPO, number: 9, author: "ann", state: "open", created_at: "2026-11-10T12:00:00Z", event: "opened", commits: 1,
    reviews: 0, changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0,
    files: [{ path: "src/a.ts", hashes: [h(1)] }, { path: "notes/SECRET-plan.md", hashes: [h(2)] }],
    feedback: [
      { kind: "inline", url: null, author: "bob", bot: false, at: "2026-11-10T13:00:00Z", path: "notes/SECRET-plan.md", line: 4 },
      { kind: "inline", url: null, author: "bob", bot: false, at: "2026-11-10T13:00:00Z", path: "src/a.ts", line: 2 },
      { kind: "review", url: null, author: "bob", bot: false, at: "2026-11-10T13:00:00Z", state: "approved" },
    ],
  } as never;
  const made = shownReport(report, ["notes"]);
  assert.doesNotMatch(JSON.stringify(made), /SECRET/);
  assert.deepEqual(made.files.map((f) => f.path), ["src/a.ts"]);
  // the comment is still counted; where it was is not said
  assert.deepEqual(made.feedback!.map((f) => [f.kind, f.path ?? null, f.line ?? null]), [["inline", null, null], ["inline", "src/a.ts", 2], ["review", null, null]]);
});

test("a session as it is shown holds nothing that was typed or run, and nothing outside the repository", () => {
  // as it is stored: a field with nothing in it is not there
  const made = JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, KNOWN)));
  assert.doesNotMatch(JSON.stringify(made), /SECRET|sly_|sha256/);
  const s = made.session;
  // who, when, with what and for how much stay
  assert.deepEqual(
    [s.user, s.models, s.cost, s.repo, s.content, s.title, s.cwd],
    [{ name: "Ann", email: "ann@example.com" }, ["claude-opus-5-5"], { total_usd: 6, source: "recorded" }, { remote: REPO, branch: null }, "metadata", null, null],
  );
  assert.deepEqual(s.prompts, [{ prompt_id: "p1", at: "2026-11-10T09:00:00Z", ended_at: "2026-11-10T09:30:00Z", outcome: "completed" }]);
  assert.deepEqual(s.tool_calls!.map((t: any) => [t.tool, t.status, t.file_path]), [["Edit", "ok", "src/a.ts"], ["Bash", "failed", null], ["Skill", "ok", null], ["Skill", "ok", null]]);
  assert.deepEqual(s.files!.map((f: any) => f.path), ["src/a.ts"]);
  // a subagent's type may be the name of one the person made
  assert.deepEqual(s.subagents, [{ agent_id: "a1", agent_type: null, description: null, tool_calls: 4 }]);
  assert.deepEqual(s.instruction_files, ["CLAUDE.md"]);
  assert.deepEqual(made.rewrite!.files!.map((f: any) => f.path), ["src/a.ts"]);
  // and of the lines of a file not shown, how many: no path, no model, no hash
  assert.deepEqual(made.lines, [{ path: "src/a.ts", model: "claude-opus-5-5", hashes: [h(1), h(2), h(3)] }, { path: "", model: null, hashes: [""] }]);

  // with no path of the repository known, none is shown: of every line, only that it was there
  const unknown = { hide: ["notes"], known: new Set<string>() };
  const bare = JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, unknown)));
  assert.doesNotMatch(JSON.stringify(bare), /src|CLAUDE|[0-9a-f]{16}/);
  assert.deepEqual(
    [bare.session.files, bare.session.tool_calls.map((t: any) => t.file_path), bare.session.instruction_files, bare.rewrite.files, bare.lines],
    [[], [null, null, null, null], [], [], [{ path: "", model: null, hashes: ["", "", "", ""] }]],
  );
  // a worktree's copy of a known file is that file
  const inWorktree = session("s1", REPO);
  inWorktree.session.files = [{ path: ".claude/worktrees/w1/src/a.ts", writes: 1, lines_added: 3 }];
  // under no name of the person's: the worktree's folder is named after a branch or a task
  inWorktree.session.files = [{ path: ".claude/worktrees/SECRET-task/src/a.ts", writes: 1, lines_added: 3 }];
  inWorktree.lines[0]!.path = ".claude\\worktrees\\SECRET-task\\src\\a.ts";
  const madeInWorktree = shown(inWorktree as never, KNOWN);
  assert.doesNotMatch(JSON.stringify(madeInWorktree), /SECRET-task/);
  assert.deepEqual(
    [madeInWorktree.session!.files!.map((f) => f.path), madeInWorktree.lines![0]!.path],
    [[".claude/worktrees/worktree/src/a.ts"], ".claude/worktrees/worktree/src/a.ts"],
  );
  // and a file of the repository in a folder called worktrees is that file
  inWorktree.session.files = [{ path: "test/worktrees/a/b.ts", writes: 1 }];
  assert.deepEqual(shown(inWorktree as never, { hide: [], known: new Set(["test/worktrees/a/b.ts"]) }).session!.files!.map((f) => f.path), ["test/worktrees/a/b.ts"]);

  // which servers a person's tools come from, and the platform's id of a cloud session, are not shown
  const more = session("s1", REPO) as any;
  more.session.runtime = { kind: "cloud", id: "cse_SECRET" };
  more.session.tool_calls.push({ tool_use_id: "t3", tool: "mcp__SECRET-crm__find", status: "ok" }, { tool_use_id: "t4", tool: "MCP:SECRET-move", status: "ok" });
  more.rewrite = { ...more.rewrite, branch: "work", head: "abc123" };
  const madeMore = shown(more, KNOWN);
  assert.doesNotMatch(JSON.stringify(madeMore.session), /SECRET/);
  assert.deepEqual([madeMore.session!.runtime, madeMore.session!.tool_calls!.map((t) => t.tool)], [{ kind: "cloud", id: null }, ["Edit", "Bash", "Skill", "Skill", "mcp", "mcp"]]);
  // a cloud agent's branch is how its pull request is found, and the agent named it; a person's own is theirs
  assert.deepEqual([madeMore.session!.repo!.branch, madeMore.rewrite!.branch, madeMore.rewrite!.head], ["work", "work", "abc123"]);
  const local = session("s1", REPO) as any;
  local.rewrite = { ...local.rewrite, branch: "ann/SECRET-plans", head: "abc123" };
  const madeLocal = shown(local, KNOWN);
  assert.deepEqual([madeLocal.session!.repo!.branch, madeLocal.rewrite!.branch, madeLocal.rewrite!.head], [null, null, null]);
});

test("the settings of a demo: all of them or none, and two organisations", () => {
  assert.equal(demoFrom({}), undefined);
  const all = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "demo" };
  assert.deepEqual(demoFrom(all), { from: "work", repo: REPO, org: "demo", hide: [] });
  assert.deepEqual(
    demoFrom({ ...all, SESSIONLY_DEMO_HIDE: " docs/, ./notes ,\nprivate.md" }),
    { from: "work", repo: REPO, org: "demo", hide: ["docs", "notes", "private.md"] },
  );
  const problem = (env: NodeJS.ProcessEnv) => (demoFrom(env) as { problem: string }).problem;
  assert.match(problem({ SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_ORG: "demo" }), /needs all three/);
  // in one organisation, removing what is gone would remove everything else
  assert.match(problem({ ...all, SESSIONLY_DEMO_ORG: "work" }), /same organisation/);
});

test("what SESSIONLY_DEMO_HIDE hides: names in any folder, paths from the root, folders and patterns, as the Action's ignore", () => {
  const read = hideFrom(" /docs, *.env ,secrets.md,\n./notes/, src/*.key,,");
  assert.deepEqual(read, { hide: ["docs", "*.env", "secrets.md", "notes", "src/*.key"] });
  const hide = (read as { hide: string[] }).hide;
  // a name without a slash is in any folder, a file or a folder, in either case; one with a slash is from the root
  for (const path of [
    "docs/a.md", "web/docs/a.md", "docs", ".env", "config/prod.env", "secrets.md", "deep/down/Secrets.MD", "notes/plan.md",
    "a/notes/plan.md", "src/a.key", "src/deep/b.key", "./docs/a.md", "src//x.key", "prod.env/inside.ts",
    // and so in a worktree's copy, and as Windows writes it
    ".claude/worktrees/w1/src/a.key", "worktrees/w1/docs/a.md", "src\\deep\\b.key", "web\\docs\\a.md",
  ]) {
    assert.ok(!inRepo(path, hide), path);
  }
  for (const path of ["docsy/a.md", "src/a.ts", "lib/a.key", "envs/a.ts", "secrets.md.bak", "web/src/a.key"]) assert.ok(inRepo(path, hide), path);
  // entries that could not hide what was meant are said, and the demo is off
  // and so are places on a machine, which no path of the repository is; a name may still start with ~
  for (const entry of ["/", "./", ".", "..", "a/../b", "../notes", "~/repo/notes", "C:\\repo\\notes", "\\\\host\\share\\notes"]) {
    const problem = (hideFrom(`notes, ${entry}`) as { problem: string }).problem;
    assert.match(problem, /SESSIONLY_DEMO_HIDE/, entry);
    assert.ok(problem.includes(`"${entry}"`), entry);
  }
  const env = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "demo", SESSIONLY_DEMO_HIDE: "notes,../x" };
  assert.match((demoFrom(env) as { problem: string }).problem, /"\.\.\/x"/);
  assert.equal(unheeded(env).filter((note) => note.includes("SESSIONLY_DEMO_HIDE")).length, 1);
  // and said when something else is wrong too, since reports are refused for it
  assert.equal(unheeded({ SESSIONLY_DEMO_ORG: "demo", SESSIONLY_DEMO_HIDE: "/" }).filter((note) => note.includes("SESSIONLY_DEMO")).length, 2);
  assert.deepEqual(hideFrom("~$*, /private/drafts, /~/notes"), { hide: ["~$*", "private/drafts", "~/notes"] });
  assert.ok(inRepo("src/a.ts", ["~/notes"]));
  // one given straight to the matching that cannot be used hides everything
  assert.ok(!inRepo("src/a.ts", [".."]));
});

test("reports to the organisation a repository is shown in are never kept whole", async () => {
  const all = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "reported", SESSIONLY_DEMO_HIDE: "notes" };
  // whatever else is wrong with the settings, the paths not shown are left out
  for (const env of [{ ...all, SESSIONLY_DEMO_FROM: "" }, { ...all, SESSIONLY_DEMO_REPO: "~/x" }]) {
    assert.ok(demoFrom(env) && "problem" in demoFrom(env)!);
    assert.deepEqual(reportsShownIn(env), { org: "reported", hide: ["notes"] });
  }
  assert.equal(reportsShownIn({ ...all, SESSIONLY_DEMO_ORG: " " }), undefined);
  // named as the organisation the work is uploaded to as well, either may be the wrong one: reports there are refused
  assert.match((reportsShownIn({ ...all, SESSIONLY_DEMO_FROM: "reported" }) as { problem: string }).problem, /same organisation/);
  await newOrg(db, "reported");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, "reported");
  const report = (number: number) => ({
    repo: "github.com/acme/reported", number, author: "ann", state: "open", created_at: "2026-11-10T12:00:00Z", event: "opened",
    commits: 1, reviews: 0, changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0,
    files: [{ path: "src/a.ts", hashes: [h(1)] }, { path: "notes/SECRET-plan.md", hashes: [h(2)] }],
  });
  const kept = () => db.query(`SELECT * FROM pull_request_reports WHERE org_id = 'reported'`);
  const misset = createApp(db, { demo: reportsShownIn({ ...all, SESSIONLY_DEMO_FROM: "" }) });
  assert.equal((await call(ci, "PUT", "/prs", report(1), misset)).status, 200);
  assert.equal((await kept()).length, 1);
  assert.doesNotMatch(JSON.stringify(await kept()), /SECRET/);
  // nor in the pull request: its files as first and as last reported, and its page, have neither the path nor its line
  const [pull] = await db.query<Record<string, unknown>>(`SELECT first_files, last_files, detail FROM pull_requests WHERE org_id = 'reported' AND number = 1`);
  assert.doesNotMatch(JSON.stringify(pull), new RegExp(`SECRET|${h(2)}`));
  assert.deepEqual(
    [jsonOf(pull!.first_files), jsonOf(pull!.last_files), (jsonOf(pull!.detail) as any).files.map((f: any) => f.path)],
    [[{ path: "src/a.ts", hashes: [h(1)] }], [{ path: "src/a.ts", hashes: [h(1)] }], ["src/a.ts"]],
  );
  // with what is not to be shown not to be read, a report there is refused, and nothing of it is kept
  const unreadable = createApp(db, { demo: reportsShownIn({ ...all, SESSIONLY_DEMO_HIDE: "notes, ../x" }) });
  const refused = await call(ci, "PUT", "/prs", report(2), unreadable);
  assert.deepEqual([refused.status, refused.body.code], [503, "demo_hide_unusable"]);
  assert.equal((await kept()).length, 1);
  const pulls = await db.query(`SELECT number FROM pull_requests WHERE org_id = 'reported'`);
  assert.deepEqual(pulls.map((p) => Number(p.number)), [1]);
});

/** Two organisations of a test's own: the work is uploaded to one and shown in the other. */
async function pair(name: string) {
  const [work, there] = [`${name}-work`, `${name}-demo`];
  await newOrg(db, work);
  await newOrg(db, there);
  return {
    work,
    there,
    from: <T>(fn: (db: OrgDb) => Promise<T>) => db.asOrg(work, fn),
    to: <T>(fn: (db: OrgDb) => Promise<T>) => db.asOrg(there, fn),
    ann: await tokenFor(db, { email: "ann@example.com", role: "member" }, work),
    admin: await tokenFor(db, { email: "host@example.com", role: "admin" }, there),
    ci: await tokenFor(db, { email: "ci@example.com", role: "ci" }, there),
  };
}
const send = (token: string, s: ReturnType<typeof session>) => call(token, "PUT", `/sessions/m1/claude-code/${s.session.session_id}`, s);
const idsIn = async (token: string) => (await call(token, "GET", "/sessions")).body.sessions.map((s: any) => [s.session_id, s.owner_email]).sort();
const pullOf = (number: number, files: { path: string; hashes: string[] }[], more: Record<string, unknown> = {}) => ({
  repo: REPO, number, author: "ann", state: "open", created_at: "2026-11-10T12:00:00Z", event: "opened", commits: 1, reviews: 0,
  changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0, commit_emails: ["ann@example.com"], files, ...more,
});

test("one repository's sessions are copied into another organisation, and copied again in place of the copies before", async () => {
  assert.equal((await put(session("s1", REPO))).status, 200);
  assert.equal((await put(session("s2", REPO, [4, 5]))).status, 200);
  assert.equal((await put(session("other", "github.com/acme/SECRET-client"))).status, 200);
  // a pull request reported where it is shown, before the sessions that wrote it are there
  const report = pullOf(1, [{ path: "src/a.ts", hashes: [h(1), h(2), h(3), h(77)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }], { url: `https://${REPO}/pull/1`, title: "Add a" });
  assert.equal((await call(demo.ci, "PUT", "/prs", report)).body.attribution.now.agent_lines, 0);

  assert.deepEqual(await copy(), { copied: 2, skipped: 0, removed: 0, matched: 1, failed: 0 });
  // only that repository's, and the pull request's lines are theirs now, at what was spent on it: all
  // of the $6 that s1 cost, as where it was uploaded
  assert.deepEqual(await shownIds(), ["s1", "s2"]);
  // what was still there at 7 days comes with each, and is summed as where it was uploaded
  const keptAt = async (token: string) => (await call(token, "GET", `/summary?by=tool&repo_is=${encodeURIComponent(REPO)}`)).body.total.kept_7d;
  assert.deepEqual(await keptAt(demo.admin), { lines_added: 6, lines_surviving: 4, sessions_reached: 2, sessions_total: 2 });
  assert.deepEqual(await keptAt(demo.admin), await keptAt(work.admin));
  assert.deepEqual((await call(demo.admin, "GET", "/sessions/m1/claude-code/s1")).body.upload.checkpoints, session("s1", REPO).checkpoints);
  const pull = (await call(demo.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body;
  assert.deepEqual([pull.attribution.now.agent_lines, pull.cost.usd, pull.sessions[0].session.owner_email], [3, 6, "ann@example.com"]);
  // nothing of what was typed or run is in anything the organisation it is shown in answers, or keeps
  for (const path of ["/sessions", "/sessions/m1/claude-code/s1", "/files", "/summary?by=repo", "/filters", `/prs/detail?repo=${REPO}&number=1`]) {
    const answer = await call(demo.admin, "GET", path);
    assert.equal(answer.status, 200, path);
    assert.doesNotMatch(answer.text, /SECRET|sly_/, path);
  }
  assert.doesNotMatch(JSON.stringify(await db.query(`SELECT payload FROM sessions WHERE org_id = 'demo'`)), /SECRET|sly_/);
  // and where it was uploaded, everything is as it was
  assert.match((await call(work.admin, "GET", "/sessions/m1/claude-code/s1")).text, /SECRET here is my token/);

  // one taken back where it was uploaded goes with the next import, and from the pull request
  assert.equal((await call(work.ann, "DELETE", "/sessions/m1/claude-code/s1")).status, 200);
  assert.deepEqual(await copy(), { copied: 1, skipped: 0, removed: 1, matched: 1, failed: 0 });
  assert.deepEqual(await shownIds(), ["s2"]);
  assert.equal((await call(demo.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body.attribution.now.agent_lines, 0);

  // a session uploaded straight to where it is shown is left alone
  const direct = await tokenFor(db, { email: "host@example.com", role: "member" }, "demo");
  assert.equal((await call(direct, "PUT", "/sessions/m1/claude-code/own", session("own", "github.com/acme/elsewhere"))).status, 200);
  await copy();
  assert.deepEqual(await shownIds(), ["own", "s2"]);

  // another path hidden: the copies are made without it, and it is taken out of the pull request kept there
  assert.equal((await copy(["notes", "src"])).copied, 1);
  const files = async () => (await call(demo.admin, "GET", `/files?repo_is=${encodeURIComponent(REPO)}`)).body.files.map((f: any) => f.path);
  assert.deepEqual(await files(), []);
  const [kept] = await db.query(`SELECT first_files, last_files FROM pull_requests WHERE org_id = 'demo' AND number = 1`);
  assert.doesNotMatch(JSON.stringify(kept), /src\/a\.ts|SECRET/);

  // a name that matches none of its sessions changes nothing
  await assert.rejects(copy(["notes"], "github.com/acme/typo"), /no sessions of github\.com\/acme\/typo/);
  assert.deepEqual(await shownIds(), ["own", "s2"]);
});

test("what a copied session gave a pull request is kept through the next import, and goes with the session", async () => {
  const p = await pair("gave");
  assert.equal((await send(p.ann, session("g1", REPO))).status, 200);
  const importIt = () => importDemo(p.from, p.to, { repo: REPO, hide: [] });
  // review fixes of the session's, pushed after the pull request was opened and taken out again since
  const pushed = (hashes: number[], event: string) => call(p.ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: hashes.map(h) }], { event }));
  await pushed([50], "opened");
  assert.equal((await importIt()).copied, 1);
  assert.equal((await pushed([50, 1, 2], "synchronize")).body.attribution.now.agent_lines, 2);
  assert.equal((await pushed([50], "synchronize")).body.attribution.now.agent_lines, 0);
  const spent = async () => {
    const pull = (await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body;
    return [pull.cost.usd, pull.sessions.map((s: any) => [s.session_id, s.lines, s.contributed_lines])];
  };
  assert.deepEqual(await spent(), [6, [["g1", 0, 2]]]);
  // the copy is made anew: its lines are in no report any more, and it is charged as it was
  assert.equal((await importIt()).copied, 1);
  assert.deepEqual(await spent(), [6, [["g1", 0, 2]]]);
  // taken back where it was uploaded, it goes from the pull request with what it was charged
  assert.equal((await call(p.ann, "DELETE", "/sessions/m1/claude-code/g1")).status, 200);
  assert.equal((await send(p.ann, session("g2", REPO, [9]))).status, 200);
  assert.deepEqual(await importIt(), { copied: 1, skipped: 0, removed: 1, matched: 1, failed: 0 });
  assert.deepEqual(await spent(), [null, []]);
});

test("an import with nothing new leaves what the copies gave as it was, and a line they were opened with goes to a later session once", async () => {
  const p = await pair("opened");
  assert.equal((await send(p.ann, session("o1", REPO, [1, 2]))).status, 200);
  const importIt = () => importDemo(p.from, p.to, { repo: REPO, hide: [] });
  const pushed = (hashes: number[], event: string) => call(p.ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: hashes.map(h) }], { event }));
  // opened with two lines of the session's, of which review takes one before the first import
  await pushed([1, 2], "opened");
  await pushed([2], "synchronize");
  const kept = async () =>
    (await db.query(`SELECT session_id, matched, opened_matched, contributed, gone, contributed_lines FROM pull_sessions WHERE org_id = $1 ORDER BY session_id`, [p.there])).map((row) => JSON.stringify(row));
  const gave = async () => (await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body.sessions.map((x: any) => [x.session_id, x.lines, x.contributed_lines]).sort();
  await importIt();
  assert.deepEqual(await gave(), [["o1", 1, 2]]);
  const first = await kept();
  await importIt();
  assert.deepEqual(await kept(), first);
  // a later session that wrote the line that went: it is that one's, as it would be uploaded there itself
  const later = session("o2", REPO, [1]);
  later.session.started_at = "2026-11-10T09:30:00Z";
  assert.equal((await send(p.ann, later)).status, 200);
  await importIt();
  assert.deepEqual(await gave(), [["o1", 1, 1], ["o2", 0, 1]]);
  const second = await kept();
  await importIt();
  assert.deepEqual(await kept(), second);
});

test("a session by the same name uploaded where it is shown is never replaced, nor removed, by an import", async () => {
  const p = await pair("direct");
  const annThere = await tokenFor(db, { email: "ann@example.com", role: "member" }, p.there);
  assert.equal((await send(annThere, session("d1", "github.com/acme/elsewhere"))).status, 200);
  assert.equal((await send(p.ann, session("d1", REPO))).status, 200);
  assert.equal((await send(p.ann, session("d2", REPO))).status, 200);
  const importIt = () => importDemo(p.from, p.to, { repo: REPO, hide: [] });
  // turned down as someone else's would be; the other is copied all the same
  assert.deepEqual(await importIt(), { copied: 1, skipped: 1, removed: 0, matched: 0, failed: 0 });
  const repoOfD1 = async () => (await db.query<{ repo: string; copied: boolean }>(`SELECT repo, copied FROM sessions WHERE org_id = $1 AND session_id = 'd1'`, [p.there])).map((r) => [r.repo, r.copied]);
  assert.deepEqual(await repoOfD1(), [["github.com/acme/elsewhere", false]]);
  // nor when she stopped the repository there, which hers is not of (stopping it took the copy of the other away)
  assert.equal((await call(annThere, "PUT", "/repos/excluded", { repo: REPO })).status, 200);
  assert.deepEqual(await importIt(), { copied: 0, skipped: 2, removed: 0, matched: 0, failed: 0 });
  assert.deepEqual(await repoOfD1(), [["github.com/acme/elsewhere", false]]);
  assert.deepEqual(await idsIn(p.admin), [["d1", "ann@example.com"]]);
  // and an upload of a copy makes it the uploader's: the next import leaves it
  assert.equal((await call(annThere, "DELETE", `/repos/excluded?repo=${encodeURIComponent(REPO)}`)).status, 200);
  assert.equal((await importIt()).copied, 1);
  assert.equal((await send(annThere, session("d2", "github.com/acme/elsewhere"))).status, 200);
  assert.deepEqual(await importIt(), { copied: 0, skipped: 2, removed: 0, matched: 0, failed: 0 });
});

test("a path is shown only once a pull request reported where it is shown names it", async () => {
  const p = await pair("known");
  const s = session("k1", REPO) as any;
  s.session.files.push({ path: ".env.local", writes: 1 });
  assert.equal((await send(p.ann, s)).status, 200);
  const paths = async () => (jsonOf((await db.query<{ payload: unknown }>(`SELECT payload FROM sessions WHERE org_id = $1`, [p.there]))[0]!.payload) as any).session.files.map((f: any) => f.path);
  await importDemo(p.from, p.to, { repo: REPO, hide: [] });
  assert.deepEqual(await paths(), []);
  assert.equal((await call(p.ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: [h(1)] }]))).status, 200);
  await importDemo(p.from, p.to, { repo: REPO, hide: [] });
  assert.deepEqual(await paths(), ["src/a.ts"]);
});

test("a path hidden later is taken out of what a pull request's surviving lines count as too", async () => {
  const p = await pair("weighed");
  assert.equal((await send(p.ann, session("w1", REPO))).status, 200);
  const files = [{ path: "src/a.ts", hashes: [h(1), h(2), h(3)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }];
  assert.equal((await call(p.ci, "PUT", "/prs", pullOf(1, files))).status, 200);
  const kept = async () => {
    const [row] = await db.query<{ opened_kept: unknown }>(`SELECT opened_kept FROM pull_sessions WHERE org_id = $1 AND number = 1`, [p.there]);
    return Number(row!.opened_kept);
  };
  await importDemo(p.from, p.to, { repo: REPO, hide: [] });
  assert.equal(await kept(), 4);
  // the note's line goes from what it was opened with and from what survived, though matching again finds the same lines
  await importDemo(p.from, p.to, { repo: REPO, hide: ["notes"] });
  assert.equal(await kept(), 3);
  // one that cannot be matched again (reported before its committers were kept) is weighed and
  // charged again all the same: it is not left as from before an upgrade
  await importDemo(p.from, p.to, { repo: REPO, hide: [] });
  await db.query(`UPDATE pull_requests SET committers = NULL WHERE org_id = $1 AND number = 1`, [p.there]);
  const whole = JSON.stringify({ "src/a.ts": [h(1), h(2), h(3)], "notes/SECRET-plan.md": [h(900)] });
  await db.query(`UPDATE pull_sessions SET matched = $2::jsonb, contributed = $2::jsonb, contributed_lines = 4 WHERE org_id = $1 AND number = 1`, [p.there, whole]);
  await db.query(`UPDATE pull_requests SET shown_rules = NULL WHERE org_id = $1 AND number = 1`, [p.there]);
  await importDemo(p.from, p.to, { repo: REPO, hide: ["notes"] });
  const [after] = await db.query<{ contributed_lines: unknown; contributed: unknown }>(`SELECT contributed_lines, contributed FROM pull_sessions WHERE org_id = $1 AND number = 1`, [p.there]);
  const gave = typeof after!.contributed === "string" ? JSON.parse(after!.contributed) : after!.contributed;
  assert.deepEqual([Number(after!.contributed_lines), Object.keys(gave)], [3, ["src/a.ts"]]);
});

test("a pull request where the repository is shown has its reviewers and rounds after an import, and hiding a path leaves them as they were", async () => {
  const p = await pair("split");
  assert.equal((await send(p.ann, session("r1", REPO))).status, 200);
  const files = [{ path: "src/a.ts", hashes: [h(1)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }];
  const feedback = [
    { kind: "inline", author: "coderabbitai[bot]", bot: true, at: "2026-11-10T13:00:00Z", path: "notes/SECRET-plan.md", line: 3 },
    { kind: "review", author: "bob", bot: false, at: "2026-11-10T14:00:00Z", state: "changes_requested" },
  ];
  assert.equal((await call(p.ci, "PUT", "/prs", pullOf(1, files, { feedback, review_round_authors: [] }))).status, 200);
  const stored = async () => {
    const [row] = await db.query<{ review_split: unknown; feedback: unknown }>(`SELECT review_split, feedback FROM pull_requests WHERE org_id = $1 AND number = 1`, [p.there]);
    return { split: row!.review_split == null ? null : (jsonOf(row!.review_split) as any), paths: (jsonOf(row!.feedback) as any[]).map((f) => f.path ?? null) };
  };
  const reported = (await stored()).split;
  assert.deepEqual(reported.reviewers.map((r: any) => [r.author, r.inline, r.reviews]), [["coderabbitai[bot]", 1, 0], ["bob", 0, 1]]);
  assert.deepEqual([reported.rounds, reported.counted_by], [{ bots: 0, people: 0, both: 0 }, "commits"]);
  // one stored there before this was worked out has it once the import has matched it again
  await db.query(`UPDATE pull_requests SET review_split = NULL, review_split_at = NULL WHERE org_id = $1`, [p.there]);
  await importDemo(p.from, p.to, { repo: REPO, hide: [] });
  assert.deepEqual(await stored(), { split: reported, paths: ["notes/SECRET-plan.md", null] });
  // the path goes from where the comment is; who commented, and how often, was never of a path
  await importDemo(p.from, p.to, { repo: REPO, hide: ["notes"] });
  assert.deepEqual(await stored(), { split: reported, paths: [null, null] });
  assert.doesNotMatch(JSON.stringify(reported), /SECRET|notes/);
});
