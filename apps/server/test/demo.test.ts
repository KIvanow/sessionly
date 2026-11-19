import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db, OrgDb } from "../src/db.ts";
import { copyRepo, demoFrom, EMPTY_COPIES, hideFrom, inRepo, repoOf, reportsShownIn, rulesOf, shown, shownReport } from "../src/demo.ts";
import { showRepo, unheeded } from "../src/run.ts";
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
const copy = (hide = ["notes"], repo = REPO) => copyRepo(from, to, { repo, hide });

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
  const made = JSON.stringify(shown(mark(session("s1", REPO)) as never, ["notes"]));
  assert.doesNotMatch(made, /LATER|SECRET/);
  // and what is shown of it is what was before
  assert.deepEqual(JSON.parse(made), JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, ["notes"]))));
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
  const made = JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, ["notes"])));
  assert.doesNotMatch(JSON.stringify(made), /SECRET|sly_|sha256/);
  const s = made.session;
  // who, when, with what and for how much stay
  assert.deepEqual(
    [s.user, s.models, s.cost, s.repo, s.content, s.title, s.cwd],
    [{ name: "Ann", email: "ann@example.com" }, ["claude-opus-5-5"], { total_usd: 6, source: "recorded" }, { remote: REPO, branch: "work" }, "metadata", null, null],
  );
  assert.deepEqual(s.prompts, [{ prompt_id: "p1", at: "2026-11-10T09:00:00Z", ended_at: "2026-11-10T09:30:00Z", outcome: "completed" }]);
  assert.deepEqual(s.tool_calls!.map((t: any) => [t.tool, t.status, t.file_path]), [["Edit", "ok", "src/a.ts"], ["Bash", "failed", null]]);
  assert.deepEqual(s.files!.map((f: any) => f.path), ["src/a.ts"]);
  assert.deepEqual(s.subagents, [{ agent_id: "a1", agent_type: "Explore", description: null, tool_calls: 4 }]);
  assert.deepEqual(s.instruction_files, ["CLAUDE.md"]);
  assert.deepEqual(made.rewrite!.files!.map((f: any) => f.path), ["src/a.ts"]);
  // and of the lines of a file not shown, how many: no path, no model, no hash
  assert.deepEqual(made.lines, [{ path: "src/a.ts", model: "claude-opus-5-5", hashes: [h(1), h(2), h(3)] }, { path: "", model: null, hashes: [""] }]);
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
    files: [{ path: "src/a.ts", hashes: [h(1), h(2), h(3), h(77)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }],
  };
  assert.equal((await call(demo.ci, "PUT", "/prs", report)).body.attribution.now.agent_lines, 0);

  assert.deepEqual(await copy(), { copied: 2, kept: 0, removed: 0, failed: 0, matched: 1 });
  // only that repository's, and the pull request's lines are theirs now, at what they cost: s1 hashed 4
  // lines, 3 of them in the pull request, so $6 x 3/4, as where it was uploaded, though one of the 4 is not shown
  assert.deepEqual(await shownIds(), ["s1", "s2"]);
  const pull = (await call(demo.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body;
  assert.deepEqual([pull.attribution.now.agent_lines, pull.cost.usd, pull.sessions[0].session.owner_email], [3, 4.5, "ann@example.com"]);
  const counted = async (org: string) =>
    (await db.query<{ n: unknown }>(`SELECT sum(hashed_lines) AS n FROM sessions WHERE org_id = $1 AND repo = $2`, [org, REPO])).map((r) => Number(r.n))[0];
  assert.deepEqual([await counted("demo"), await counted("work")], [7, 7]);
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
  assert.deepEqual(await copy(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });

  // one sent again is copied again; one taken back is gone there too, and from the pull request
  assert.equal((await put(session("s2", REPO, [4, 5, 6]))).status, 200);
  assert.equal((await call(work.ann, "DELETE", "/sessions/m1/claude-code/s1")).status, 200);
  assert.deepEqual(await copy(), { copied: 1, kept: 0, removed: 1, failed: 0, matched: 1 });
  assert.deepEqual(await shownIds(), ["s2"]);
  assert.equal((await call(demo.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body.attribution.now.agent_lines, 0);
  // s2's 3 lines, and the one not shown
  assert.equal(await counted("demo"), 4);

  // a session uploaded straight to where it is shown, from another repository, is left alone
  const direct = await tokenFor(db, { email: "host@example.com", role: "member" }, "demo");
  const own = session("own", "github.com/acme/elsewhere");
  assert.equal((await call(direct, "PUT", "/sessions/m1/claude-code/own", own)).status, 200);
  await copy();
  assert.deepEqual(await shownIds(), ["own", "s2"]);

  // a pull request that was to be matched again and was not (the server stopped) is matched the next time
  await db.query(`UPDATE pull_requests SET matched_at = matched_at - interval '1 hour' WHERE org_id = 'demo'`);
  assert.deepEqual(await copy(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 1 });
  assert.deepEqual(await copy(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });

  // another path is hidden: what was copied before is copied again without it
  assert.equal((await put(session("s3", REPO, [7]))).status, 200);
  assert.deepEqual([(await copy()).copied, rulesOf(["notes"]) === rulesOf(["notes", "src"])], [1, false]);
  const files = async () => (await call(demo.admin, "GET", `/files?repo_is=${encodeURIComponent(REPO)}`)).body.files.map((f: any) => f.path);
  assert.deepEqual(await files(), ["src/a.ts"]);
  assert.deepEqual((await copy(["notes", "src"])).copied, 2);
  assert.deepEqual(await files(), []);
  // no line is shown now, and each is still counted: s2 has 3 and 1, s3 1 and 1
  assert.deepEqual([await counted("demo"), await counted("work")], [6, 6]);
  const placed = await db.query<{ lines: unknown }>(`SELECT payload->'lines' AS lines FROM sessions WHERE org_id = 'demo' AND repo = $1`, [REPO]);
  assert.doesNotMatch(JSON.stringify(placed), /[0-9a-f]{16}|src|notes/);

  // a session the organisation it is shown in will not take (its person stopped the repository there) is
  // offered once, and not again until it changes. (Both of hers are offered: the paths not shown are as they were again.)
  const ann = await tokenFor(db, { email: "ann@example.com", role: "member" }, "demo");
  assert.equal((await call(ann, "PUT", "/repos/excluded", { repo: REPO })).status, 200);
  assert.deepEqual(await shownIds(), ["own"]);
  assert.equal((await put(session("s3", REPO, [7, 8]))).status, 200);
  assert.deepEqual([(await copy()).kept, (await copy()).kept], [2, 0]);
  assert.equal((await call(ann, "DELETE", `/repos/excluded?repo=${encodeURIComponent(REPO)}`)).status, 200);

  // another repository is shown now: what was sent of the first is removed
  assert.equal((await put(session("next", "github.com/acme/next"))).status, 200);
  const moved = await copy(["notes"], "github.com/acme/next");
  assert.deepEqual([moved.copied, await shownIds()], [1, ["next", "own"]]);
});

test("the settings of a demo: all of them or none, and two organisations", () => {
  assert.equal(demoFrom({}), undefined);
  const all = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "demo" };
  assert.deepEqual(demoFrom(all), { from: "work", repo: REPO, org: "demo", hide: [], minutes: 30 });
  assert.deepEqual(
    demoFrom({ ...all, SESSIONLY_DEMO_HIDE: " docs/, ./notes ,\nprivate.md", SESSIONLY_DEMO_MINUTES: "5" }),
    { from: "work", repo: REPO, org: "demo", hide: ["docs", "notes", "private.md"], minutes: 5 },
  );
  const problem = (env: NodeJS.ProcessEnv) => (demoFrom(env) as { problem: string }).problem;
  assert.match(problem({ SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_ORG: "demo" }), /needs all three/);
  // in one organisation, removing what is gone would remove everything else
  assert.match(problem({ ...all, SESSIONLY_DEMO_ORG: "work" }), /same organisation/);
  for (const minutes of ["0", "1.5", "soon", "100000"]) assert.match(problem({ ...all, SESSIONLY_DEMO_MINUTES: minutes }), /SESSIONLY_DEMO_MINUTES/);
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
  for (const entry of ["/", "./", ".", "..", "a/../b", "../notes"]) {
    const problem = (hideFrom(`notes, ${entry}`) as { problem: string }).problem;
    assert.match(problem, /SESSIONLY_DEMO_HIDE/, entry);
    assert.ok(problem.includes(`"${entry}"`), entry);
  }
  const env = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "demo", SESSIONLY_DEMO_HIDE: "notes,../x" };
  assert.match((demoFrom(env) as { problem: string }).problem, /"\.\.\/x"/);
  assert.equal(unheeded(env).filter((note) => note.includes("SESSIONLY_DEMO_HIDE")).length, 1);
  // and said when something else is wrong too, since reports are refused for it
  assert.equal(unheeded({ SESSIONLY_DEMO_ORG: "demo", SESSIONLY_DEMO_HIDE: "/" }).filter((note) => note.includes("SESSIONLY_DEMO")).length, 2);
  // one given straight to the matching that cannot be used hides everything
  assert.ok(!inRepo("src/a.ts", [".."]));
});

