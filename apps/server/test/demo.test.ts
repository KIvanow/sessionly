import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db, OrgDb } from "../src/db.ts";
import { copyRepo, demoFrom, EMPTY_COPIES, hideFrom, inRepo, repoOf, reportsShownIn, rulesOf, shown, shownReport, withheld, type Rules } from "../src/demo.ts";
import { holdMatching } from "../src/pulls.ts";
import { showRepo, unheeded, unshowElsewhere, unshowing } from "../src/run.ts";
import { storeUpload } from "../src/sessions.ts";
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
const copy = (hide = ["notes"], repo = REPO) => copyRepo(from, to, { repo, hide });
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
  const made = JSON.stringify(shown(mark(session("s1", REPO)) as never, KNOWN));
  assert.doesNotMatch(made, /LATER|SECRET/);
  // and what is shown of it is what was before
  assert.deepEqual(JSON.parse(made), JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, KNOWN))));
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
    [{ name: "Ann", email: "ann@example.com" }, ["claude-opus-5-5"], { total_usd: 6, source: "recorded" }, { remote: REPO, branch: "work" }, "metadata", null, null],
  );
  assert.deepEqual(s.prompts, [{ prompt_id: "p1", at: "2026-11-10T09:00:00Z", ended_at: "2026-11-10T09:30:00Z", outcome: "completed" }]);
  assert.deepEqual(s.tool_calls!.map((t: any) => [t.tool, t.status, t.file_path]), [["Edit", "ok", "src/a.ts"], ["Bash", "failed", null]]);
  assert.deepEqual(s.files!.map((f: any) => f.path), ["src/a.ts"]);
  // a subagent's type may be the name of one the person made
  assert.deepEqual(s.subagents, [{ agent_id: "a1", agent_type: null, description: null, tool_calls: 4 }]);
  assert.deepEqual(s.instruction_files, ["CLAUDE.md"]);
  assert.deepEqual(made.rewrite!.files!.map((f: any) => f.path), ["src/a.ts"]);
  // and of the lines of a file not shown, how many: no path, no model, no hash
  assert.deepEqual(made.lines, [{ path: "src/a.ts", model: "claude-opus-5-5", hashes: [h(1), h(2), h(3)] }, { path: "", model: null, hashes: [""] }]);
  // nothing it names in the repository is left out for not being known
  assert.equal(withheld(session("s1", REPO) as never, KNOWN), false);

  // with no path of the repository known, none is shown: of every line, only that it was there
  const unknown = { hide: ["notes"], known: new Set<string>() };
  const bare = JSON.parse(JSON.stringify(shown(session("s1", REPO) as never, unknown)));
  assert.doesNotMatch(JSON.stringify(bare), /src|CLAUDE|[0-9a-f]{16}/);
  assert.deepEqual(
    [bare.session.files, bare.session.tool_calls.map((t: any) => t.file_path), bare.session.instruction_files, bare.rewrite.files, bare.lines],
    [[], [null, null], [], [], [{ path: "", model: null, hashes: ["", "", "", ""] }]],
  );
  assert.equal(withheld(session("s1", REPO) as never, unknown), true);
  // a worktree's copy of a known file is that file
  const inWorktree = session("s1", REPO);
  inWorktree.session.files = [{ path: ".claude/worktrees/w1/src/a.ts", writes: 1, lines_added: 3 }];
  assert.deepEqual(shown(inWorktree as never, KNOWN).session!.files!.map((f) => f.path), [".claude/worktrees/w1/src/a.ts"]);

  // which servers a person's tools come from, and the platform's id of a cloud session, are not shown
  const more = session("s1", REPO) as any;
  more.session.runtime = { kind: "cloud", id: "cse_SECRET" };
  more.session.tool_calls.push({ tool_use_id: "t3", tool: "mcp__SECRET-crm__find", status: "ok" }, { tool_use_id: "t4", tool: "MCP:SECRET-move", status: "ok" });
  const madeMore = shown(more, KNOWN).session!;
  assert.doesNotMatch(JSON.stringify(madeMore), /SECRET/);
  assert.deepEqual([madeMore.runtime, madeMore.tool_calls!.map((t) => t.tool)], [{ kind: "cloud", id: null }, ["Edit", "Bash", "mcp", "mcp"]]);
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
  // she allows it again there: both are offered again, and taken
  assert.equal((await call(ann, "DELETE", `/repos/excluded?repo=${encodeURIComponent(REPO)}`)).status, 200);
  assert.deepEqual([(await copy()).copied, await shownIds()], [2, ["own", "s2", "s3"]]);

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
  // a day later it is offered again, in case what turned it down has gone; it has not, so once
  await db.query(`UPDATE shown_sessions SET declined_at = declined_at - interval '25 hours' WHERE org_id = $1 AND session_id = 'b1'`, [p.there]);
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 1, removed: 0, failed: 0, matched: 0 });
  assert.deepEqual(await copyLogged(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
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
  assert.deepEqual(columns.map((c) => c.name), [
    "org_id", "machine_id", "source", "session_id", "sent_at", "rules", "known", "withheld", "stored", "started_at", "cloud_branch",
    "copied_at", "removed_at", "declined_at", "allowed_again", "stored_at",
  ]);
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
  // one with none of its sessions: what was sent is left, and said, until that has held on EMPTY_COPIES copies in a row.
  // Each copy is on its own, as after the server is started again: the count is the database's.
  const logged: unknown[] = [];
  const wrong = () => copyRepo(p.from, p.to, { repo: "github.com/acme/typo", hide: [] }, { log: (err) => logged.push(err) });
  const counted = async () => (await db.query<{ copies: unknown }>(`SELECT copies FROM shown_empty_copies WHERE org_id = $1`, [p.there])).map((r) => Number(r.copies));
  assert.equal(EMPTY_COPIES, 3);
  assert.deepEqual([(await wrong()).removed, (await wrong()).removed], [0, 0]);
  assert.deepEqual(await counted(), [2]);
  assert.equal(logged.length, 2);
  assert.match(String(logged[0]), /no sessions of github\.com\/acme\/typo/);
  assert.match(String(logged[1]), /\(2 so far\)/);
  assert.deepEqual(await idsIn(p.admin), [["n1", "ann@example.com"]]);
  // put right in between: the count starts again
  assert.deepEqual((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).removed, 0);
  assert.deepEqual(await counted(), []);
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

/** A pull request of the shown repository, committed to by Ann, with these files. */
const pullOf = (number: number, files: { path: string; hashes: string[] }[], more: Record<string, unknown> = {}) => ({
  repo: REPO, number, author: "ann", state: "open", created_at: "2026-11-10T12:00:00Z", event: "opened", commits: 1, reviews: 0,
  changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0, commit_emails: ["ann@example.com"], files, ...more,
});

/** Everything the organisation a repository is shown in answers about its sessions and files, and keeps of them. */
async function everything(org: string, admin: string, id: string, pull?: number) {
  const paths = ["/sessions", `/sessions/m1/claude-code/${id}`, "/files", "/summary?by=repo", "/filters", ...(pull ? [`/prs/detail?repo=${REPO}&number=${pull}`] : [])];
  const answers = await Promise.all(paths.map((path) => call(admin, "GET", path)));
  const kept = await db.query(`SELECT * FROM sessions WHERE org_id = $1`, [org]);
  return `${answers.map((a) => a.text).join("\n")}\n${JSON.stringify(kept)}`;
}

test("a copy made by other rules is removed when the one by these is turned down", async () => {
  const p = await pair("stale");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  // both of the session's files of the repository are known, and nothing is hidden yet
  assert.equal((await call(ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: [h(1)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }]))).status, 200);
  assert.equal((await send(p.ann, session("st1", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).copied, 1);
  const payload = async () => JSON.stringify(await db.query(`SELECT payload FROM sessions WHERE org_id = $1`, [p.there]));
  assert.match(await payload(), /notes\/SECRET-plan\.md/);
  // she is removed there, and her data is left: her copy stays, and nothing of hers is taken any more
  await db.query(`INSERT INTO users (id, org_id, email, role) VALUES ('usr_ann_stale', $1, 'ann@example.com', 'member')`, [p.there]);
  assert.equal((await call(p.admin, "DELETE", "/users/usr_ann_stale")).status, 200);
  assert.deepEqual(await idsIn(p.admin), [["st1", "ann@example.com"]]);
  // the notes are hidden now: the copy that shows them cannot be replaced, so it goes, and the pull request is matched without it
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] }), { copied: 0, kept: 0, removed: 1, failed: 0, matched: 1 });
  assert.deepEqual(await idsIn(p.admin), []);
  assert.doesNotMatch(await everything(p.there, p.admin, "st1"), /notes/);
  assert.equal((await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body.attribution.now.agent_lines, 0);
  // and it is noted as turned down, not offered again at each copy
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] }), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
  const [noted] = await db.query<{ stored: boolean }>(`SELECT stored FROM shown_sessions WHERE org_id = $1`, [p.there]);
  assert.equal(noted?.stored, false);
});