test("reports to the organisation a repository is shown in are never kept whole", async () => {
  const all = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_REPO: REPO, SESSIONLY_DEMO_ORG: "reported", SESSIONLY_DEMO_HIDE: "notes" };
  // whatever else is wrong with the settings, the paths not shown are left out
  for (const env of [{ ...all, SESSIONLY_DEMO_MINUTES: "soon" }, { ...all, SESSIONLY_DEMO_FROM: "" }, { ...all, SESSIONLY_DEMO_FROM: "reported" }, { ...all, SESSIONLY_DEMO_REPO: "~/x" }]) {
    assert.ok(demoFrom(env) && "problem" in demoFrom(env)!);
    assert.deepEqual(reportsShownIn(env), { org: "reported", hide: ["notes"] });
  }
  assert.equal(reportsShownIn({ ...all, SESSIONLY_DEMO_ORG: " " }), undefined);
  await newOrg(db, "reported");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, "reported");
  const report = (number: number) => ({
    repo: "github.com/acme/reported", number, author: "ann", state: "open", created_at: "2026-11-10T12:00:00Z", event: "opened",
    commits: 1, reviews: 0, changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0,
    files: [{ path: "src/a.ts", hashes: [h(1)] }, { path: "notes/SECRET-plan.md", hashes: [h(2)] }],
  });
  const kept = () => db.query(`SELECT * FROM pull_request_reports WHERE org_id = 'reported'`);
  const misset = createApp(db, { demo: reportsShownIn({ ...all, SESSIONLY_DEMO_MINUTES: "soon" }) });
  assert.equal((await call(ci, "PUT", "/prs", report(1), misset)).status, 200);
  assert.equal((await kept()).length, 1);
  assert.doesNotMatch(JSON.stringify(await kept()), /SECRET/);
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
  };
}
const send = (token: string, s: ReturnType<typeof session>) => call(token, "PUT", `/sessions/m1/claude-code/${s.session.session_id}`, s);
const idsIn = async (token: string) => (await call(token, "GET", "/sessions")).body.sessions.map((s: any) => [s.session_id, s.owner_email]).sort();

test("a copy deleted where it is shown is sent again, and one turned down there is offered once", async () => {
  const p = await pair("again");
  const copyIt = () => copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] });
  assert.equal((await send(p.ann, session("a1", REPO))).status, 200);
  assert.deepEqual(await copyIt(), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 0 });
  // its person deletes it there: it is copied again, though nothing changed where it was uploaded
  const annThere = await tokenFor(db, { email: "ann@example.com", role: "member" }, p.there);
  assert.equal((await call(annThere, "DELETE", "/sessions/m1/claude-code/a1")).status, 200);
  assert.deepEqual(await copyIt(), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(await idsIn(p.admin), [["a1", "ann@example.com"]]);
  assert.deepEqual(await copyIt(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });

  // someone else's there by the same name: turned down (Conflict), once, and theirs is left as it is
  const bob = await tokenFor(db, { email: "bob@example.com", role: "member" }, p.there);
  assert.equal((await send(bob, session("b1", "github.com/acme/elsewhere"))).status, 200);
  assert.equal((await send(p.ann, session("b1", REPO))).status, 200);
  const logged: unknown[] = [];
  const copyLogged = () => copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] }, { log: (err) => logged.push(err) });
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 1, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual([logged, await idsIn(p.admin)], [[], [["a1", "ann@example.com"], ["b1", "bob@example.com"]]]);
  const bobs = await db.query<{ repo: string }>(`SELECT repo FROM sessions WHERE org_id = $1 AND session_id = 'b1'`, [p.there]);
  assert.deepEqual(bobs.map((r) => r.repo), ["github.com/acme/elsewhere"]);

  // she is removed there with her data: her copy goes, is offered once more (RemovedPerson), and not again until it changes
  await db.query(`INSERT INTO users (id, org_id, email, role) VALUES ('usr_ann_again', $1, 'ann@example.com', 'member')`, [p.there]);
  assert.equal((await call(p.admin, "DELETE", "/users/usr_ann_again?data=true")).status, 200);
  assert.deepEqual(await idsIn(p.admin), [["b1", "bob@example.com"]]);
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 1, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
  assert.equal((await send(p.ann, session("a1", REPO, [1, 2]))).status, 200);
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 1, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(logged, []);
  // and what is noted of what was sent holds no address, to be left behind when a person goes
  const columns = await db.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'shown_sessions' ORDER BY ordinal_position`,
  );
  assert.deepEqual(columns.map((c) => c.name), ["org_id", "machine_id", "source", "session_id", "sent_at", "rules", "stored", "copied_at", "removed_at"]);
  assert.doesNotMatch(JSON.stringify(await db.query(`SELECT * FROM shown_sessions WHERE org_id = $1`, [p.there])), /@/);
});

test("a session filed under someone else since is theirs where it is shown too, by what is there", async () => {
  const p = await pair("refiled");
  assert.equal((await send(p.ann, session("r1", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).copied, 1);
  // as an env token's upload moves a session to its person, and when it was stored stays as it was
  await db.query(`UPDATE sessions SET owner_email = 'cleo@example.com' WHERE org_id = $1 AND session_id = 'r1'`, [p.work]);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(await idsIn(p.admin), [["r1", "cleo@example.com"]]);
});

test("without the organisation the sessions are uploaded to, what was copied from it is removed", async () => {
  const p = await pair("gone");
  const demoOf = { from: p.work, repo: REPO, org: p.there, hide: ["notes"], minutes: 30 };
  assert.equal((await send(p.ann, session("g1", REPO))).status, 200);
  assert.equal((await send(p.ann, session("g2", REPO))).status, 200);
  const warned: string[] = [];
  const warn = (text: string) => warned.push(text);
  assert.deepEqual(await showRepo(db, demoOf, { warn }), { copied: 2, kept: 0, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(warned, []);
  // deleted, and not purged yet: at once, and not held back as an empty repository is
  await db.query(`UPDATE orgs SET deleted_at = now() WHERE id = $1`, [p.work]);
  assert.deepEqual(await showRepo(db, demoOf, { warn }), { copied: 0, kept: 0, removed: 2, failed: 0, matched: 0 });
  assert.deepEqual(await idsIn(p.admin), []);
  assert.match(warned[0]!, new RegExp(`SESSIONLY_DEMO_FROM: there is no organisation ${p.work}\\. What was copied from it is removed`));
  // without the one they are shown in, there is nothing to do
  assert.equal(await showRepo(db, { ...demoOf, org: "nowhere" }, { warn }), null);
  assert.match(warned.at(-1)!, /SESSIONLY_DEMO_ORG: there is no organisation nowhere/);
});

test("the repository is named as sessions are filed under it, and a name that matches nothing empties the demo only in time", async () => {
  for (const written of [REPO, `${REPO}/`, `https://${REPO}.git`, `https://ann:sly_x@GitHub.com/acme/shown`, "git@github.com:acme/shown.git", `ssh://git@github.com:22/acme/shown`, ` GITHUB.COM/acme/shown `]) {
    assert.equal(repoOf(written), REPO, written);
  }
  for (const written of ["", "/", "~/code/shown", "/home/ann/shown", "github.com", "https://github.com/", "github.com/a b"]) assert.equal(repoOf(written), null, written);
  const all = { SESSIONLY_DEMO_FROM: "work", SESSIONLY_DEMO_ORG: "demo" };
  assert.equal((demoFrom({ ...all, SESSIONLY_DEMO_REPO: `https://${REPO}.git/` }) as { repo: string }).repo, REPO);
  assert.match((demoFrom({ ...all, SESSIONLY_DEMO_REPO: "~/code/shown" }) as { problem: string }).problem, /SESSIONLY_DEMO_REPO/);

  const p = await pair("named");
  assert.equal((await send(p.ann, session("n1", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).copied, 1);
  // the owner and name in other letters are the same repository: nothing to do
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: "github.com/ACME/Shown", hide: [] }), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
  // one with none of its sessions: what was sent is left, and said, until that has held on EMPTY_COPIES copies in a row
  const empty = { copies: 0 };
  const logged: unknown[] = [];
  const wrong = () => copyRepo(p.from, p.to, { repo: "github.com/acme/typo", hide: [] }, { empty, log: (err) => logged.push(err) });
  assert.equal(EMPTY_COPIES, 3);
  assert.deepEqual([(await wrong()).removed, (await wrong()).removed], [0, 0]);
  assert.equal(logged.length, 2);
  assert.match(String(logged[0]), /no sessions of github\.com\/acme\/typo/);
  assert.deepEqual(await idsIn(p.admin), [["n1", "ann@example.com"]]);
  // put right in between: the count starts again
  assert.deepEqual((await copyRepo(p.from, p.to, { repo: REPO, hide: [] }, { empty })).removed, 0);
  assert.equal(empty.copies, 0);
  assert.deepEqual([(await wrong()).removed, (await wrong()).removed, (await wrong()).removed], [0, 0, 1]);
  assert.deepEqual(await idsIn(p.admin), []);
});