test("a path is shown only once a pull request reported where it is shown names it", async () => {
  const p = await pair("known");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  // a file that is committed, and one that never is
  const k1 = session("k1", REPO, [11, 12]) as any;
  k1.session.files.push({ path: ".env.local", writes: 1, lines_added: 1 });
  k1.session.tool_calls.push({ tool_use_id: "t3", prompt_id: "p1", tool: "Write", status: "ok", file_path: ".env.local", lines_added: 1 });
  k1.rewrite.files.push({ path: ".env.local", lines_added: 1, lines_surviving: 1 });
  k1.session.instruction_files.push(".env.local");
  k1.lines.push({ path: ".env.local", model: "claude-opus-5-5", hashes: [h(13)] });
  assert.equal((await send(p.ann, k1)).status, 200);
  const hashed = async (org: string) =>
    (await db.query<{ n: unknown }>(`SELECT sum(hashed_lines) AS n FROM sessions WHERE org_id = $1`, [org])).map((r) => Number(r.n))[0];
  const copyIt = () => copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] });

  // before any report: neither path, and no hash, only that 4 lines were there (2 + 1 hidden + 1 not known)
  assert.deepEqual(await copyIt(), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 0 });
  const before = await everything(p.there, p.admin, "k1");
  assert.doesNotMatch(before, /src\/a\.ts|\.env\.local|notes/);
  assert.doesNotMatch(before.replace(/"(?:machine_id|session_id|id|org_id)":"[^"]*"/g, ""), /[0-9a-f]{16}/);
  const [lines] = await db.query<{ lines: unknown }>(`SELECT payload->'lines' AS lines FROM sessions WHERE org_id = $1`, [p.there]);
  assert.deepEqual(typeof lines!.lines === "string" ? JSON.parse(lines!.lines) : lines!.lines, [{ path: "", model: null, hashes: ["", "", "", ""] }]);
  assert.deepEqual([await hashed(p.there), await hashed(p.work)], [4, 4]);
  // nothing has changed: it is not copied again
  assert.deepEqual(await copyIt(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });

  // a pull request names the committed file: its lines are the session's only once the session is copied again
  const pull = pullOf(1, [{ path: "src/a.ts", hashes: [h(11), h(12), h(50)] }]);
  assert.equal((await call(ci, "PUT", "/prs", pull)).body.attribution.now.agent_lines, 0);
  assert.deepEqual(await copyIt(), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 1 });
  const files = (await call(p.admin, "GET", `/files?repo_is=${encodeURIComponent(REPO)}`)).body.files.map((f: any) => f.path);
  assert.deepEqual(files, ["src/a.ts"]);
  const [after] = await db.query<{ lines: unknown }>(`SELECT payload->'lines' AS lines FROM sessions WHERE org_id = $1`, [p.there]);
  assert.deepEqual(typeof after!.lines === "string" ? JSON.parse(after!.lines) : after!.lines, [
    { path: "src/a.ts", model: "claude-opus-5-5", hashes: [h(11), h(12)] },
    { path: "", model: null, hashes: ["", ""] },
  ]);
  // 2 of its 4 lines are in the pull request: $6 x 2/4, as where it was uploaded
  const detail = (await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body;
  assert.deepEqual([detail.attribution.now.agent_lines, detail.cost.usd], [2, 3]);
  // the file nobody committed is still nowhere
  assert.doesNotMatch(await everything(p.there, p.admin, "k1", 1), /\.env\.local|notes/);
  assert.doesNotMatch(JSON.stringify(await db.query(`SELECT * FROM shown_sessions WHERE org_id = $1`, [p.there])), /\.env|@/);
  assert.deepEqual([await hashed(p.there), await hashed(p.work)], [4, 4]);
  // and with nothing more known, nothing more is done, though it still leaves one out
  assert.deepEqual(await copyIt(), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
});