test("after a copy, only the shown repository's pull requests are matched again", async () => {
  const p = await pair("pulls");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  const report = (repo: string, number: number) => ({
    repo, number, author: "ann", state: "open", created_at: "2026-11-10T12:00:00Z", event: "opened", commits: 1, reviews: 0,
    changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0, commit_emails: ["ann@example.com"],
    files: [{ path: "src/a.ts", hashes: [h(1), h(2)] }],
  });
  // the repository, one whose name has it in it, and one that goes by it as another name
  assert.equal((await call(ci, "PUT", "/prs", report(REPO, 1))).status, 200);
  assert.equal((await call(ci, "PUT", "/prs", report(`${REPO}-two`, 2))).status, 200);
  assert.equal((await call(ci, "PUT", "/prs", { ...report("github.com/acme/renamed", 3), aliases: [REPO] })).status, 200);
  const when = async () =>
    Object.fromEntries(
      (await db.query<{ number: unknown; at: unknown }>(`SELECT number, matched_at::text AS at FROM pull_requests WHERE org_id = $1`, [p.there])).map((r) => [Number(r.number), r.at]),
    );
  const before = await when();
  assert.equal((await send(p.ann, session("p1", REPO))).status, 200);
  const done = await copyRepo(p.from, p.to, { repo: REPO, hide: [] });
  const after = await when();
  // the first and the third, and not the second
  assert.deepEqual([done.copied, done.matched, after[1] !== before[1], after[2] === before[2], after[3] !== before[3]], [1, 2, true, true, true]);
});