test("a copy matches again only the pull requests it can change", async () => {
  const p = await pair("window");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  const files = [{ path: "src/a.ts", hashes: [h(1)] }];
  // created soon after the sessions start, and so long after that they are out of its look-back, the last on a cloud agent's branch
  assert.equal((await call(ci, "PUT", "/prs", pullOf(1, files))).status, 200);
  assert.equal((await call(ci, "PUT", "/prs", pullOf(2, files, { created_at: "2027-03-01T12:00:00Z" }))).status, 200);
  assert.equal((await call(ci, "PUT", "/prs", pullOf(3, files, { created_at: "2027-03-01T12:00:00Z", head_ref: "claude/far" }))).status, 200);
  const when = async () =>
    Object.fromEntries(
      (await db.query<{ number: unknown; at: unknown }>(`SELECT number, matched_at::text AS at FROM pull_requests WHERE org_id = $1`, [p.there])).map((r) => [Number(r.number), r.at]),
    );
  const changed = (a: Record<number, unknown>, b: Record<number, unknown>) => [1, 2, 3].map((n) => a[n] !== b[n]);
  // a session on the person's machine, started 10 November 2026: 2 and 3 look back no further than 1 December
  const before = await when();
  assert.equal((await send(p.ann, session("w1", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).matched, 1);
  const between = await when();
  assert.deepEqual(changed(before, between), [true, false, false]);
  // a cloud session on 3's branch, as long before: cloud sessions on its branch are counted at any time
  const cloud = session("w2", REPO) as any;
  cloud.session.runtime = { kind: "cloud", id: "cse_1" };
  cloud.session.repo.branch = "claude/far";
  assert.equal((await send(p.ann, cloud)).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).matched, 2);
  assert.deepEqual(changed(between, await when()), [true, false, true]);
  const third = (await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=3`)).body;
  assert.deepEqual(third.attribution.cloud, { agents: ["claude-code"], sessions: 1 });
});

test("a path hidden after a pull request was reported is taken out of it, and its figures are those of one reported since", async () => {
  const p = await pair("rehide");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  const comment = (path: string, line: number) => ({ kind: "inline", url: null, author: "bob", bot: false, at: "2026-11-10T13:00:00Z", path, line });
  // reported before the notes were hidden: the report is kept whole
  const files = [{ path: "src/a.ts", hashes: [h(1), h(2), h(3)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }];
  assert.equal((await call(ci, "PUT", "/prs", pullOf(1, files, { feedback: [comment("notes/SECRET-plan.md", 4), comment("src/a.ts", 2)] }))).status, 200);
  assert.equal((await send(p.ann, session("rh1", REPO))).status, 200);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 1 });
  const detail = async () => (await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body;
  const figures = (d: any) => [d.attribution.first, d.attribution.now.lines, d.attribution.now.agent_lines, d.attribution.by.map((b: any) => [b.lines, b.surviving]), d.cost.usd];
  // its 4 lines are the session's, which hashed 4: $6
  assert.deepEqual(figures(await detail()), [{ lines: 4, agent_lines: 4 }, 4, 4, [[4, 4]], 6]);

  // the notes are hidden now: they go from the pull request as first and as last reported, from its page, from where
  // its comments are and from which lines the session wrote, and it is matched again
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] }), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 1 });
  const hidden = new RegExp(`notes|SECRET|${h(900)}`);
  assert.doesNotMatch(await everything(p.there, p.admin, "rh1", 1), hidden);
  for (const table of ["pull_requests", "pull_sessions", "pull_request_reports"]) {
    assert.doesNotMatch(JSON.stringify(await db.query(`SELECT * FROM ${table} WHERE org_id = $1`, [p.there])), hidden, table);
  }
  // the comment is still counted; where it was is not said
  const after = await detail();
  assert.deepEqual(after.feedback.map((f: any) => [f.path, f.line]), [[null, null], ["src/a.ts", 2]]);
  // as if reported with the notes hidden: 3 lines when opened and now, all 3 still there, and of the session's 4 lines 3 are here: $4.50
  assert.deepEqual(figures(after), [{ lines: 3, agent_lines: 3 }, 3, 3, [[3, 3]], 4.5]);
  // and once that is done, nothing more is
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] }), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
});

test("a removal is forgotten only once the pull requests it may change are matched again", async () => {
  const p = await pair("late");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  assert.equal((await call(ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: [h(1), h(2), h(3)] }]))).status, 200);
  assert.equal((await send(p.ann, session("l1", REPO))).status, 200);
  assert.equal((await send(p.ann, session("l2", REPO, [7]))).status, 200);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 2, kept: 0, removed: 0, failed: 0, matched: 1 });
  assert.equal((await call(p.ann, "DELETE", "/sessions/m1/claude-code/l1")).status, 200);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 0, kept: 0, removed: 1, failed: 0, matched: 1 });
  // as if the server stopped after it removed l1 and before it matched the pull request, and was started 8 days later
  await db.query(`UPDATE shown_sessions SET copied_at = copied_at - interval '10 days', removed_at = removed_at - interval '8 days' WHERE org_id = $1`, [p.there]);
  await db.query(`UPDATE pull_requests SET matched_at = now() - interval '9 days' WHERE org_id = $1`, [p.there]);
  // the pull request is matched again, and only then is the removal forgotten
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 1 });
  const noted = await db.query<{ session_id: string }>(`SELECT session_id FROM shown_sessions WHERE org_id = $1`, [p.there]);
  assert.deepEqual(noted.map((n) => n.session_id), ["l2"]);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
});

test("pull requests left for a report after the key changed do not stop the others being matched again", async () => {
  const p = await pair("rotated");
  // 100 kept with another key, matched longest ago, so that the first batch is all of them, and one more that can be matched
  await db.query(
    `INSERT INTO pull_requests (org_id, repo, number, author, state, first_event, last_event, first_files, last_files, attribution, created_at, committers, matched_at)
     SELECT $1, $2, n, 'ann', 'open', 'opened', 'opened', $3::jsonb, $3::jsonb, '{}'::jsonb, '2026-11-10T12:00:00Z',
            CASE WHEN n <= 100 THEN '["0123456789ab.cdef"]'::jsonb ELSE '[]'::jsonb END,
            CASE WHEN n <= 100 THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END
     FROM generate_series(1, 101) AS n`,
    [p.there, REPO, JSON.stringify([{ path: "src/a.ts", hashes: [h(1)] }])],
  );
  assert.equal((await send(p.ann, session("k1", REPO))).status, 200);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 1, kept: 0, removed: 0, failed: 0, matched: 1 });
  const waiting = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_requests WHERE org_id = $1 AND committers IS NULL`, [p.there]);
  assert.equal(Number(waiting[0]!.n), 100);
});

test("while the repository has no sessions, a copy made by other rules is not held", async () => {
  const p = await pair("held");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  assert.equal((await call(ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: [h(1)] }, { path: "notes/SECRET-plan.md", hashes: [h(900)] }]))).status, 200);
  assert.equal((await send(p.ann, session("hd1", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).copied, 1);
  assert.match(JSON.stringify(await db.query(`SELECT payload FROM sessions WHERE org_id = $1`, [p.there])), /notes\/SECRET-plan\.md/);
  // it is taken back, and the notes are hidden: the copy that shows them goes at once, and is not held as one by
  // these rules would be (a name that matches nothing), and the pull request is matched without it
  assert.equal((await call(p.ann, "DELETE", "/sessions/m1/claude-code/hd1")).status, 200);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: ["notes"] }), { copied: 0, kept: 0, removed: 1, failed: 0, matched: 1 });
  assert.deepEqual(await idsIn(p.admin), []);
  assert.doesNotMatch(await everything(p.there, p.admin, "hd1", 1), /notes|SECRET/);
});

test("a session stored where it is shown, by the same name, after its copy was deleted there is not removed with the copy", async () => {
  const p = await pair("replaced");
  assert.equal((await send(p.ann, session("c1", REPO))).status, 200);
  assert.equal((await send(p.ann, session("c2", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).copied, 2);
  // she deletes the copy there, and uploads one of her own there by the same name; then she takes the first one back
  const annThere = await tokenFor(db, { email: "ann@example.com", role: "member" }, p.there);
  assert.equal((await call(annThere, "DELETE", "/sessions/m1/claude-code/c1")).status, 200);
  assert.equal((await send(annThere, session("c1", "github.com/acme/elsewhere"))).status, 200);
  assert.equal((await call(p.ann, "DELETE", "/sessions/m1/claude-code/c1")).status, 200);
  assert.deepEqual(await copyRepo(p.from, p.to, { repo: REPO, hide: [] }), { copied: 0, kept: 0, removed: 0, failed: 0, matched: 0 });
  const there = await db.query<{ session_id: string; repo: string }>(`SELECT session_id, repo FROM sessions WHERE org_id = $1 ORDER BY session_id`, [p.there]);
  assert.deepEqual(there.map((s) => [s.session_id, s.repo]), [["c1", "github.com/acme/elsewhere"], ["c2", REPO]]);
  // and what was noted of the copy is forgotten
  const noted = await db.query<{ session_id: string }>(`SELECT session_id FROM shown_sessions WHERE org_id = $1 ORDER BY session_id`, [p.there]);
  assert.deepEqual(noted.map((n) => n.session_id), ["c2"]);
});

test("taking back what was copied says whether anything failed, to be tried again", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    // nothing to take back
    const none = { query: async () => [] } as unknown as Db;
    assert.equal(await unshowing(none, undefined, undefined), false);
    // the database cannot be read
    const down = { query: async () => Promise.reject(new Error("down")) } as unknown as Db;
    assert.equal(await unshowing(down, undefined, undefined), true);
    // one session's copy cannot be removed, and the rest goes on: what was noted of it is kept for the next time
    const gone = { machine_id: "m1", source: "claude-code", session_id: "x1", removed: false, stored: true, here: "ann@example.com", stored_at: "2026-11-10 09:00:00+00" };
    let opened = 0;
    const deleted: string[] = [];
    const failing = {
      query: async () => [{ org_id: "elsewhere" }],
      asOrg: async (org: string, fn: (db: OrgDb) => Promise<unknown>) => {
        opened += 1;
        if (opened === 2) throw new Error("the copy cannot be removed");
        return fn({ orgId: org, query: async (sql: string) => (sql.startsWith("DELETE FROM shown_sessions") ? (deleted.push(sql), []) : opened === 1 ? [gone] : []) } as unknown as OrgDb);
      },
    } as unknown as Db;
    assert.equal(await unshowing(failing, undefined, undefined), true);
    assert.deepEqual(deleted, []);
  } finally {
    console.error = quiet;
  }
});

test("a report made while a copy is being stored waits for it, and is matched with what it stored", async (t) => {
  // Only a server takes two transactions at once.
  if (!process.env.TEST_DATABASE_URL) return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const p = await pair("race");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  const ann = { orgId: p.there, email: "ann@example.com", name: null, role: "member" as const, tokenId: null, userId: null, signedIn: false, owner: false };
  let settled = false;
  let reported: ReturnType<typeof call> | undefined;
  // as a copy does it: the matching is held, the session stored, and only then is the transaction done
  await db.asOrg(p.there, async (tx) => {
    await holdMatching(tx, "copying");
    await storeUpload(tx, shown(session("race1", REPO) as never, { hide: [], known: new Set(["src/a.ts"]) }), ann);
    reported = call(ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: [h(1), h(2), h(3)] }])).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false);
  });
  assert.equal((await reported!).body.attribution.now.agent_lines, 3);
});

// Last: it takes back what was copied into every organisation of this file but the one it is told to keep.
test("what was copied into an organisation that is not the one shown in any more is taken back", async () => {
  const p = await pair("moved");
  const ci = await tokenFor(db, { email: "ci@example.com", role: "ci" }, p.there);
  assert.equal((await call(ci, "PUT", "/prs", pullOf(1, [{ path: "src/a.ts", hashes: [h(1), h(2), h(3)] }]))).status, 200);
  assert.equal((await send(p.ann, session("m1s", REPO))).status, 200);
  assert.equal((await copyRepo(p.from, p.to, { repo: REPO, hide: [] })).copied, 1);
  const agentLines = async () => (await call(p.admin, "GET", `/prs/detail?repo=${REPO}&number=1`)).body.attribution.now.agent_lines;
  assert.equal(await agentLines(), 3);
  // a session uploaded straight to it is not the server's to take back
  const direct = await tokenFor(db, { email: "host@example.com", role: "member" }, p.there);
  assert.equal((await call(direct, "PUT", "/sessions/m1/claude-code/own", session("own", "github.com/acme/elsewhere"))).status, 200);
  const warned: string[] = [];
  const warn = (text: string) => warned.push(text);
  // while it is SESSIONLY_DEMO_ORG, as when the settings are set but wrong (reportsShownIn still names it), it is left
  const named = reportsShownIn({ SESSIONLY_DEMO_ORG: p.there, SESSIONLY_DEMO_MINUTES: "soon" })?.org;
  assert.equal(named, p.there);
  const others = (await unshowElsewhere(db, named, { warn })).map((done) => done.org);
  assert.ok(!others.includes(p.there));
  assert.deepEqual(await idsIn(p.admin), [["m1s", "ann@example.com"], ["own", "host@example.com"]]);
  // then it is not: its copies go, the pull request is matched without them, and what was noted of them goes
  warned.length = 0;
  assert.deepEqual(await unshowElsewhere(db, undefined, { warn }), [{ org: p.there, removed: 1, failed: 0, matched: 1 }]);
  assert.match(warned[0]!, new RegExp(`${p.there} is not SESSIONLY_DEMO_ORG any more`));
  assert.deepEqual(await idsIn(p.admin), [["own", "host@example.com"]]);
  assert.equal(await agentLines(), 0);
  assert.deepEqual(await db.query(`SELECT org_id FROM shown_sessions`), []);
  assert.deepEqual(await unshowElsewhere(db, undefined, { warn }), []);
});
