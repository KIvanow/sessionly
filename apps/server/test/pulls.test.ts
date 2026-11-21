import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countHashedLines, migrationAt, openDb, type Db } from "../src/db.ts";
import { DEFAULT_ORG } from "../src/auth.ts";
import { newOrg, testDb, testDbUrl, tokenFor } from "./helpers.ts";
import { attribute, breakdown, charge, chargeAgain, CURRENT_ACTION, type Claim, historyChange, holdPullSessions, MATCH_AT_ONCE, olderAction, UNKNOWN_REPORTER, weigh, weighKept, weighKeptSome, writers, type SessionAt, unionLines } from "../src/pulls.ts";

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

test("the Action version the server names is the one the Action ships", () => {
  const action = JSON.parse(readFileSync(new URL("../../../action/package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(CURRENT_ACTION, action.version);
});

test("an Action is old when it named no version, or an earlier one, number by number", () => {
  assert.equal(olderAction(null, "0.2.0"), true);
  assert.equal(olderAction("0.1.0", "0.2.0"), true);
  assert.equal(olderAction("0.9.0", "0.10.0"), true);
  assert.equal(olderAction("0.2.0", "0.2.1"), true);
  assert.equal(olderAction("0.2.0", "0.2.0"), false);
  assert.equal(olderAction("0.10.0", "0.9.0"), false);
  assert.equal(olderAction("0.2.1", "0.2.0"), false);
  assert.equal(olderAction("1.0.0", "0.9.9"), false);
  // Same numbers: a pre-release is older than the release. A higher version's is not.
  assert.equal(olderAction("0.2.0-rc.1", "0.2.0"), true);
  assert.equal(olderAction("0.2.0", "0.2.0-rc.1"), false);
  assert.equal(olderAction("0.2.0-rc.1", "0.2.0-rc.2"), false);
  assert.equal(olderAction("0.3.0-rc.1", "0.2.0"), false);
  assert.equal(olderAction("0.1.0-rc.1", "0.2.0"), true);
  // Not a version this comparison can read: treated as one that did not say.
  assert.equal(olderAction("0.2", "0.2.0"), true);
  assert.equal(olderAction("v0.2.0", "0.2.0"), true);
  assert.equal(olderAction("0.2.0", ""), false);
  // Nine digits is a version. Ten is not, so it counts as one that did not say.
  assert.equal(olderAction("999999999.0.0", "0.2.0"), false);
  assert.equal(olderAction("1000000000.0.0", "0.2.0"), true);
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

test("a common line goes only to a session that wrote other lines of the pull request", () => {
  const from = (id: string, c: Claim): Claim => ({ ...c, session: { machine_id: "m1", source: c.tool, session_id: id } });
  // line 1 is in three sessions' work on the file: a common one
  const old = [
    from("s1", claim("claude-code", "opus-4-8", "a.css", 1, 1)),
    from("s2", claim("grok", "grok-4", "a.css", 2, 1, 5)),
    from("s3", claim("cursor", null, "a.css", 3, 1)),
  ];
  const pr = [file("a.css", 1, 2, 3)];
  // the session that wrote it has not been uploaded: none of the older ones is taken to have
  assert.deepEqual(attribute(pr, pr, old).now, { lines: 3, agent_lines: 0, by: [] });
  // one that wrote the pull request's other lines has it, though another started later
  const now = [from("s0", claim("claude-code", "opus-5-5", "a.css", 0, 1, 2, 3)), ...old];
  assert.deepEqual(attribute(pr, pr, now).now.by, [{ tool: "claude-code", model: "opus-5-5", lines: 3 }]);
  // and of those that did, the latest
  const two = [from("s4", claim("codex", null, "a.css", 4, 1, 3)), ...now];
  assert.deepEqual(attribute(pr, pr, two).now.by, [
    { tool: "codex", model: null, lines: 2 },
    { tool: "claude-code", model: "opus-5-5", lines: 1 },
  ]);
  // one that added another of its lines has it though that line went to a later session
  const ab = [file("b.css", 20, 1)];
  const lost = [
    from("A", claim("codex", null, "b.css", 9, 20)),
    from("B", claim("grok", "grok-4", "b.css", 5, 20, 1)),
    from("C", claim("cursor", null, "b.css", 3, 1)),
    from("D", claim("claude-code", "opus-4-8", "b.css", 2, 1)),
  ];
  assert.deepEqual(attribute(ab, ab, lost).now.by, [
    { tool: "codex", model: null, lines: 1 },
    { tool: "grok", model: "grok-4", lines: 1 },
  ]);
  // in two sessions' work it is not common yet
  assert.deepEqual(attribute(pr, pr, old.slice(1)).now.by, [{ tool: "cursor", model: null, lines: 1 }]);
  // one session's claims on the same file count as one
  const same = [from("s1", claim("claude-code", "opus", "a.css", 1, 1)), from("s1", claim("claude-code", "haiku", "a.css", 1, 1)), old[1]!];
  assert.equal(attribute(pr, pr, same).now.agent_lines, 1);
  // a file of nothing but common lines is the work of a session that added every one of them
  const imports = [file("main.rs", 7, 8)];
  const each = [
    from("s1", claim("claude-code", "opus-4-8", "main.rs", 1, 7)),
    from("s2", claim("grok", "grok-4", "main.rs", 2, 7)),
    from("s3", claim("cursor", null, "main.rs", 3, 8)),
    from("s4", claim("codex", null, "main.rs", 4, 8)),
    from("s0", claim("claude-code", "opus-5-5", "main.rs", 0, 7, 8)),
  ];
  assert.deepEqual(attribute(imports, imports, each).now.by, [{ tool: "claude-code", model: "opus-5-5", lines: 2 }]);
  // a line the file has three times takes a session that added it three times, not three that added it once
  const thrice = [file("mod.rs", 9, 9, 9)];
  const once = ["s1", "s2", "s3"].map((id, i) => from(id, claim("grok", "grok-4", "mod.rs", i + 1, 9)));
  assert.equal(attribute(thrice, thrice, once).now.agent_lines, 0);
  assert.equal(attribute(thrice, thrice, [...once, from("s0", claim("claude-code", "opus-5-5", "mod.rs", 0, 9, 9, 9))]).now.agent_lines, 3);
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
      { machine_id: "m1", source: "claude-code", session_id: "s1", lines: 3, matched: { "src/b.ts": [h(10)], "src/a.ts": [h(1), h(2)] } },
      { machine_id: "m1", source: "cursor", session_id: "s2", lines: 2, matched: { "src/a.ts": [h(3), h(4)] } },
    ],
  });
  // the sessions add up to what `attribute` counts for agents with a session
  assert.equal(attribute(now, now, claims).now.agent_lines, 6);
  assert.equal(attribute(now, now, claims, writers(now, claims)).now.agent_lines, 6);
  assert.deepEqual(breakdown([], writers([], claims)), { files: [], sessions: [] });
  // a file can be called what every object has already
  const odd = [file("constructor", 1), file("__proto__", 2)];
  const theirs = [{ ...claims[0]!, path: "constructor", hashes: [h(1)] }, { ...claims[0]!, path: "__proto__", hashes: [h(2)] }];
  const [one] = breakdown(odd, writers(odd, theirs)).sessions;
  assert.deepEqual(Object.entries(one!.matched).sort(), [["__proto__", [h(2)]], ["constructor", [h(1)]]]);
  assert.deepEqual(weigh([{ live: true, lines: 2, matched: JSON.parse(JSON.stringify(one!.matched)) }]), [2]);
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
    agent_lines_surviving_once: 0,
    cloud_pulls: 0,
    cloud_pulls_without_session: 0,
    // its sessions were uploaded without a cost figure
    cost_usd: null,
    cost_estimated: false,
    pulls_with_cost_missing: 1,
    pulls_closed_with_cost: 0,
    per_surviving_line_usd: null,
    per_surviving_line_is_floor: false,
    per_surviving_line_estimated: false,
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

test("a report's Action version is kept, and one that does not fit is ignored", async () => {
  const repo = "github.com/acme/pinned";
  const at = (number: number) => call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=${number}`);
  const versionOf = async (number: number) => (await at(number)).body.reporter_version as string | null;
  const pinned = (overrides: Record<string, unknown> = {}) => report({ repo, ...overrides });

  const sent = await call(tokens.ci, "PUT", "/prs", pinned({ number: 40, reporter: { name: "sessionly-action", version: "0.2.0" } }));
  assert.equal(sent.status, 200);
  const page = (await at(40)).body;
  assert.deepEqual([page.reporter_version, page.reporter_current], ["0.2.0", CURRENT_ACTION]);
  assert.equal(page.reporter_older, false);
  const listed = (await call(tokens.admin, "GET", "/prs?repo=acme/pinned")).body.pulls.find((p: { number: number }) => p.number === 40);
  assert.equal(listed.reporter_version, "0.2.0");
  assert.equal(listed.reporter_older, false);
  assert.equal("reporter_current" in listed, false);

  // A report that names none stays without a version, and counts as an older Action.
  assert.equal((await call(tokens.ci, "PUT", "/prs", pinned({ number: 41 }))).status, 200);
  assert.equal(await versionOf(41), null);
  const unnamed = (await at(41)).body;
  assert.equal(unnamed.reporter_older, true);
  assert.equal(unnamed.reporter_current, CURRENT_ACTION);

  // A pre-release is kept. One of the current version is older than the
  // release, and an earlier one is too.
  const pre = await call(tokens.ci, "PUT", "/prs", pinned({
    number: 42,
    reporter: { name: "sessionly-action", version: "0.2.0-rc.1" },
  }));
  assert.equal(pre.status, 200);
  assert.equal(await versionOf(42), "0.2.0-rc.1");
  assert.equal((await at(42)).body.reporter_older, true);
  assert.equal((await call(tokens.ci, "PUT", "/prs", pinned({
    number: 42, event: "synchronize", reporter: { name: "sessionly-action", version: "0.1.0-rc.1" },
  }))).status, 200);
  assert.equal(await versionOf(42), "0.1.0-rc.1");
  assert.equal((await at(42)).body.reporter_older, true);
  // A version the server cannot read is left out. The name is kept, so the
  // report is not an older Action: the server does not know.
  for (const version of ["v0.2.0", "0.2", "2024.11", `0.2.0-${"a".repeat(51)}`, "1.2.1000000000"]) {
    const response = await call(tokens.ci, "PUT", "/prs", pinned({
      number: 42, event: "synchronize", reporter: { name: "sessionly-action", version },
    }));
    assert.equal(response.status, 200, version);
    assert.equal(await versionOf(42), null, version);
    assert.equal((await at(42)).body.reporter_older, false, version);
  }
  // A reporter that is present but does not fit is another client, stored
  // under a fixed name. It is not an older Action. No reporter at all still is.
  const name = "n".repeat(50);
  for (const reporter of [
    { name: "x".repeat(51), version: "0.2.0" },
    { name: "", version: "0.2.0" },
    { version: "0.2.0" },
    "acme",
    "sessionly-action 0.2.0",
  ]) {
    const response = await call(tokens.ci, "PUT", "/prs", pinned({ number: 42, event: "synchronize", reporter }));
    assert.equal(response.status, 200, JSON.stringify(reporter));
    assert.equal(await versionOf(42), null, JSON.stringify(reporter));
    assert.equal((await at(42)).body.reporter_older, false, JSON.stringify(reporter));
  }
  const [keptName] = await db.query<{ reporter_name: string | null }>(
    `SELECT reporter_name FROM pull_requests WHERE repo = $1 AND number = 42`,
    [repo],
  );
  assert.equal(keptName?.reporter_name, UNKNOWN_REPORTER);
  const absent = await call(tokens.ci, "PUT", "/prs", pinned({ number: 42, event: "synchronize", reporter: null }));
  assert.equal(absent.status, 200);
  assert.equal(await versionOf(42), null);
  assert.equal((await at(42)).body.reporter_older, true);
  const [noName] = await db.query<{ reporter_name: string | null }>(
    `SELECT reporter_name FROM pull_requests WHERE repo = $1 AND number = 42`,
    [repo],
  );
  assert.equal(noName?.reporter_name, null);

  // A repository whose only report is that kind of client is not named.
  // One that names no reporter still is.
  const garbled = "github.com/acme/garbled";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ repo: garbled, number: 1, reporter: "acme" }))).status, 200);
  const garbledPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(garbled)}&number=1`)).body;
  assert.equal(garbledPage.reporter_version, null);
  assert.equal(garbledPage.reporter_older, false);
  assert.equal(garbledPage.repo_reporter_older, false);
  assert.deepEqual((await call(tokens.admin, "GET", "/prs/summary?repo=acme/garbled")).body.older_actions, []);
  const missing = "github.com/acme/no-reporter";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ repo: missing, number: 1 }))).status, 200);
  const missingPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(missing)}&number=1`)).body;
  assert.equal(missingPage.reporter_older, true);
  assert.equal(missingPage.repo_reporter_older, true);
  assert.deepEqual((await call(tokens.admin, "GET", "/prs/summary?repo=acme/no-reporter")).body.older_actions, [missing]);
  // A name of 50 characters is accepted, extra fields and all. It is not the
  // Action, so its version is not kept and the report is not an older Action.
  const kept = await call(tokens.ci, "PUT", "/prs", pinned({
    number: 43,
    reporter: { name, version: "0.10.0", note: "not stored" },
  }));
  assert.equal(kept.status, 200);
  const foreign = (await at(43)).body;
  assert.equal(foreign.reporter_version, null);
  assert.equal(foreign.reporter_older, false);
  // Pull request 40 was reported by the current Action within the last 30
  // days, so a later one that named no one does not name the repository.
  assert.equal(foreign.repo_reporter_older, false);
  assert.equal(foreign.repo_reporter_version, null);
  // A later report that names none replaces it: the page then says the Action is old.
  assert.equal((await call(tokens.ci, "PUT", "/prs", pinned({ number: 43, event: "synchronize" }))).status, 200);
  assert.equal(await versionOf(43), null);
  assert.equal((await at(43)).body.reporter_older, true);

  // The current report is still inside 30 days, so the repository is not named.
  const summary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/pinned")).body;
  assert.deepEqual(summary.older_actions, []);
  // The most recent report is from the current Action.
  const currentRepo = "github.com/acme/current";
  const current = await call(tokens.ci, "PUT", "/prs", report({
    repo: currentRepo,
    number: 1,
    reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }));
  assert.equal(current.status, 200);
  const caughtUp = await call(tokens.ci, "PUT", "/prs", report({ repo: currentRepo, number: 2 }));
  assert.equal(caughtUp.status, 200);
  const currentAgain = await call(tokens.ci, "PUT", "/prs", report({
    repo: currentRepo,
    number: 3,
    reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }));
  assert.equal(currentAgain.status, 200);
  const currentSummary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/current")).body;
  assert.equal(currentSummary.total.pulls, 3);
  assert.deepEqual(currentSummary.older_actions, []);

  // Upgraded since: the merged pull request is old, and the open one, reported
  // after it, is current. The merged list does not ask for a workflow edit.
  const upgraded = "github.com/acme/upgraded";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: upgraded, number: 1, state: "merged", merged_at: "2026-11-01T00:00:00Z",
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: upgraded, number: 2, state: "open", reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }))).status, 200);
  const mergedOnly = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/upgraded&state=merged")).body;
  assert.equal(mergedOnly.total.pulls, 1);
  assert.deepEqual(mergedOnly.older_actions, []);
  const mergedPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(upgraded)}&number=1`)).body;
  assert.equal(mergedPage.reporter_version, null);
  assert.equal(mergedPage.reporter_older, true);
  assert.equal(mergedPage.repo_reporter_older, false);
  // The notice would quote the version the most recent report named.
  assert.equal(mergedPage.repo_reporter_version, CURRENT_ACTION);
  assert.equal(mergedPage.reporter_current, CURRENT_ACTION);
  const openPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(upgraded)}&number=2`)).body;
  assert.equal(openPage.reporter_version, CURRENT_ACTION);
  assert.equal(openPage.reporter_older, false);
  assert.equal(openPage.repo_reporter_older, false);
  assert.equal(openPage.repo_reporter_version, CURRENT_ACTION);
  // A later report that named no one does not bring the notice back: the
  // current report is still inside 30 days. The version quoted is that later
  // report's, which named none.
  const oldPage = (await at(41)).body;
  assert.equal(oldPage.reporter_older, true);
  assert.equal(oldPage.repo_reporter_older, false);
  assert.equal(oldPage.repo_reporter_version, null);

  // A current report, then a re-run with no reporter on an older pull request.
  // The re-run is the most recent report, and it does not bring the notice back.
  const reread = "github.com/acme/reread";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: reread, number: 2, state: "open", reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: reread, number: 1, state: "open", reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: reread, number: 1, event: "synchronize", state: "open",
  }))).status, 200);
  const rereadOpen = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/reread&state=open")).body;
  assert.equal(rereadOpen.total.pulls, 2);
  assert.deepEqual(rereadOpen.older_actions, []);
  const rereadPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(reread)}&number=1`)).body;
  assert.equal(rereadPage.reporter_version, null);
  assert.equal(rereadPage.reporter_older, true);
  assert.equal(rereadPage.repo_reporter_older, false);
  assert.equal(rereadPage.repo_reporter_version, null);

  // Every recent report is old, so the repository is named. The page quotes
  // the most recent of them, which named no version.
  const still = "github.com/acme/still-old";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: still, number: 1, reporter: { name: "sessionly-action", version: "0.1.0" },
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ repo: still, number: 2 }))).status, 200);
  const stillSummary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/still-old")).body;
  assert.deepEqual(stillSummary.older_actions, [still]);
  const stillPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(still)}&number=2`)).body;
  assert.equal(stillPage.reporter_older, true);
  assert.equal(stillPage.repo_reporter_older, true);
  assert.equal(stillPage.repo_reporter_version, null);

  // A current report 31 days ago, and an old one since. The current one no
  // longer keeps the notice off.
  const faded = "github.com/acme/faded";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: faded, number: 1, state: "open", reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }))).status, 200);
  await db.query(
    `UPDATE pull_requests SET updated_at = clock_timestamp() - interval '31 days' WHERE repo = $1 AND number = 1`,
    [faded],
  );
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ repo: faded, number: 2 }))).status, 200);
  const fadedSummary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/faded")).body;
  assert.deepEqual(fadedSummary.older_actions, [faded]);
  const fadedCurrent = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(faded)}&number=1`)).body;
  assert.equal(fadedCurrent.reporter_version, CURRENT_ACTION);
  assert.equal(fadedCurrent.reporter_older, false);
  assert.equal(fadedCurrent.repo_reporter_older, true);
  assert.equal(fadedCurrent.repo_reporter_version, null);
  const fadedOld = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(faded)}&number=2`)).body;
  assert.equal(fadedOld.reporter_version, null);
  assert.equal(fadedOld.reporter_older, true);
  assert.equal(fadedOld.repo_reporter_older, true);
  assert.equal(fadedOld.repo_reporter_version, null);

  // A higher-numbered merged pull request reported old, then a lower-numbered
  // open one reported with the current Action. The upgrade clears the notice.
  const lower = "github.com/acme/lower-open";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: lower, number: 8, state: "merged", merged_at: "2026-11-01T00:00:00Z",
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: lower, number: 3, state: "open", reporter: { name: "sessionly-action", version: CURRENT_ACTION },
  }))).status, 200);
  const lowerMerged = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/lower-open&state=merged")).body;
  assert.equal(lowerMerged.total.pulls, 1);
  assert.deepEqual(lowerMerged.older_actions, []);
  const lowerOld = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(lower)}&number=8`)).body;
  assert.equal(lowerOld.reporter_older, true);
  assert.equal(lowerOld.repo_reporter_older, false);
  assert.equal(lowerOld.repo_reporter_version, CURRENT_ACTION);
  const lowerNew = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(lower)}&number=3`)).body;
  assert.equal(lowerNew.reporter_older, false);
  assert.equal(lowerNew.repo_reporter_older, false);
  assert.equal(lowerNew.repo_reporter_version, CURRENT_ACTION);

  // Another client's report is skipped. The most recent report from the Action is old.
  const other = "github.com/acme/other-client";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: other,
    number: 1,
    state: "merged",
    merged_at: "2026-11-01T00:00:00Z",
    reporter: { name: "sessionly-action", version: "0.1.0" },
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: other,
    number: 2,
    reporter: { name: "sessionly-action", version: "0.1.9" },
  }))).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: other,
    number: 3,
    reporter: { name: "custom-reporter", version: "0.0.1" },
  }))).status, 200);
  const otherMerged = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/other-client&state=merged")).body;
  assert.equal(otherMerged.total.pulls, 1);
  assert.deepEqual(otherMerged.older_actions, [other]);
  const otherOld = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(other)}&number=1`)).body;
  assert.equal(otherOld.reporter_version, "0.1.0");
  assert.equal(otherOld.reporter_older, true);
  assert.equal(otherOld.repo_reporter_older, true);
  assert.equal(otherOld.repo_reporter_version, "0.1.9");
  const otherNew = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(other)}&number=3`)).body;
  assert.equal(otherNew.reporter_version, null);
  assert.equal(otherNew.reporter_older, false);
  assert.equal(otherNew.repo_reporter_older, true);
  assert.equal(otherNew.repo_reporter_version, "0.1.9");

  // Another client's version, even one that is not three numbers, is not an older Action.
  const client = "github.com/acme/acme-ci";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: client, number: 1, reporter: { name: "acme-ci", version: "2024.11" },
  }))).status, 200);
  const clientPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(client)}&number=1`)).body;
  assert.equal(clientPage.reporter_version, null);
  assert.equal(clientPage.reporter_older, false);
  assert.equal(clientPage.repo_reporter_older, false);
  assert.equal(clientPage.repo_reporter_version, null);
  const clientSummary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/acme-ci")).body;
  assert.deepEqual(clientSummary.older_actions, []);

  // A newer pre-release is not a reason to downgrade.
  const ahead = "github.com/acme/ahead";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({
    repo: ahead, number: 1, reporter: { name: "sessionly-action", version: "0.3.0-rc.1" },
  }))).status, 200);
  const aheadPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(ahead)}&number=1`)).body;
  assert.equal(aheadPage.reporter_version, "0.3.0-rc.1");
  assert.equal(aheadPage.reporter_older, false);
  assert.equal(aheadPage.repo_reporter_older, false);
  assert.equal(aheadPage.repo_reporter_version, "0.3.0-rc.1");
  assert.deepEqual((await call(tokens.admin, "GET", "/prs/summary?repo=acme/ahead")).body.older_actions, []);

  // A row stored before reports said who sent them is marked with an empty
  // name. It is not an older Action, and it does not name the repository.
  const prior = "github.com/acme/before-names";
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ repo: prior, number: 1 }))).status, 200);
  await db.query(`UPDATE pull_requests SET reporter_name = '' WHERE repo = $1 AND number = 1`, [prior]);
  const priorPage = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(prior)}&number=1`)).body;
  assert.equal(priorPage.reporter_version, null);
  assert.equal(priorPage.reporter_older, false);
  assert.equal(priorPage.repo_reporter_older, false);
  assert.equal(priorPage.repo_reporter_version, null);
  assert.deepEqual((await call(tokens.admin, "GET", "/prs/summary?repo=acme/before-names")).body.older_actions, []);
});

test("an upload matches again the pull requests it adds lines to, and no others", async () => {
  const repo = "github.com/acme/arrives";
  const sent = (number: number, files: unknown[], more: Record<string, unknown> = {}) =>
    call(tokens.ci, "PUT", "/prs", report({ repo, number, commit_emails: ["ann@example.com"], files, ...more }));
  // opened while the session went on: nothing of it is uploaded yet
  assert.equal((await sent(1, [file("a.ts", 900, 901)])).body.attribution.now.agent_lines, 0);
  // one with none of its lines, one of another repository, one closed long ago
  await sent(2, [file("b.ts", 900)]);
  await call(tokens.ci, "PUT", "/prs", report({ repo: `${repo}-2`, number: 1, commit_emails: ["ann@example.com"], files: [file("a.ts", 900)] }));
  await sent(3, [file("a.ts", 900)], { state: "merged", event: "closed", merged_at: "2026-10-01T12:00:00Z" });
  await db.query(`UPDATE pull_requests SET updated_at = now() - interval '30 days' WHERE repo = $1 AND number = 3`, [repo]);
  const matchedAt = async () =>
    (await db.query(`SELECT repo, number, matched_at FROM pull_requests WHERE repo LIKE $1 ORDER BY repo, number`, [`${repo}%`])).map(
      (row) => `${row.repo}#${row.number} ${new Date(row.matched_at as string).getTime()}`,
    );
  const before = await matchedAt();

  const s = session("s-arrives", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [h(900), h(901)] }]);
  s.session.repo.remote = repo;
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-arrives", s)).status, 200);
  const one = (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=1`)).body;
  assert.deepEqual(one.attribution.now.by, [{ tool: "claude-code", model: "claude-opus-5-5", lines: 2 }]);
  assert.equal(one.history[0].event, "match");
  // the others are as they were
  const after = await matchedAt();
  assert.deepEqual(after.filter((row) => !before.includes(row)).map((row) => row.split(" ")[0]), [`${repo}#1`]);

  // past more pull requests reported later that have none of its lines
  const later = repo + "-later";
  await call(tokens.ci, "PUT", "/prs", report({ repo: later, number: 1, commit_emails: ["ann@example.com"], files: [file("a.ts", 910)] }));
  await db.query(
    `INSERT INTO pull_requests (org_id, repo, number, author, state, created_at, first_event, last_event, first_files, last_files, attribution, committers, updated_at)
     SELECT org_id, repo, 100 + n, author, state, created_at, first_event, last_event, '[]', '[]', attribution, committers, now() + make_interval(secs => n)
     FROM pull_requests, generate_series(1, 60) AS n WHERE repo = $1 AND number = 1`,
    [later],
  );
  const behind = session("s-later", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [h(910)] }]);
  behind.session.repo.remote = later;
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-later", behind)).status, 200);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${later}&number=1`)).body.attribution.now.agent_lines, 1);

  // not someone else's with the same line, nor one closed before the session started
  const others = repo + "-others";
  const theirs = (number: number, more: Record<string, unknown>) =>
    call(tokens.ci, "PUT", "/prs", report({ repo: others, number, files: [file("a.ts", 930)], ...more }));
  await theirs(1, { commit_emails: ["eve@example.com"] });
  await theirs(2, { commit_emails: ["ann@example.com"], state: "merged", event: "closed", merged_at: "2026-11-10T10:00:00Z" });
  await theirs(3, { commit_emails: ["ann@example.com"] });
  // and one kept with another key is left for its report, not undone
  await theirs(4, { commit_emails: ["ann@example.com"] });
  await db.query(`UPDATE pull_requests SET committers = '["00000000.x"]' WHERE repo = $1 AND number = 4`, [others]);
  const otherMatched = async () =>
    (await db.query(`SELECT number, matched_at, committers::text AS committers FROM pull_requests WHERE repo = $1 ORDER BY number`, [others])).map(
      (row) => [Number(row.number), new Date(row.matched_at as string).getTime(), row.committers],
    );
  const unmatched = await otherMatched();
  const hers = (turn: number) => {
    const one = session("s-hers", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [h(930)] }]);
    one.session.repo.remote = others;
    (one.session as Record<string, unknown>).user = { email: "ann@example.com" };
    (one.session as Record<string, any>).counts = { prompts: turn };
    return call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-hers", one);
  };
  assert.equal((await hers(1)).status, 200);
  const matchedNow = await otherMatched();
  assert.deepEqual(matchedNow.filter((row, i) => row[1] !== unmatched[i]![1]).map((row) => row[0]), [3]);
  assert.equal(matchedNow[3]![2], '["00000000.x"]');
  // a session still going is uploaded at each turn: one row says what matching again came to
  await db.query(`UPDATE sessions SET payload = jsonb_set(payload, '{lines}', '[]') WHERE session_id = 's-hers'`);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo: others, number: 3 })).body.attribution.now.agent_lines, 0);
  assert.equal((await hers(2)).status, 200);
  const history = async () =>
    (await call(tokens.admin, "GET", `/prs/detail?repo=${others}&number=3`)).body.history.map((row: any) => [row.event, row.agent_lines]);
  assert.deepEqual(await history(), [["match", 1], ["opened", 0]]);
  // the same lines again match nothing again
  const before3 = (await otherMatched())[2]![1];
  assert.equal((await hers(3)).status, 200);
  assert.equal((await otherMatched())[2]![1], before3);
  // a report between, though it moved nothing, is not merged past
  await call(tokens.ci, "PUT", "/prs", report({ repo: others, number: 3, event: "synchronize", commit_emails: ["ann@example.com"], files: [file("a.ts", 930)] }));
  await db.query(`UPDATE sessions SET payload = jsonb_set(payload, '{lines}', '[]') WHERE session_id = 's-hers'`);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo: others, number: 3 })).status, 200);
  assert.deepEqual(await history(), [["match", 0], ["match", 1], ["opened", 0]]);
  // uploaded again without the line: the pull request that had it from before is matched again
  assert.equal((await hers(4)).status, 200);
  const without = session("s-hers", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "b.ts", model: null, hashes: [h(931)] }]);
  without.session.repo.remote = others;
  (without.session as Record<string, unknown>).user = { email: "ann@example.com" };
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-hers", without)).status, 200);
  assert.deepEqual((await history()).slice(0, 2), [["match", 0], ["match", 1]]);

  // of more than can be matched at once, the ones with most of its lines
  const many = repo + "-many";
  for (let number = 1; number <= 6; number += 1) {
    const lines = number === 1 ? [940, 941, 942, 943] : [940];
    await call(tokens.ci, "PUT", "/prs", report({ repo: many, number, commit_emails: ["ann@example.com"], files: [file("a.ts", ...lines)] }));
  }
  const wrote = session("s-wrote", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [940, 941, 942, 943].map(h) }]);
  wrote.session.repo.remote = many;
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-wrote", wrote)).status, 200);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${many}&number=1`)).body.attribution.now.agent_lines, 4);
  const left = await db.query(`SELECT number FROM pull_requests WHERE repo = $1 AND matched_at = updated_at ORDER BY number`, [many]);
  assert.deepEqual(left.map((row) => Number(row.number)), [2]);

  // a line a pull request has many times counts as often as the session added it
  const often = repo + "-often";
  for (let number = 1; number <= 5; number += 1) {
    await call(tokens.ci, "PUT", "/prs", report({ repo: often, number, commit_emails: ["ann@example.com"], files: [file("a.ts", 960, 960, 960, 960, 960)] }));
  }
  await call(tokens.ci, "PUT", "/prs", report({ repo: often, number: 6, commit_emails: ["ann@example.com"], files: [file("a.ts", 961, 962)] }));
  const once = session("s-often", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [960, 961, 962].map(h) }]);
  once.session.repo.remote = often;
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-often", once)).status, 200);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${often}&number=6`)).body.attribution.now.agent_lines, 2);

  // five that have one of its lines from before do not keep out a new one with more of them
  const stack = repo + "-stack";
  const stacked = (hashes: number[]) => {
    const one = session("s-stack", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: hashes.map(h) }]);
    one.session.repo.remote = stack;
    return call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-stack", one);
  };
  await stacked([950]);
  for (let number = 1; number <= 5; number += 1) {
    await call(tokens.ci, "PUT", "/prs", report({ repo: stack, number, commit_emails: ["ann@example.com"], files: [file("a.ts", 950)] }));
  }
  await call(tokens.ci, "PUT", "/prs", report({ repo: stack, number: 6, commit_emails: ["ann@example.com"], files: [file("a.ts", 951, 952, 953)] }));
  await stacked([950, 951, 952, 953]);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${stack}&number=6`)).body.attribution.now.agent_lines, 3);

  // matched again back to what the report before it said: no row says it moved
  const back = repo + "-back";
  const backed = (path: string, hashes: number[], email = "ann@example.com") => {
    const one = session("s-back", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path, model: null, hashes: hashes.map(h) }]);
    one.session.repo.remote = back;
    (one.session as Record<string, unknown>).user = { email };
    return call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-back", one);
  };
  await call(tokens.ci, "PUT", "/prs", report({ repo: back, number: 1, commit_emails: ["ann@example.com"], files: [file("a.ts", 960)] }));
  const backHistory = async () =>
    (await call(tokens.admin, "GET", `/prs/detail?repo=${back}&number=1`)).body.history.map((row: any) => [row.event, row.agent_lines]);
  await backed("a.ts", [960]);
  assert.deepEqual(await backHistory(), [["match", 1], ["opened", 0]]);
  await backed("b.ts", [961]);
  assert.deepEqual(await backHistory(), [["opened", 0]]);

  // the same lines, now with the address it was committed with: matched again
  await backed("a.ts", [960], "eve@example.com");
  assert.deepEqual(await backHistory(), [["opened", 0]]);
  await backed("a.ts", [960]);
  assert.deepEqual(await backHistory(), [["match", 1], ["opened", 0]]);
  // the same lines, by another model: matched again, and the lines are that model's
  const sonnet = session("s-back", "claude-code", "claude-sonnet-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [h(960)] }]);
  sonnet.session.repo.remote = back;
  (sonnet.session as Record<string, unknown>).user = { email: "ann@example.com" };
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-back", sonnet)).status, 200);
  assert.deepEqual((await call(tokens.admin, "GET", `/prs/detail?repo=${back}&number=1`)).body.attribution.now.by, [
    { tool: "claude-code", model: "claude-sonnet-5-5", lines: 1 },
  ]);

  // looking for them fails: the session is stored all the same
  const broken = repo + "-broken";
  await call(tokens.ci, "PUT", "/prs", report({ repo: broken, number: 1, commit_emails: ["ann@example.com"], files: [file("a.ts", 920)] }));
  await db.query(`UPDATE pull_requests SET last_files = '"not files"' WHERE repo = $1`, [broken]);
  const kept = session("s-broken", "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [{ path: "a.ts", model: null, hashes: [h(920)] }]);
  kept.session.repo.remote = broken;
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-broken", kept)).status, 200);
  } finally {
    console.error = quiet;
  }
  assert.equal((await db.query(`SELECT 1 FROM sessions WHERE session_id = 's-broken'`)).length, 1);
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
  // matched a while ago, so that matching again is later whatever the clock's step
  await db.query(`UPDATE pull_requests SET matched_at = matched_at - interval '1 minute' WHERE repo = $1 AND number = 1`, [repo]);
  const detail = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=${number}`)).body;
  const before = await detail(1);
  assert.deepEqual([before.matchable, before.matched_at != null, before.sessions], [true, true, []]);

  // the sessions come after the pull request was closed: no report follows, and it is matched again as they arrive
  await upload("s-after", null, [h(800), h(801)]);
  // someone else's, with the same line: not a committer of this pull request
  await upload("s-else", "eve@example.com", [h(802)]);
  assert.equal((await detail(1)).attribution.now.agent_lines, 2);
  await db.query(`UPDATE pull_requests SET matched_at = matched_at - interval '1 minute' WHERE repo = $1 AND number = 1`, [repo]);

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
  // nor those of a session whose git address is empty: that one is its uploader's
  const empty = session("s-empty", "claude-code", "claude-opus-5-5", "2026-11-10T11:30:00Z", [{ path: "a.ts", model: null, hashes: [h(802)] }]);
  empty.session.repo.remote = repo;
  (empty.session as Record<string, unknown>).user = { email: "" };
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/s-empty", empty)).status, 200);
  await db.query(`UPDATE sessions SET user_email = '' WHERE session_id = 's-empty'`);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 3 })).body.attribution.now.agent_lines, 0);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 1 })).body.attribution.now.agent_lines, 3);
  await call(tokens.ann, "DELETE", "/sessions/m1/claude-code/s-empty");
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
  // a number that is there and is none does not make it a request for all of the repository's
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: null })).status, 400);

  // with a key, what is kept cannot be made from an address without it, and says which key it was
  const keyed = createApp(db, { hashKey: "k".repeat(32) });
  const ask = async (to: typeof app, method: string, path: string, body: unknown, token = tokens.admin) => {
    const response = await to.request(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  assert.equal((await ask(keyed, "PUT", "/prs", report({ ...about, number: 6 }), tokens.ci)).status, 200);
  const [withKey] = await db.query<{ committers: unknown }>(`SELECT committers::text AS committers FROM pull_requests WHERE repo = $1 AND number = 6`, [repo]);
  assert.match(String(withKey!.committers), /^\["[0-9a-f]{8}\.[0-9a-f]{64}"\]$/);
  assert.notEqual(String(withKey!.committers).slice(11), String(kept!.committers).slice(2));
  assert.equal((await ask(keyed, "POST", "/prs/match", { repo, number: 6 })).body.attribution.now.agent_lines, 2);
  // kept with another key (here: none), it waits for a report
  assert.equal((await ask(keyed, "POST", "/prs/match", { repo, number: 1 })).status, 409);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 6 })).status, 409);
  // and matching the list's says so of each from then on: only the one kept with this key
  // is matched, and the one that named no committers, of which nothing is kept
  const mixed = await ask(keyed, "POST", "/prs/match", { repo });
  assert.deepEqual([mixed.body.matched, mixed.body.failed, mixed.body.remaining, mixed.body.needs_report], [2, 0, 0, 4]);
  assert.equal((await detail(1)).matchable, false);
  assert.equal((await detail(6)).matchable, true);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 2147483648 })).status, 400);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 2147483647 })).status, 404);
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
  // a body that cannot be read is not taken as one that asks for all of them
  assert.equal((await call(tokens.admin, "POST", "/prs/match")).status, 400);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", [])).status, 400);
  // nor is a filter that is not text taken as one that was left out
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo: 5 })).status, 400);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo: "acme/many", started: 5 })).status, 400);
  // a time still to come is taken as now, so the requests end: a new run, the rest left for its next
  const ahead = await call(tokens.admin, "POST", "/prs/match", { repo: "acme/many", started: "2999-01-01T00:00:00Z" });
  assert.deepEqual([ahead.status, ahead.body.matched, ahead.body.remaining], [200, MATCH_AT_ONCE, 2]);
  assert.ok(Date.parse(ahead.body.started) < Date.now() + 60_000);
});

const snap = (
  commits: number,
  lines: number,
  agent: number,
  sessions: { id: string; lines: number }[] = [],
  version: string | null = null,
) => ({
  commits,
  lines,
  agent_lines: agent,
  sessions: sessions.map((s) => ({ machine_id: "m1", source: "claude-code", session_id: s.id, lines: s.lines })),
  reporter_version: version,
});

test("the reason for a change is chosen in a fixed order", () => {
  const before = snap(1, 6, 4, [{ id: "s1", lines: 4 }], "0.1.0");
  assert.equal(historyChange(snap(1, 6, 4), null).reason, null);
  assert.equal(historyChange(snap(2, 8, 4, [{ id: "s1", lines: 4 }], "0.2.0"), before).reason, "1 new commit");
  assert.equal(historyChange(snap(4, 9, 5, [{ id: "s1", lines: 4 }, { id: "s2", lines: 1 }]), before).reason, "3 new commits");
  // no new commits: a session that arrived, with how far the agent lines moved
  assert.equal(
    historyChange(snap(1, 6, 21, [{ id: "s1", lines: 4 }, { id: "s2", lines: 17 }]), before).reason,
    "1 session uploaded since: +17 agent lines",
  );
  assert.equal(
    historyChange(snap(1, 6, 6, [{ id: "s1", lines: 4 }, { id: "s2", lines: 1 }, { id: "s3", lines: 1 }]), before).reason,
    "2 sessions uploaded since: +2 agent lines",
  );
  assert.equal(historyChange(snap(1, 6, 0, []), before).reason, "1 session no longer matched: -4 agent lines");
  assert.equal(
    historyChange(snap(1, 6, 0, [], "0.9.0"), { ...before, sessions: [
      { machine_id: "m1", source: "claude-code", session_id: "s1", lines: 2 },
      { machine_id: "m1", source: "claude-code", session_id: "s2", lines: 2 },
    ] }).reason,
    "2 sessions no longer matched: -4 agent lines",
  );
  // fewer commits, ahead of a session that arrived, as new commits are
  assert.equal(historyChange(snap(0, 6, 4, [{ id: "s1", lines: 4 }], "0.1.0"), before).reason, "1 commit removed");
  assert.equal(
    historyChange(snap(1, 8, 5, [{ id: "s1", lines: 4 }, { id: "s2", lines: 1 }], "0.1.0"), snap(3, 6, 4, [{ id: "s1", lines: 4 }], "0.1.0")).reason,
    "2 commits removed",
  );
  // same sessions, same commits, a newer Action, and the lines moved: the versions are named
  assert.equal(historyChange(snap(1, 7, 4, [{ id: "s1", lines: 4 }], "0.2.0"), before).reason, "Action 0.2.0, was 0.1.0");
  // a newer Action also wins when a session's line count changed with it
  assert.equal(historyChange(snap(1, 7, 5, [{ id: "s1", lines: 5 }], "0.2.0"), before).reason, "Action 0.2.0, was 0.1.0");
  // the one before named no version that can be read
  assert.equal(historyChange(snap(1, 7, 4, [{ id: "s1", lines: 4 }], "0.2.0"), { ...before, reporter_version: null }).reason, "Action 0.2.0");
  assert.equal(historyChange(snap(1, 7, 4, [{ id: "s1", lines: 4 }], "0.1.0"), before).reason, "matched again, nothing new");
  // an existing session whose line count changed is neither added nor gone
  const shifted = historyChange(snap(1, 6, 5, [{ id: "s1", lines: 5 }], "0.1.0"), before);
  assert.equal(shifted.reason, "1 session's lines changed: +1 agent lines");
  assert.deepEqual(shifted.sessions_changed, [
    { machine_id: "m1", source: "claude-code", session_id: "s1", lines: 5, lines_before: 4 },
  ]);
  const prior = snap(1, 6, 4, [{ id: "s1", lines: 3 }, { id: "s2", lines: 1 }], "0.1.0");
  assert.equal(
    historyChange(snap(1, 6, 6, [{ id: "s1", lines: 4 }, { id: "s2", lines: 2 }], "0.1.0"), prior).reason,
    "2 sessions' lines changed: +2 agent lines",
  );
});

test("a pull request keeps a history of its figures and says what moved them", async () => {
  const repo = "github.com/acme/history";
  const detail = async (number: number) =>
    (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=${number}`)).body;
  const upload = (id: string, path: string, ...lines: number[]) => {
    const s = session(id, "claude-code", "claude-opus-5-5", "2026-11-10T11:00:00Z", [
      { path, model: null, hashes: lines.map(h) },
    ]);
    s.session.repo.remote = repo;
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  const sent = (number: number, overrides: Record<string, unknown> = {}) =>
    call(tokens.ci, "PUT", "/prs", report({ repo, number, ...overrides }));

  // Two identical reports leave one row. A different event is not, by itself, a change.
  assert.equal((await sent(1, { files: [file("a.ts", 1, 2)] })).status, 200);
  assert.equal((await sent(1, { event: "synchronize", files: [file("a.ts", 1, 2)] })).status, 200);
  let page = await detail(1);
  assert.equal(page.history.length, 1);
  assert.equal(page.history[0].event, "opened");
  assert.equal(page.history[0].change.reason, null);
  assert.deepEqual([page.history[0].lines, page.history[0].agent_lines, page.history[0].commits], [2, 0, 1]);
  assert.deepEqual(page.history[0].sessions, []);

  // A session uploaded between reports matches it again: it is named, and the reason says so.
  // The next report finds nothing more.
  assert.equal((await upload("s-new", "a.ts", 1)).status, 200);
  assert.equal((await sent(1, { event: "synchronize", files: [file("a.ts", 1, 2)] })).status, 200);
  page = await detail(1);
  assert.equal(page.history.length, 2);
  const arrived = page.history[0];
  assert.equal(arrived.event, "match");
  assert.deepEqual(arrived.change.sessions_added.map((s: { session_id: string; lines: number }) => [s.session_id, s.lines]), [["s-new", 1]]);
  assert.equal(arrived.change.sessions_added[0].session.owner_email, "ann@example.com");
  assert.equal(arrived.change.reason, "1 session uploaded since: +1 agent lines");
  assert.deepEqual([arrived.change.agent_lines_before, arrived.agent_lines], [0, 1]);
  assert.deepEqual([arrived.change.lines_before, arrived.lines], [2, 2]);

  // More commits and more lines: the commits are the reason, ahead of anything else.
  assert.equal((await sent(1, { event: "synchronize", commits: 3, files: [file("a.ts", 1, 2, 3, 4)] })).status, 200);
  page = await detail(1);
  assert.equal(page.history[0].change.reason, "2 new commits");
  assert.deepEqual([page.history[0].change.commits_before, page.history[0].commits], [1, 3]);
  assert.deepEqual([page.history[0].change.lines_before, page.history[0].lines], [2, 4]);

  // A session deleted between reports is gone from the next one.
  await db.query(`DELETE FROM sessions WHERE session_id = 's-new' AND org_id = 'default'`);
  assert.equal((await sent(1, { event: "synchronize", commits: 3, files: [file("a.ts", 1, 2, 3, 4)] })).status, 200);
  page = await detail(1);
  assert.deepEqual(page.history[0].change.sessions_gone.map((s: { session_id: string; session: unknown }) => [s.session_id, s.session]), [["s-new", null]]);
  assert.equal(page.history[0].change.reason, "1 session no longer matched: -1 agent lines");

  // A newer Action that moves nothing else is its own row. The one before it keeps its version.
  assert.equal((await sent(2, {
    commits: 1, files: [file("b.ts", 10)], reporter: { name: "sessionly-action", version: "0.1.0" },
  })).status, 200);
  assert.equal((await sent(2, {
    event: "synchronize", commits: 1, files: [file("b.ts", 10)], reporter: { name: "sessionly-action", version: "0.2.0" },
  })).status, 200);
  page = await detail(2);
  assert.equal(page.history.length, 2);
  assert.equal(page.history[0].reporter_version, "0.2.0");
  assert.equal(page.history[0].change.reason, "Action 0.2.0, was 0.1.0");
  assert.deepEqual([page.history[0].lines, page.history[0].agent_lines], [1, 0]);
  assert.equal(page.history[1].reporter_version, "0.1.0");
  assert.equal(page.history[1].change.reason, null);
  // The same version again, with the same figures, adds nothing.
  assert.equal((await sent(2, {
    event: "synchronize", commits: 1, files: [file("b.ts", 10)], reporter: { name: "sessionly-action", version: "0.2.0" },
  })).status, 200);
  assert.equal((await detail(2)).history.length, 2);
  // The lines moved, and the version was already the current one: nothing new.
  assert.equal((await sent(2, {
    event: "synchronize", commits: 1, files: [file("b.ts", 10, 11)], reporter: { name: "sessionly-action", version: "0.2.0" },
  })).status, 200);
  page = await detail(2);
  assert.equal(page.history[0].change.reason, "matched again, nothing new");
  assert.equal(page.history[1].reporter_version, "0.2.0");
  // The lines moved with the version: that is the reason.
  assert.equal((await sent(2, {
    event: "synchronize", commits: 1, files: [file("b.ts", 10, 11, 12)], reporter: { name: "sessionly-action", version: "0.3.0" },
  })).status, 200);
  page = await detail(2);
  assert.equal(page.history[0].change.reason, "Action 0.3.0, was 0.2.0");
  assert.equal(page.history[0].reporter_version, "0.3.0");
  assert.equal(page.history[1].reporter_version, "0.2.0");

  // A session that arrives after the last report is a match, not a new report.
  assert.equal((await sent(3, { event: "closed", state: "merged", files: [file("c.ts", 20, 21)] })).status, 200);
  assert.equal((await upload("s-match", "c.ts", 20)).status, 200);
  const matched = await call(tokens.admin, "POST", "/prs/match", { repo, number: 3 });
  assert.equal(matched.status, 200);
  page = await detail(3);
  assert.equal(page.history.length, 2);
  assert.equal(page.history[0].event, "match");
  assert.deepEqual(page.history[0].change.sessions_added.map((s: { session_id: string }) => s.session_id), ["s-match"]);
  assert.equal(page.history[0].change.reason, "1 session uploaded since: +1 agent lines");
  assert.equal(page.history[1].event, "closed");

  // The 51st change drops the oldest row. Fifty are kept, the latest first.
  for (let i = 1; i <= 51; i++) {
    const lines = Array.from({ length: i }, (_, n) => 1000 + n);
    assert.equal((await sent(4, { commits: i, event: i === 1 ? "opened" : "synchronize", files: [file("d.ts", ...lines)] })).status, 200);
  }
  page = await detail(4);
  assert.equal(page.history.length, 50);
  assert.equal(page.history.some((row: { commits: number }) => row.commits === 1), false);
  assert.equal(page.history[0].commits, 51);
  assert.equal(page.history[49].commits, 2);
  assert.equal(page.history[0].change.reason, "1 new commit");

  // A session already matched, whose line count grew, says so.
  assert.equal((await sent(5, { files: [file("e.ts", 30, 31)] })).status, 200);
  assert.equal((await upload("s-grow", "e.ts", 30)).status, 200);
  // a report between the two uploads, or both would be told in one row of matching again
  assert.equal((await sent(5, { event: "synchronize", commits: 2, files: [file("e.ts", 30, 31)] })).status, 200);
  assert.equal((await upload("s-grow", "e.ts", 30, 31)).status, 200);
  assert.equal((await sent(5, { event: "synchronize", commits: 2, files: [file("e.ts", 30, 31)] })).status, 200);
  page = await detail(5);
  assert.equal(page.history[0].change.reason, "1 session's lines changed: +1 agent lines");
  assert.deepEqual(
    page.history[0].change.sessions_changed.map((s: { session_id: string; lines: number; lines_before: number }) => [s.session_id, s.lines_before, s.lines]),
    [["s-grow", 1, 2]],
  );
  assert.equal(page.history[0].change.sessions_added.length, 0);
  assert.equal(page.history[0].change.sessions_gone.length, 0);

  // A rebase that drops commits says so, when nothing else on the ladder moved.
  assert.equal((await sent(6, { commits: 4, files: [file("f.ts", 40)] })).status, 200);
  assert.equal((await sent(6, { event: "synchronize", commits: 2, files: [file("f.ts", 40)] })).status, 200);
  page = await detail(6);
  assert.equal(page.history[0].change.reason, "2 commits removed");
  assert.deepEqual([page.history[0].change.commits_before, page.history[0].commits], [4, 2]);
});

test("two reports of a new pull request at once keep one history row when the figures match", async () => {
  const repo = "github.com/acme/history-once";
  const detail = async (number: number) =>
    (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=${number}`)).body;
  const same = report({ repo, number: 1, files: [file("a.ts", 1, 2)] });
  const [a, b] = await Promise.all([call(tokens.ci, "PUT", "/prs", same), call(tokens.ci, "PUT", "/prs", same)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await detail(1)).history.length, 1);

  const [c, d] = await Promise.all([
    call(tokens.ci, "PUT", "/prs", report({ repo, number: 2, commits: 1, files: [file("b.ts", 1)] })),
    call(tokens.ci, "PUT", "/prs", report({ repo, number: 2, commits: 2, event: "synchronize", files: [file("b.ts", 1, 2)] })),
  ]);
  assert.equal(c.status, 200);
  assert.equal(d.status, 200);
  const both = await detail(2);
  assert.deepEqual(both.history.map((row: { commits: number }) => row.commits).sort((x: number, y: number) => x - y), [1, 2]);
});

test("another organisation's history is not visible", async () => {
  await newOrg(db, "org-hist", "History");
  const ci = await tokenFor(db, { email: "ci@hist.example", role: "ci" }, "org-hist");
  const admin = await tokenFor(db, { email: "boss@hist.example", role: "admin" }, "org-hist");
  const repo = "github.com/hist/app";
  assert.equal((await call(ci, "PUT", "/prs", report({ repo, number: 1, files: [file("a.ts", 1)] }))).status, 200);
  const theirs = await call(admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.history.length, 1);

  // The default organisation is told nothing of it, by the API or by a query with no filter.
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).status, 404);
  await db.asOrg("default", async (scoped) => {
    const rows = await scoped.query<{ repo: string }>(`SELECT repo FROM pull_request_reports`);
    assert.equal(rows.some((row) => row.repo === repo), false);
    assert.ok(rows.length > 0);
  });
  // Writing a row into the other organisation is refused.
  await assert.rejects(
    db.asOrg("default", (scoped) =>
      scoped.query(
        `INSERT INTO pull_request_reports (org_id, repo, number, event, commits, lines, agent_lines, sessions)
         VALUES ('org-hist', $1, 1, 'manual', 1, 1, 0, '[]')`,
        [repo],
      ),
    ),
    /row-level security/,
  );
  // And that organisation sees its own, and only its own.
  const [seen] = await db.asOrg("org-hist", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_request_reports`));
  const [all] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_request_reports WHERE org_id = 'org-hist'`);
  const [others] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pull_request_reports WHERE org_id <> 'org-hist'`);
  assert.equal(Number(seen?.n), Number(all?.n));
  assert.equal(Number(seen?.n), 1);
  assert.ok(Number(others?.n) > 0);
});

test("what was spent on a pull request: its sessions' cost, split by the lines each contributed to it", async () => {
  const repo = "github.com/acme/cost";
  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
  const upload = (id: string, path: string, numbers: number[], cost: unknown, remote = repo) => {
    const s = session(id, "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [{ path, model: null, hashes: numbers.map(h) }]);
    s.session.repo.remote = remote;
    if (cost) (s.session as Record<string, unknown>).cost = cost;
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  const detail = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=${number}`)).body;
  const none = { sessions_without_cost: 0, sessions_with_cost_partial: 0, sessions_unshared: 0, sessions_unshared_for_good: 0, sessions_uncounted: 0 };

  // one session of a hundred lines: forty went into one pull request, ten into another, fifty into neither.
  // All of what it cost is theirs, four to one: the fifty that got nowhere were paid for on the way to these
  assert.equal((await upload("c-wide", "c.ts", range(1000, 100), { total_usd: 10, source: "recorded" })).status, 200);
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 1, files: [file("c.ts", ...range(1000, 40), 5000)] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 2, event: "synchronize", files: [file("c.ts", ...range(1040, 10))] }));
  const a = await detail(1);
  assert.deepEqual(a.cost, { usd: 8, estimated: false, sessions: 1, ...none, per_agent_line_usd: 0.2, opened_usd: 8, opened_is_floor: false, opened_estimated: false, opened_surviving_lines: 40, per_surviving_line_usd: 0.2, per_surviving_line_is_floor: false });
  assert.deepEqual(
    [a.sessions[0].lines, a.sessions[0].contributed_lines, a.sessions[0].hashed_lines, a.sessions[0].cost_share_usd, a.sessions[0].session.cost_usd],
    [40, 40, 100, 8, 10],
  );
  // not seen from the start: what a line that survived cost is not known, what one that is there cost is
  const b = await detail(2);
  assert.deepEqual([b.cost.usd, b.cost.opened_usd, b.cost.per_agent_line_usd, b.cost.per_surviving_line_usd], [2, null, 0.2, null]);
  // review takes half of them out: what was spent on it was spent, and the lines that are left cost twice as much each
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 1, event: "closed", state: "merged", files: [file("c.ts", ...range(1000, 20), 5000)] }));
  const reviewed = await detail(1);
  assert.deepEqual(reviewed.cost, { usd: 8, estimated: false, sessions: 1, ...none, per_agent_line_usd: 0.4, opened_usd: 8, opened_is_floor: false, opened_estimated: false, opened_surviving_lines: 20, per_surviving_line_usd: 0.4, per_surviving_line_is_floor: false });
  assert.deepEqual([reviewed.sessions[0].lines, reviewed.sessions[0].contributed_lines, reviewed.sessions[0].cost_share_usd], [20, 40, 8]);
  // and the other pull request's share is what it was
  assert.equal((await detail(2)).cost.usd, 2);

  // all of a session's lines in one pull request: its cost is the pull request's, estimated as it is
  await upload("c-whole", "d.ts", range(2000, 5), { total_usd: 2, source: "estimated" });
  // a session with no cost figure, and one taken back since: the cost is the others', and is said to be a floor
  await upload("c-none", "e.ts", range(3000, 3), null);
  await upload("c-gone", "f.ts", range(4000, 2), { total_usd: 50, source: "recorded" });
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 3, files: [file("d.ts", ...range(2000, 5)), file("e.ts", ...range(3000, 3)), file("f.ts", ...range(4000, 2))] }));
  assert.equal((await detail(3)).cost.usd, 52);
  assert.equal((await call(tokens.ann, "DELETE", "/sessions/m1/claude-code/c-gone")).status, 200);
  const c = await detail(3);
  // what a line cost is said of the lines that have a cost: five of the ten, and so is what one that
  // survived cost, which is then no floor. What it was opened with cost is what is known of it, and is
  assert.deepEqual(c.cost, { usd: 2, estimated: true, sessions: 3, ...none, sessions_without_cost: 2, per_agent_line_usd: 0.4, opened_usd: 2, opened_is_floor: true, opened_estimated: true, opened_surviving_lines: 10, per_surviving_line_usd: 0.4, per_surviving_line_is_floor: false });
  // the lines of the one taken back are not kept past it, nor is what it was charged; that it had two is
  const kept = await db.query(`SELECT session_id, lines, matched IS NULL AND contributed IS NULL AS forgotten, charged_usd FROM pull_sessions WHERE repo = $1 AND number = 3 ORDER BY session_id`, [repo]);
  assert.deepEqual(kept.map((row) => [row.session_id, Number(row.lines), row.forgotten, row.charged_usd]), [["c-gone", 2, true, null], ["c-none", 3, false, null], ["c-whole", 5, false, 2]]);
  const shares = Object.fromEntries(c.sessions.map((s: any) => [s.session_id, [s.hashed_lines, s.cost_share_usd]]));
  assert.deepEqual(shares, { "c-whole": [5, 2], "c-none": [3, null], "c-gone": [null, null] });

  // one with no session at all has no cost, which is not a cost of nothing
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 4, files: [file("g.ts", 6000)] }));
  assert.deepEqual((await detail(4)).cost, { usd: null, estimated: false, sessions: 0, ...none, per_agent_line_usd: null, opened_usd: null, opened_is_floor: false, opened_estimated: false, opened_surviving_lines: null, per_surviving_line_usd: null, per_surviving_line_is_floor: false });

  // the list says the same of each as its page, and the summary is their sum
  const list = (await call(tokens.admin, "GET", "/prs?repo=acme/cost")).body.pulls;
  for (const row of list) assert.deepEqual(row.cost, (await detail(row.number)).cost, `#${row.number}`);
  const total = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost")).body.total;
  assert.deepEqual(
    [total.cost_usd, total.cost_estimated, total.pulls_with_cost_missing],
    [list.reduce((sum: number, row: any) => sum + (row.cost.usd ?? 0), 0), true, 1],
  );
  assert.equal(total.cost_usd, 12);
  // of those seen from the start: the eight dollars #1 was opened for and the two known of #3's, for the 30
  // lines that survived, of which 25 are of a session with a cost: #3's five with one. Those without a cost
  // are left out of both sides, so it is no floor: none of the sessions with a cost leaves requests out.
  // What the summary says a surviving line cost is those costs over those lines, as each page has them
  assert.deepEqual([total.agent_lines_surviving, total.agent_lines_surviving_once], [30, 25]);
  assert.deepEqual([total.per_surviving_line_usd, total.per_surviving_line_is_floor, total.per_surviving_line_estimated], [0.4, false, true]);
  assert.equal(total.per_surviving_line_usd, (reviewed.cost.opened_usd + c.cost.opened_usd) / total.agent_lines_surviving_once);

  // the same lines in two pull requests (one stacked on the other): the session is split, not counted twice
  await upload("c-twice", "h.ts", range(7000, 10), { total_usd: 6, source: "recorded" });
  for (const number of [5, 6]) await call(tokens.ci, "PUT", "/prs", report({ repo, number, files: [file("h.ts", ...range(7000, 10))] }));
  // each has half of each line, three dollars for five lines' worth: a line cost sixty cents, in either.
  // Both were opened with them, and all of them survived: the same of those
  for (const number of [5, 6]) {
    const twice = await detail(number);
    assert.deepEqual(
      [twice.cost.usd, twice.cost.per_agent_line_usd, twice.sessions[0].cost_share_usd, twice.cost.opened_usd, twice.cost.per_surviving_line_usd],
      [3, 0.6, 3, 3, 0.6],
      `#${number}`,
    );
  }
  assert.equal((await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost")).body.total.cost_usd, 18);
  // a push that takes them out of one moves nothing: it was opened with them, and is charged as it was
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 6, event: "synchronize", files: [file("h.ts", 7999)] }));
  assert.deepEqual([(await detail(5)).cost.usd, (await detail(6)).cost.usd, (await detail(6)).cost.per_surviving_line_usd], [3, 3, null]);

  // a session stored again with another cost: its pull requests are charged again, as they were split
  assert.equal((await upload("c-wide", "c.ts", [], { total_usd: 9, source: "recorded" })).status, 200);
  assert.deepEqual([(await detail(1)).cost.usd, (await detail(2)).cost.usd], [7.2, 1.8]);
  assert.equal((await detail(1)).sessions[0].hashed_lines, 0);

  // ten of a session's thirty lines, the same ten in two pull requests: half of all it cost in each
  await upload("c-part", "i.ts", range(8000, 30), { total_usd: 30, source: "recorded" });
  for (const number of [7, 8]) await call(tokens.ci, "PUT", "/prs", report({ repo, number, files: [file("i.ts", ...range(8000, 10))] }));
  assert.deepEqual([(await detail(7)).cost.usd, (await detail(8)).cost.usd], [15, 15]);
  // a third that is closed without merging takes its share as they do: its money did not get merged
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 9, event: "closed", state: "closed", files: [file("i.ts", ...range(8000, 10))] }));
  assert.deepEqual([(await detail(7)).cost.usd, (await detail(8)).cost.usd, (await detail(9)).cost.usd], [10, 10, 10]);
  // and one of the two closing so moves no charge
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 8, event: "closed", state: "closed", files: [file("i.ts", ...range(8000, 10))] }));
  assert.deepEqual([(await detail(7)).cost.usd, (await detail(8)).cost.usd, (await detail(9)).cost.usd], [10, 10, 10]);

  // the total leaves out the ones closed without merging; asked for alone, they are summed
  const all = (await call(tokens.admin, "GET", "/prs?repo=acme/cost&limit=500")).body.pulls;
  const sum = (rows: any[]) => Math.round(rows.reduce((n: number, row: any) => n + (row.cost?.usd ?? 0), 0) * 1e6) / 1e6;
  assert.deepEqual(all.filter((row: any) => row.state === "closed").map((row: any) => row.number).sort(), [8, 9]);
  assert.equal((await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost")).body.total.cost_usd, sum(all.filter((row: any) => row.state !== "closed")));
  assert.equal((await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost&state=closed")).body.total.cost_usd, sum(all.filter((row: any) => row.state === "closed")));
  assert.equal((await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost&state=closed")).body.total.cost_usd, 20);

  // the summary says how many closed unmerged ones with a cost it leaves out
  const leftOut = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost")).body.total.pulls_closed_with_cost;
  assert.equal(leftOut, 2);

  // a cost that leaves requests out is a floor, and the summary counts its pull request as one
  const before = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost")).body.total.pulls_with_cost_missing;
  await upload("c-partial", "j.ts", range(9000, 4), { total_usd: 1, source: "partial_estimate", unpriced_requests: 3 });
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 10, files: [file("j.ts", ...range(9000, 4))] }));
  const partial = (await detail(10)).cost;
  assert.deepEqual([partial.usd, partial.estimated, partial.sessions_without_cost, partial.sessions_with_cost_partial], [1, true, 0, 1]);
  assert.equal((await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost")).body.total.pulls_with_cost_missing, before + 1);

  // a session that only pushed review fixes is in what was spent, and not in what the first version cost
  await upload("c-lost", "k.ts", range(9500, 4), { total_usd: 4, source: "recorded" }, `${repo}-2`);
  await upload("c-kept", "l.ts", range(9600, 4), { total_usd: 4, source: "recorded" }, `${repo}-2`);
  await call(tokens.ci, "PUT", "/prs", report({ repo: `${repo}-2`, number: 1, files: [file("k.ts", ...range(9500, 4))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: `${repo}-2`, number: 1, event: "synchronize", files: [file("k.ts", 9500), file("l.ts", ...range(9600, 4))] }));
  const lost = (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}-2&number=1`)).body.cost;
  // eight dollars for the five agent lines it has now; opened for four, with four lines of which one is left
  assert.deepEqual([lost.usd, lost.per_agent_line_usd, lost.opened_usd, lost.per_surviving_line_usd], [8, 1.6, 4, 4]);
  await call(tokens.ci, "PUT", "/prs", report({ repo: `${repo}-2`, number: 1, event: "synchronize", files: [file("l.ts", ...range(9600, 4))] }));
  const gone = (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}-2&number=1`)).body.cost;
  // every line it was opened with went in review: the four dollars were spent, and no line survived to divide them by
  assert.deepEqual([gone.usd, gone.opened_usd, gone.opened_surviving_lines, gone.per_surviving_line_usd], [8, 4, 0, null]);
  // and when review leaves no agent line at all, both sessions are still charged, and still on its page
  await call(tokens.ci, "PUT", "/prs", report({ repo: `${repo}-2`, number: 1, event: "synchronize", files: [file("z.ts", 1)] }));
  const bare = (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}-2&number=1`)).body;
  assert.deepEqual([bare.cost.usd, bare.cost.sessions, bare.cost.opened_usd, bare.cost.per_agent_line_usd], [8, 2, 4, null]);
  assert.deepEqual(
    bare.sessions.map((s: any) => [s.session_id, s.lines, s.contributed_lines, s.cost_share_usd]),
    [["c-kept", 0, 4, 4], ["c-lost", 0, 4, 4]],
  );
  // its history names the sessions with lines in it, as it did
  assert.deepEqual(bare.history[0].sessions, []);
  await upload("c-fine", "m.ts", range(9700, 4), { total_usd: 2, source: "recorded" }, `${repo}-2`);
  await call(tokens.ci, "PUT", "/prs", report({ repo: `${repo}-2`, number: 2, files: [file("m.ts", ...range(9700, 4))] }));
  // four dollars of lines that are gone and two of lines that stayed, for the four that stayed
  assert.equal((await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost-2")).body.total.per_surviving_line_usd, 1.5);

  // lines that moved from one pull request to another were opened in both, and are paid for once
  const moved = `${repo}-3`;
  await upload("c-moved", "n.ts", range(9800, 10), { total_usd: 10, source: "recorded" }, moved);
  await call(tokens.ci, "PUT", "/prs", report({ repo: moved, number: 1, files: [file("n.ts", ...range(9800, 10))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: moved, number: 1, event: "synchronize", files: [file("z.ts", 1)] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: moved, number: 2, files: [file("n.ts", ...range(9800, 10))] }));
  const opened = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${moved}&number=${number}`)).body.cost.opened_usd;
  assert.deepEqual([await opened(1), await opened(2)], [5, 5]);
  // the ten that survived in the second cost a dollar each, as they did, though it paid for half of them
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${moved}&number=2`)).body.cost.per_surviving_line_usd, 1);
  // between them, ten dollars for the ten lines that survived, though in the second only
  const movedTotal = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost-3")).body.total;
  assert.deepEqual([movedTotal.cost_usd, movedTotal.per_surviving_line_usd, movedTotal.agent_lines_surviving_once], [10, 1, 10]);

  // one not seen from the start (a release of what was merged) is charged its share all the same: half of
  // each line was paid for in the one opened with them, and survives there as half a line
  const released = `${repo}-4`;
  await upload("c-released", "o.ts", range(9900, 10), { total_usd: 10, source: "recorded" }, released);
  await call(tokens.ci, "PUT", "/prs", report({ repo: released, number: 1, files: [file("o.ts", ...range(9900, 10))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: released, number: 2, event: "synchronize", files: [file("o.ts", ...range(9900, 10))] }));
  const of = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${released}&number=${number}`)).body.cost;
  assert.deepEqual([(await of(1)).usd, (await of(1)).opened_usd, (await of(1)).per_surviving_line_usd], [5, 5, 1]);
  assert.deepEqual([(await of(2)).usd, (await of(2)).opened_usd], [5, null]);
  const releasedTotal = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/cost-4")).body.total;
  assert.deepEqual([releasedTotal.cost_usd, releasedTotal.per_surviving_line_usd, releasedTotal.agent_lines_surviving_once], [10, 1, 5]);

  // a session taken back and sent again: the pull request from before is matched again as it arrives, so which of
  // its lines it has is known once more, and a new one with the same lines shares them with it for sure
  await upload("c-gone", "f.ts", range(4000, 2), { total_usd: 50, source: "recorded" });
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 11, files: [file("f.ts", ...range(4000, 2))] }));
  const three = (await detail(3)).cost;
  assert.deepEqual([three.usd, three.sessions_unshared, three.sessions_unshared_for_good], [27, 0, 0]);
  const eleven = await detail(11);
  assert.deepEqual([eleven.cost.usd, eleven.cost.estimated, eleven.cost.sessions_unshared], [25, false, 0]);
  assert.deepEqual([eleven.cost.opened_usd, eleven.cost.opened_estimated], [25, false]);
  assert.deepEqual([eleven.sessions[0].cost_share_usd, eleven.sessions[0].unshared, eleven.sessions[0].uncounted], [25, false, false]);
});

test("a line opened in two pull requests survives once between them, wherever it ended up", async () => {
  const repo = "github.com/acme/halves";
  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
  const upload = (id: string, path: string, numbers: number[], usd: number, remote = repo) => {
    const s = session(id, "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [{ path, model: null, hashes: numbers.map(h) }]);
    s.session.repo.remote = remote;
    (s.session as Record<string, unknown>).cost = { total_usd: usd, source: "recorded" };
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  const cost = async (number: number, remote = repo) => (await call(tokens.admin, "GET", `/prs/detail?repo=${remote}&number=${number}`)).body.cost;
  const summary = async (query: string) => (await call(tokens.admin, "GET", `/prs/summary?${query}`)).body.total;

  // ten lines for six dollars, both pull requests opened with all of them: three dollars and five lines' worth in each
  assert.equal((await upload("c-halves", "a.ts", range(100, 10), 6)).status, 200);
  for (const number of [1, 2]) await call(tokens.ci, "PUT", "/prs", report({ repo, number, files: [file("a.ts", ...range(100, 10))] }));
  // review leaves four in the first, merged; the second keeps all ten. Each line is half a line in
  // each, and survives in the second: the session paid six dollars for ten lines that survived
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 1, event: "closed", state: "merged", files: [file("a.ts", ...range(100, 4))] }));
  const one = await cost(1);
  assert.deepEqual([one.opened_usd, one.per_surviving_line_usd], [3, 0.6]);
  // the summary of it alone says the same: its half of the ten
  const merged = await summary("repo=acme/halves&state=merged");
  assert.deepEqual([merged.per_surviving_line_usd, merged.agent_lines_surviving, merged.agent_lines_surviving_once], [0.6, 4, 5]);

  // of both: each line once between them
  const two = await cost(2);
  assert.deepEqual([two.opened_usd, two.per_surviving_line_usd], [3, 0.6]);
  const both = await summary("repo=acme/halves");
  assert.deepEqual([both.agent_lines_surviving, both.agent_lines_surviving_once, both.per_surviving_line_usd], [14, 10, 0.6]);

  // a pull request with lines of its own: whole lines, the same on its page and in the summary
  const solo = `${repo}-solo`;
  await upload("c-solo", "b.ts", range(200, 8), 4, solo);
  await call(tokens.ci, "PUT", "/prs", report({ repo: solo, number: 1, files: [file("b.ts", ...range(200, 8))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: solo, number: 1, event: "synchronize", files: [file("b.ts", ...range(200, 5))] }));
  const own = await cost(1, solo);
  assert.deepEqual([own.opened_usd, own.per_surviving_line_usd], [4, 0.8]);
  const whole = await summary("repo=acme/halves-solo");
  assert.deepEqual([whole.per_surviving_line_usd, whole.agent_lines_surviving, whole.agent_lines_surviving_once], [0.8, 5, 5]);

  // kept before which lines survived was: as many of its lines as of all of them survived there, until weighed again
  await db.query(`UPDATE pull_sessions SET opened_kept = NULL WHERE repo = $1`, [repo]);
  assert.equal((await cost(1)).per_surviving_line_usd, 1.5);
  // which the server does once, as it starts, a batch at a time, and matching again does too
  const weighAll = async (atOnce?: number) => {
    let batches = 0;
    let after: SessionAt | null = null;
    while ((after = await db.asOrg(DEFAULT_ORG, (tx) => weighKeptSome(tx, after, atOnce)))) batches += 1;
    return batches;
  };
  assert.equal(await weighAll(), 1);
  assert.equal(await weighAll(), 0);
  assert.deepEqual([(await cost(1)).per_surviving_line_usd, (await cost(2)).per_surviving_line_usd], [0.6, 0.6]);
  await db.query(`UPDATE pull_sessions SET opened_kept = NULL WHERE repo = $1 AND number = 2`, [repo]);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 2 })).status, 200);
  const [weighed] = await db.query(`SELECT opened_kept FROM pull_sessions WHERE repo = $1 AND number = 2`, [repo]);
  assert.equal(Number(weighed!.opened_kept), 5);

  // a pull request not seen from the start (a release of what was merged) keeps lines that went in
  // review elsewhere: they did not survive there, and it is never weighed for it
  const release = `${repo}-release`;
  await upload("c-release", "r.ts", range(300, 4), 4, release);
  await call(tokens.ci, "PUT", "/prs", report({ repo: release, number: 1, files: [file("r.ts", ...range(300, 4))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: release, number: 1, event: "synchronize", files: [file("r.ts", ...range(300, 2))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: release, number: 2, event: "synchronize", files: [file("r.ts", ...range(300, 4))] }));
  assert.equal((await cost(1, release)).per_surviving_line_usd, 2);
  const unweighed = await db.query(`SELECT number FROM pull_sessions WHERE repo = $1 AND opened_kept IS NULL`, [release]);
  assert.deepEqual(unweighed.map((row) => Number(row.number)), [2]);
  assert.equal(await weighAll(), 0);

  // opened by one with a cost and one without, review keeps only the second's: what survived is not said
  // to be nothing, and no cost per surviving line is made up of the other's lines
  const mixed = `${repo}-mixed`;
  await upload("c-paid", "p.ts", range(400, 5), 5, mixed);
  const free = session("c-free", "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [{ path: "q.ts", model: null, hashes: range(500, 5).map(h) }]);
  free.session.repo.remote = mixed;
  await call(tokens.ann, "PUT", "/sessions/m1/claude-code/c-free", free);
  await call(tokens.ci, "PUT", "/prs", report({ repo: mixed, number: 1, files: [file("p.ts", ...range(400, 5)), file("q.ts", ...range(500, 5))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: mixed, number: 1, event: "synchronize", files: [file("q.ts", ...range(500, 5))] }));
  const paid = await cost(1, mixed);
  assert.deepEqual([paid.opened_usd, paid.opened_is_floor, paid.opened_surviving_lines, paid.per_surviving_line_usd], [5, true, 5, null]);

  // two with a cost, one kept before which of its lines survived was: of the lines that survived, those of the
  // other one are not taken to be its. The other's four survived and its own none: eight dollars for four lines
  await upload("c-old", "c.ts", range(600, 4), 4, mixed);
  await upload("c-new", "d.ts", range(700, 4), 4, mixed);
  await call(tokens.ci, "PUT", "/prs", report({ repo: mixed, number: 2, files: [file("c.ts", ...range(600, 4)), file("d.ts", ...range(700, 4))] }));
  await call(tokens.ci, "PUT", "/prs", report({ repo: mixed, number: 2, event: "synchronize", files: [file("d.ts", ...range(700, 4))] }));
  assert.equal((await cost(2, mixed)).per_surviving_line_usd, 2);
  await db.query(`UPDATE pull_sessions SET opened_kept = NULL, opened_here = NULL WHERE session_id = 'c-old'`);
  assert.equal((await cost(2, mixed)).per_surviving_line_usd, 2);

  // one that weighing leaves as it was does not keep the ones after it from being weighed, nor is met again
  await db.query(`UPDATE pull_sessions SET opened_kept = NULL, opened_lines = NULL WHERE session_id = 'c-halves'`);
  await db.query(`UPDATE pull_sessions SET opened_kept = NULL WHERE session_id = 'c-solo'`);
  await weighAll(1);
  const after = await db.query(`SELECT session_id, opened_kept FROM pull_sessions WHERE session_id IN ('c-old', 'c-solo') ORDER BY session_id`);
  assert.deepEqual(after.map((row) => [row.session_id, Number(row.opened_kept)]), [["c-old", 0], ["c-solo", 5]]);
});

test("a session's cost is split between the pull requests it has lines in by what it contributed to each", () => {
  const lines = (path: string, ...numbers: number[]) => ({ [path]: numbers.map(h) });
  const row = (head_ref: string | null, contributed: Record<string, string[]> | null, count = 0, base_ref: string | null = null) => ({
    head_ref,
    base_ref,
    lines: contributed ? Object.values(contributed).flat().length : count,
    contributed,
  });
  const usd = (charged: (number | null)[]) => charged.map((one) => one && Math.round(one * 1e6) / 1e6);
  const whole = { cost_usd: 10, by_branch: null };
  // no cost figure, or no session: nothing is said
  assert.deepEqual(charge(null, [row(null, lines("a.ts", 1))]), [null]);
  assert.deepEqual(charge({ ...whole, cost_usd: null }, [row(null, lines("a.ts", 1))]), [null]);
  // all of it to the one it contributed to, however few lines; six lines and four: six dollars and four
  assert.deepEqual(usd(charge(whole, [row("feat", lines("a.ts", 1))])), [10]);
  assert.deepEqual(usd(charge(whole, [row("a", lines("a.ts", 1, 2, 3, 4, 5, 6)), row("b", lines("b.ts", 7, 8, 9, 10))])), [6, 4]);
  // the same lines in two are half a line in each; one whose lines were not kept counts as many as it had
  assert.deepEqual(usd(charge(whole, [row("a", lines("a.ts", 1, 2)), row("b", lines("a.ts", 1, 2))])), [5, 5]);
  assert.deepEqual(usd(charge(whole, [row("a", null, 3), row("b", lines("a.ts", 1))])), [7.5, 2.5]);
  // its turns name their branches: what was spent on each is its pull requests', and what was spent
  // on the branch they are based on, before theirs was made, is theirs too; the rest is no one's
  const turns = { cost_usd: 10, by_branch: [{ branch: "feat", usd: 6 }, { branch: "main", usd: 3 }, { branch: null, usd: 1 }] };
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1)), row("main", lines("b.ts", 2), 0, "release")])), [6, 3]);
  // one with its lines and nothing spent on its branch nor its base (renamed before it was pushed):
  // the names are what is off, and all it cost is shared out by lines, as of one that names none
  assert.deepEqual(usd(charge(turns, [row("renamed", lines("a.ts", 1), 0, "develop")])), [10]);
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1, 2, 3)), row("renamed", lines("b.ts", 4, 5), 0, "develop")])), [6, 4]);
  // a report that does not say what it is based on is taken to be based on main
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1))])), [9]);
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1), 0, "develop")])), [6]);
  // two that are based on it share what was spent there by their lines, three to one,
  // and each has what was spent on its own branch
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1, 2, 3), 0, "main"), row("other", lines("b.ts", 4), 0, "main")])), [8.25, 0.75]);
  // two on the one branch share what was spent on it; a branch that is a pull request's own
  // is not also the base of the ones stacked on it
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1, 2, 3), 0, "main"), row("feat", lines("b.ts", 4), 0, "main"), row("main", lines("c.ts", 5), 0, "release")])), [4.5, 1.5, 3]);
  // never more than it cost, whatever the turns add up to, or with one that names no branch beside them
  assert.deepEqual(usd(charge({ ...turns, cost_usd: 4 }, [row("feat", lines("a.ts", 1), 0, "develop")])), [4]);
  assert.deepEqual(usd(charge(turns, [row("feat", lines("a.ts", 1)), row(null, lines("b.ts", 2), 0, "develop")])), [5, 5]);
  // turns that name no branch say no more than the session does
  assert.deepEqual(usd(charge({ cost_usd: 10, by_branch: [{ branch: null, usd: 10 }] }, [row("feat", lines("a.ts", 1))])), [10]);
  // lines together: each as often as the one that has it most
  assert.deepEqual(unionLines({ "a.ts": [h(1), h(1), h(2)] }, { "a.ts": [h(1), h(3)], "constructor": [h(4)] }), { "a.ts": [h(1), h(1), h(2), h(3)], "constructor": [h(4)] });
  assert.deepEqual(unionLines(null, { "a.ts": [h(1)] }), { "a.ts": [h(1)] });
  assert.equal(unionLines(null, null), null);
});

test("what was spent getting a pull request merged stays spent, and every dollar is in one of three places", async () => {
  const repo = "github.com/acme/spent";
  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
  const put = (id: string, usd: number | null, files: Record<string, number[]>, more: { source?: string; branch?: string; by_branch?: unknown; started?: string } = {}) => {
    const source = more.source ?? "claude-code";
    const s = session(id, source, "claude-opus-5-5", more.started ?? "2026-11-10T09:00:00Z", Object.entries(files).map(([path, numbers]) => ({ path, model: null, hashes: numbers.map(h) })));
    Object.assign(s.session.repo, { remote: repo, ...(more.branch ? { branch: more.branch } : {}) });
    if (usd != null) (s.session as Record<string, unknown>).cost = { total_usd: usd, source: "recorded", ...(more.by_branch ? { by_branch: more.by_branch } : {}) };
    return call(tokens.ann, "PUT", `/sessions/m1/${source}/${id}`, s);
  };
  const sent = (number: number, files: unknown[], more: Record<string, unknown> = {}) => call(tokens.ci, "PUT", "/prs", report({ repo, number, files, ...more }));
  const pull = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=${number}`)).body;
  const cost = async (number: number) => (await pull(number)).cost;
  const spent = async (by = "tool") => (await call(tokens.admin, "GET", `/summary?by=${by}&repo=acme/spent`)).body;
  const cents = (usd: number) => Math.round(usd * 100);
  const addsUp = (t: any, where: string) =>
    assert.equal(cents(t.in_pr_usd + t.closed_unmerged_usd + t.not_in_pr_usd), cents(t.cost_usd), `${where}: ${JSON.stringify([t.in_pr_usd, t.closed_unmerged_usd, t.not_in_pr_usd, t.cost_usd])}`);

  // a ten dollar session feeds one pull request, and review takes every line of it out
  assert.equal((await put("sp-all", 10, { "a.ts": range(100, 10) }, { branch: "feat-a" })).status, 200);
  await sent(1, [file("a.ts", ...range(100, 10))], { head_ref: "feat-a" });
  assert.deepEqual([(await cost(1)).usd, (await cost(1)).opened_usd, (await cost(1)).per_surviving_line_usd], [10, 10, 1]);
  await sent(1, [file("a.ts", 9999)], { head_ref: "feat-a", event: "synchronize" });
  const all = await cost(1);
  assert.deepEqual([all.usd, all.opened_usd, all.opened_surviving_lines, all.per_surviving_line_usd, all.per_agent_line_usd], [10, 10, 0, null, null]);

  // a session that only pushed review fixes is in what was spent, and not in what the first version cost
  await put("sp-open", 6, { "b.ts": range(200, 5) });
  await sent(2, [file("b.ts", ...range(200, 5))]);
  await put("sp-fix", 3, { "c.ts": range(300, 2) }, { started: "2026-11-10T13:00:00Z" });
  await sent(2, [file("b.ts", ...range(200, 5)), file("c.ts", ...range(300, 2))], { event: "synchronize" });
  assert.deepEqual([(await cost(2)).usd, (await cost(2)).opened_usd, (await cost(2)).sessions], [9, 6, 2]);
  // and stays in it when a later push takes its fixes out again: they are in no report any more
  await sent(2, [file("b.ts", ...range(200, 4))], { event: "synchronize" });
  const fixed = await pull(2);
  assert.deepEqual([fixed.cost.usd, fixed.cost.opened_usd, fixed.cost.per_surviving_line_usd], [9, 6, 1.5]);
  assert.deepEqual(fixed.sessions.map((s: any) => [s.session_id, s.lines, s.contributed_lines, s.cost_share_usd]), [["sp-open", 4, 5, 6], ["sp-fix", 0, 2, 3]]);

  // six lines in one pull request and four in another: six dollars and four, whatever review does after
  await put("sp-split", 10, { "d.ts": range(400, 6), "e.ts": range(500, 4) });
  await sent(3, [file("d.ts", ...range(400, 6))]);
  await sent(4, [file("e.ts", ...range(500, 4))]);
  assert.deepEqual([(await cost(3)).usd, (await cost(4)).usd], [6, 4]);
  await sent(3, [file("d.ts", ...range(400, 2))], { event: "synchronize", state: "merged" });
  await sent(4, [file("e.ts", 500, 9998)], { event: "synchronize" });
  assert.deepEqual([(await cost(3)).usd, (await cost(4)).usd, (await cost(3)).opened_usd, (await cost(3)).per_surviving_line_usd], [6, 4, 6, 3]);

  // Claude Code says which branch each turn ran on: what was spent on the pull request's counts, and
  // what was spent on main before the branch was made, and not what was spent on another
  await put("sp-turns", 10, { "f.ts": range(600, 3) }, { branch: "main", by_branch: [{ branch: "feat-f", usd: 6 }, { branch: "main", usd: 3 }, { branch: "spike", usd: 1 }] });
  await sent(5, [file("f.ts", ...range(600, 3))], { head_ref: "feat-f", base_ref: "main" });
  const five = await pull(5);
  assert.deepEqual([five.cost.usd, five.cost.opened_usd, five.sessions[0].cost_share_usd], [9, 9, 9]);
  // one whose lines are in a pull request on a branch it spent nothing on, nor on its base (renamed
  // before it was pushed): the lines say it is its work, and it pays whole
  await put("sp-renamed", 3, { "g.ts": range(700, 2) }, { branch: "wip", by_branch: [{ branch: "wip", usd: 3 }] });
  await sent(6, [file("g.ts", ...range(700, 2))], { head_ref: "feat-g", base_ref: "develop" });
  const six = await pull(6);
  assert.deepEqual([six.cost.usd, six.cost.sessions, six.cost.sessions_without_cost, six.sessions[0].cost_share_usd], [3, 1, 0, 3]);

  // Codex names one branch for a session: all of it is charged where its lines are, though two of its
  // ten lines are there and the rest was other work, and so is one that began on main
  await put("sp-codex", 5, { "h.ts": range(800, 10) }, { source: "codex", branch: "feat-h" });
  await put("sp-main", 1.25, { "i.ts": range(900, 2) }, { source: "codex", branch: "main" });
  await sent(7, [file("h.ts", 800, 801), file("i.ts", ...range(900, 2))], { head_ref: "feat-h" });
  const seven = await pull(7);
  assert.deepEqual([seven.cost.usd, seven.cost.sessions], [6.25, 2]);
  assert.deepEqual(
    seven.sessions.map((s: any) => [s.session_id, s.cost_share_usd]).sort(),
    [["sp-codex", 5], ["sp-main", 1.25]],
  );

  // one closed without merging, one session that reached no pull request, and one whose lines
  // turned out to be a later session's: it is in no pull request once that one is uploaded
  await put("sp-closed", 2.57, { "j.ts": range(1000, 3) });
  await sent(8, [file("j.ts", ...range(1000, 3))], { state: "closed", event: "closed" });
  await put("sp-none", 1.11, { "k.ts": range(1100, 3) });
  await put("sp-early", 4, { "l.ts": range(1200, 2) }, { started: "2026-11-10T08:00:00Z" });
  await sent(9, [file("l.ts", ...range(1200, 2))]);
  assert.equal((await cost(9)).usd, 4);
  await put("sp-late", 2.03, { "l.ts": range(1200, 2) }, { started: "2026-11-10T10:00:00Z" });
  const nine = await pull(9);
  assert.deepEqual([nine.cost.usd, nine.sessions.map((s: any) => s.session_id)], [2.03, ["sp-late"]]);

  // merged or open, closed unmerged, and in no pull request: between them, all that was spent
  const { total, groups } = await spent();
  assert.deepEqual(
    [total.in_pr_usd, total.closed_unmerged_usd, total.not_in_pr_usd, total.cost_usd],
    // sp-all, sp-open and sp-fix, sp-split, nine of sp-turns, sp-renamed, sp-codex and sp-main, sp-late; sp-closed; the rest of sp-turns, sp-none, sp-early
    [10 + 9 + 10 + 9 + 3 + 5 + 1.25 + 2.03, 2.57, 1 + 1.11 + 4, 57.96],
  );
  addsUp(total, "total");
  assert.deepEqual(groups.map((g: any) => g.key).sort(), ["claude-code", "codex"]);
  for (const g of groups) addsUp(g, g.key);
  for (const by of ["day", "model", "repo", "user"]) for (const g of (await spent(by)).groups) addsUp(g, `${by} ${g.key}`);
  // what is in pull requests is what their pages say was spent on them
  const pulls = (await call(tokens.admin, "GET", "/prs?repo=acme/spent&limit=500")).body.pulls;
  const sum = (rows: any[]) => rows.reduce((n: number, row: any) => n + (row.cost?.usd ?? 0), 0);
  assert.equal(cents(sum(pulls.filter((p: any) => p.state !== "closed"))), cents(total.in_pr_usd));
  assert.equal(cents(sum(pulls.filter((p: any) => p.state === "closed"))), cents(total.closed_unmerged_usd));
  const summary = (await call(tokens.admin, "GET", "/prs/summary?repo=acme/spent")).body.total;
  assert.equal(cents(summary.cost_usd), cents(total.in_pr_usd));
  // and what the summary says a line that survived cost is what those opened from the start cost, over
  // the lines of theirs that survived, as each page has them
  const open = pulls.filter((p: any) => p.state !== "closed" && p.cost?.opened_usd != null);
  const openedFor = open.reduce((n: number, p: any) => n + p.cost.opened_usd, 0);
  assert.deepEqual(open.map((p: any) => p.number).sort(), [1, 2, 3, 4, 5, 6, 7, 9]);
  assert.equal(summary.per_surviving_line_usd, Math.round((openedFor / summary.agent_lines_surviving_once) * 1e6) / 1e6);
  // (ten lines went from #1 with ten dollars: 4 + 2 + 1 + 3 + 2 + 2 + 2 + 2 are left of the rest)
  assert.deepEqual([openedFor, summary.agent_lines_surviving_once], [10 + 6 + 6 + 4 + 9 + 3 + 5 + 1.25 + 2.03, 18]);

  // closing one moves its money from one place to the other, and no charge
  await sent(4, [file("e.ts", 500, 9998)], { event: "closed", state: "closed" });
  const closed = (await spent()).total;
  assert.deepEqual([closed.in_pr_usd, closed.closed_unmerged_usd, closed.not_in_pr_usd], [total.in_pr_usd - 4, 2.57 + 4, total.not_in_pr_usd].map((n) => Math.round(n * 1e6) / 1e6));
  assert.deepEqual([(await cost(3)).usd, (await cost(4)).usd], [6, 4]);

  // a session stored again with another cost: charged again, split as it was
  await put("sp-split", 20, { "d.ts": range(400, 6), "e.ts": range(500, 4) });
  assert.deepEqual([(await cost(3)).usd, (await cost(4)).usd], [12, 8]);
  addsUp((await spent()).total, "after it cost more");

  // deleting a session takes what it cost out of every pull request and every one of the three
  assert.equal((await call(tokens.ann, "DELETE", "/sessions/m1/claude-code/sp-split")).status, 200);
  assert.deepEqual([(await cost(3)).usd, (await cost(3)).sessions_without_cost, (await cost(4)).usd], [null, 1, null]);
  assert.deepEqual((await db.query(`SELECT charged_usd, contributed FROM pull_sessions WHERE session_id = 'sp-split'`)).map((row) => [row.charged_usd, row.contributed]), [[null, null], [null, null]]);
  const after = (await spent()).total;
  assert.deepEqual(
    [after.in_pr_usd, after.closed_unmerged_usd, after.not_in_pr_usd, after.cost_usd],
    [total.in_pr_usd - 10, 2.57, total.not_in_pr_usd, 47.96].map((n) => Math.round(n * 1e6) / 1e6),
  );
  addsUp(after, "after deleting");
  for (const g of (await spent()).groups) addsUp(g, `after deleting, ${g.key}`);
  // someone who sees only their own sessions is told the same of those
  addsUp((await call(tokens.ann, "GET", "/summary?by=tool&repo=acme/spent")).body.total, "their own");
});

test("a share is unsure when a pull request it is split with did not keep which lines are whose", async () => {
  const repo = "github.com/acme/unkept";
  const s = session("c-unkept", "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [{ path: "p.ts", model: null, hashes: [100, 101, 102, 103].map(h) }]);
  s.session.repo.remote = repo;
  (s.session as Record<string, unknown>).cost = { total_usd: 8, source: "recorded" };
  assert.equal((await call(tokens.ann, "PUT", "/sessions/m1/claude-code/c-unkept", s)).status, 200);
  const files = [file("p.ts", 100, 101, 102, 103)];
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 1, files }));
  await call(tokens.ci, "PUT", "/prs", report({ repo, number: 2, event: "closed", state: "closed", files }));
  const of = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=${number}`)).body;
  const flags = (p: any) => [p.cost.estimated, p.cost.sessions_unshared, p.cost.sessions_unshared_for_good, p.sessions[0].unshared];
  // the same four lines in both, and which they are is kept: half of what it cost in each, for sure
  const open = await of(1);
  assert.deepEqual(flags(open), [false, 0, 0, false]);
  assert.deepEqual([open.cost.usd, open.cost.per_agent_line_usd, (await of(2)).cost.usd], [4, 1, 4]);
  // the one closed without merging as if it were from before which lines are whose was kept: they may be
  // the same ones or others, so what each is charged is an estimate. It can be matched again, to find out
  await db.query(`UPDATE pull_sessions SET matched = NULL, contributed = NULL WHERE repo = $1 AND number = 2`, [repo]);
  assert.deepEqual(flags(await of(1)), [true, 1, 0, true]);
  assert.deepEqual(flags(await of(2)), [true, 1, 0, true]);
  // and as if it could not: only a new report of it by the Action says which lines they are
  await db.query(`UPDATE pull_requests SET committers = NULL WHERE repo = $1 AND number = 2`, [repo]);
  assert.deepEqual(flags(await of(1)), [true, 1, 1, true]);
  // charged again, its four lines count whole beside the other's four, as they did shared: half in each still
  await db.asOrg(DEFAULT_ORG, async (tx) => {
    await holdPullSessions(tx);
    await chargeAgain(tx, [{ machine_id: "m1", source: "claude-code", session_id: "c-unkept" }]);
  });
  assert.deepEqual([(await of(1)).cost.usd, (await of(2)).cost.usd], [4, 4]);
});

test("a deleted session's lines count whole in each of its pull requests", async () => {
  const repo = "github.com/acme/forgot";
  const lines = Array.from({ length: 10 }, (_, i) => 200 + i);
  const s = session("c-forgot", "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [{ path: "q.ts", model: null, hashes: lines.map(h) }]);
  s.session.repo.remote = repo;
  (s.session as Record<string, unknown>).cost = { total_usd: 6, source: "recorded" };
  const put = () => call(tokens.ann, "PUT", "/sessions/m1/claude-code/c-forgot", s);
  assert.equal((await put()).status, 200);
  for (const number of [1, 2]) await call(tokens.ci, "PUT", "/prs", report({ repo, number, files: [file("q.ts", ...lines)] }));
  const weights = async () =>
    (await db.query(`SELECT number, weight, opened_weight FROM pull_sessions WHERE repo = $1 ORDER BY number`, [repo])).map((row) => [
      Number(row.number),
      Number(row.weight),
      Number(row.opened_weight),
    ]);
  // the same ten lines in both, opened with them: five in each
  assert.deepEqual(await weights(), [[1, 5, 5], [2, 5, 5]]);
  assert.equal((await call(tokens.ann, "DELETE", "/sessions/m1/claude-code/c-forgot")).status, 200);
  // which they were is gone: all ten count in each, as for a pull request whose lines were not kept
  assert.deepEqual(await weights(), [[1, 10, 10], [2, 10, 10]]);
  // sent again: both are matched again as it arrives, and which lines they have is known once more.
  // The same ten in each: five of them, of six dollars, three in each
  assert.equal((await put()).status, 200);
  assert.deepEqual(await weights(), [[1, 5, 5], [2, 5, 5]]);
  const cost = (await call(tokens.admin, "GET", `/prs/detail?repo=${repo}&number=1`)).body.cost;
  assert.deepEqual(
    [cost.usd, cost.per_agent_line_usd, cost.estimated, cost.sessions_unshared, cost.opened_usd, cost.opened_estimated, cost.per_surviving_line_usd],
    [3, 0.6, false, 0, 3, false, 0.6],
  );
});

test("counting sessions' line hashes waits for none that another transaction holds", async (t) => {
  // Only a server takes two transactions at once.
  if (!process.env.TEST_DATABASE_URL) return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const s = (id: string) => session(id, "claude-code", "claude-opus-5-5", "2026-11-10T09:00:00Z", [{ path: "r.ts", model: null, hashes: [h(300), h(301)] }]);
  for (const id of ["c-held", "c-free"]) assert.equal((await call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s(id))).status, 200);
  await db.query(`UPDATE sessions SET hashed_lines = NULL WHERE session_id IN ('c-held', 'c-free')`);
  // one held, as stopping a repository holds the sessions it deletes: it is passed over, to be tried again
  const meanwhile = await db.transaction(async (tx) => {
    await tx.query(`SELECT 1 FROM sessions WHERE session_id = 'c-held' FOR UPDATE`);
    return countHashedLines(db);
  });
  assert.deepEqual(meanwhile, { counted: 1, failed: 1 });
  assert.deepEqual(await countHashedLines(db), { counted: 1, failed: 0 });
  const counted = await db.query(`SELECT session_id, hashed_lines FROM sessions WHERE session_id IN ('c-held', 'c-free') ORDER BY session_id`);
  assert.deepEqual(counted.map((row) => [row.session_id, Number(row.hashed_lines)]), [["c-free", 2], ["c-held", 2]]);
});

test("a line in several pull requests is shared out between them", () => {
  const a = { "a.ts": [h(1), h(2), h(2)], "b.ts": [h(1)] };
  // alone: every line counts
  assert.deepEqual(weigh([{ live: true, lines: 4, matched: a }]), [4]);
  // the same file elsewhere, with one copy of the line that is twice here: three lines are shared, and twice is the most there is
  assert.deepEqual(weigh([{ live: true, lines: 4, matched: a }, { live: true, lines: 2, matched: { "a.ts": [h(1), h(2)] } }]), [0.5 + 4 / 3 + 1, 0.5 + 2 / 3]);
  // one closed without merging is shared out with the others, and they without it
  assert.deepEqual(weigh([{ live: true, lines: 1, matched: { "a.ts": [h(1)] } }, { live: false, lines: 1, matched: { "a.ts": [h(1)] } }]), [1, 0.5]);
  // one whose lines were not kept counts them all
  assert.deepEqual(weigh([{ live: true, lines: 7, matched: null }, { live: true, lines: 1, matched: { "a.ts": [h(1)] } }]), [7, 1]);
});

test("what a session's opening lines still there count as is shared out as they were, wherever they survived", () => {
  const both = { "a.ts": [h(1), h(2), h(2)] };
  const opened = [{ live: true, matched: both }, { live: true, matched: both }];
  // all still there in the second only: between them, all three
  const kept = weighKept(opened, [{ live: true, matched: {} }, { live: true, matched: both }]);
  assert.deepEqual(kept, [1.5, 1.5]);
  // one copy of the line it had twice is left: that copy is one line between them
  assert.deepEqual(weighKept(opened, [{ live: true, matched: { "a.ts": [h(2)] } }, { live: true, matched: {} }]), [0.5, 0.5]);
  // opened twice in one and once in the other, one copy left: one line between them, in proportion
  const uneven = [{ live: true, matched: { "a.ts": [h(3), h(3)] } }, { live: true, matched: { "a.ts": [h(3)] } }];
  const one = weighKept(uneven, [{ live: true, matched: {} }, { live: true, matched: { "a.ts": [h(3)] } }]);
  assert.deepEqual(one.map((n) => Math.round(n! * 1e9) / 1e9), [Math.round((2 / 3) * 1e9) / 1e9, Math.round((1 / 3) * 1e9) / 1e9]);
  // and one whose lines were not kept says nothing
  assert.deepEqual(weighKept([{ live: true, matched: null }], [{ live: true, matched: both }]), [null]);
});

test("a merged pull request's agent lines are counted again on its branch 7 and 30 days after", async () => {
  const repo = "github.com/acme/after";
  const q = encodeURIComponent(repo);
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const day = 86_400;
  // The organisation began counting 20 days ago.
  await db.query(`UPDATE orgs SET after_merge_since = now() - interval '20 days' WHERE id = 'default'`);
  const upload = (id: string, lines: { path: string; hashes: string[] }[]) => {
    const s = session(id, "claude-code", "claude-opus-5-5", ago(50), lines.map((l) => ({ ...l, model: null })));
    s.session.repo.remote = repo;
    return call(tokens.ann, "PUT", `/sessions/m1/claude-code/${id}`, s);
  };
  const merged = (number: number, days: number, files: unknown[], more: Record<string, unknown> = {}) =>
    call(tokens.ci, "PUT", "/prs", report({ repo, number, state: "merged", event: "closed", base_ref: "main", created_at: ago(days + 2), merged_at: ago(days), files, ...more }));
  const due = async (token = tokens.ci) => (await call(token, "GET", `/prs/due?repo=${q}`)).body.due;
  const count = (number: number, files: unknown[], token = tokens.ci, checkpoints: string[] = ["7d", "30d"]) =>
    call(token, "PUT", "/prs/after-merge", { repo, number, checkpoints, files });
  const detail = async (number: number) => (await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=${number}`)).body;

  assert.equal((await upload("am-1", [file("a.ts", 1, 2, 3), file("b.ts", 4)])).status, 200);
  assert.equal((await upload("am-3", [file("c.ts", 30, 31)])).status, 200);
  // #1 merged 8 days ago, with 4 agent lines in two files, and one line nobody's session wrote.
  assert.equal((await merged(1, 8, [file("a.ts", 1, 2, 3, 9), file("b.ts", 4), file("docs.md", 70)])).body.attribution.now.agent_lines, 4);
  // #2 merged 2 days ago: no age reached. #3 merged 40 days ago: it was 7 days old before any were counted.
  assert.equal((await merged(2, 2, [file("a.ts", 1)])).status, 200);
  assert.equal((await merged(3, 40, [file("c.ts", 30, 31)])).body.attribution.now.agent_lines, 2);
  // #4 has no agent lines to look for, and #5 is not merged.
  assert.equal((await merged(4, 8, [file("docs.md", 71)])).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs", report({ repo, number: 5, created_at: ago(9), files: [file("c.ts", 30)] }))).status, 200);

  // The longest merged first: which ages, and which files to read. No hashes.
  assert.deepEqual(await due(), [
    { number: 3, base_ref: "main", checkpoints: ["30d"], paths: ["c.ts"] },
    { number: 1, base_ref: "main", checkpoints: ["7d"], paths: ["a.ts", "b.ts"] },
  ]);
  assert.deepEqual(await due(tokens.admin), await due());
  assert.equal((await call(tokens.ann, "GET", `/prs/due?repo=${q}`)).status, 403);
  assert.equal((await count(1, [], tokens.ann)).status, 403);
  assert.equal((await call(tokens.ci, "GET", "/prs/due")).status, 400);

  // A file asked for and left out would count as gone: refused, and nothing is kept.
  const partial = await count(1, [file("a.ts", 1, 2, 3)]);
  assert.equal(partial.status, 422);
  assert.match(partial.body.error, /leaves out 1 of the files asked for \(b\.ts\)/);
  assert.equal((await count(5, [file("c.ts", 30)])).status, 422);
  assert.equal((await count(99, [])).status, 404);
  assert.equal((await count(1, [{ path: "a.ts", hashes: ["the line itself"] }])).status, 422);
  // The ages the files were read for are said, and are the only ones kept.
  assert.equal((await call(tokens.ci, "PUT", "/prs/after-merge", { repo, number: 1, files: [] })).status, 422);
  assert.equal((await count(1, [], tokens.ci, ["90d"])).status, 422);
  assert.deepEqual((await count(1, [file("a.ts", 1), file("b.ts")], tokens.ci, ["30d"])).body.stored, []);

  // On main now: a.ts has two of its three agent lines (one of them twice), and b.ts is gone.
  const first = await count(1, [file("a.ts", 1, 3, 3, 77), file("b.ts")]);
  assert.equal(first.status, 200);
  assert.equal(first.body.stored.length, 1);
  const seven = first.body.stored[0];
  assert.deepEqual([seven.checkpoint, seven.agent_lines, seven.surviving], ["7d", 4, 2]);
  assert.ok(seven.age_seconds >= 8 * day && seven.age_seconds < 8 * day + 600, String(seven.age_seconds));

  let page = await detail(1);
  assert.deepEqual(page.after_merge, [seven]);
  // The pull request's own figures are what they were, and so is the history of its reports: a count is not one.
  assert.equal(page.attribution.now.agent_lines, 4);
  assert.deepEqual(page.history.map((row: any) => [row.event, row.agent_lines]), [["closed", 4]]);

  // Counted again with everything back: the count of day 8 stays, and it is not asked for again.
  assert.deepEqual((await count(1, [file("a.ts", 1, 2, 3), file("b.ts", 4)])).body.stored, []);
  assert.deepEqual((await detail(1)).after_merge, [seven]);
  assert.deepEqual((await due()).map((pull: any) => pull.number), [3]);

  // A session uploaded since is compared with the report before it, not with the count on main.
  assert.equal((await upload("am-late", [file("docs.md", 70)])).status, 200);
  page = await detail(1);
  assert.deepEqual(page.history.map((row: any) => row.event), ["match", "closed"]);
  assert.equal(page.history[0].change.reason, "1 session uploaded since: +1 agent lines");
  assert.deepEqual([page.history[0].change.agent_lines_before, page.history[0].agent_lines], [4, 5]);
  assert.deepEqual(page.after_merge, [seven]);

  // 31 days after merging, the next age is due: counted of the lines it has now, with the age it really is.
  await db.query(`UPDATE pull_requests SET merged_at = now() - interval '31 days' WHERE repo = $1 AND number = 1`, [repo]);
  assert.deepEqual((await due()).find((pull: any) => pull.number === 1), { number: 1, base_ref: "main", checkpoints: ["30d"], paths: ["a.ts", "b.ts", "docs.md"] });
  // Files read for 7 days, when 30 was not due yet, say nothing of day 30 however late they arrive.
  assert.deepEqual((await count(1, [file("a.ts"), file("b.ts"), file("docs.md")], tokens.ci, ["7d"])).body.stored, []);
  const later = await count(1, [file("a.ts", 1), file("b.ts"), file("docs.md", 70)]);
  const thirty = later.body.stored[0];
  assert.deepEqual([later.body.stored.length, thirty.checkpoint, thirty.agent_lines, thirty.surviving], [1, "30d", 5, 2]);
  assert.ok(thirty.age_seconds >= 31 * day);
  assert.deepEqual((await detail(1)).after_merge, [seven, thirty]);

  // #3 missed nothing it could have had: 30 days only, taken on day 40.
  const old = await count(3, [file("c.ts", 30, 31)]);
  assert.deepEqual(old.body.stored.map((row: any) => [row.checkpoint, row.agent_lines, row.surviving, Math.floor(row.age_seconds / day)]), [["30d", 2, 2, 40]]);
  assert.deepEqual(await due(), []);

  // Many reports later the counts are still there: they are no part of the 50 reports kept.
  for (let i = 0; i < 52; i++) {
    assert.equal((await merged(3, 40, [file("c.ts", 30, 31)], { commits: 2 + i })).status, 200);
  }
  page = await detail(3);
  assert.equal(page.history.length, 50);
  assert.deepEqual(page.after_merge.map((row: any) => row.checkpoint), ["30d"]);
  // What is looked for is what is counted: the hashes kept, whatever the number of lines beside them says.
  // (Where a repository is shown, files not shown are taken out of the hashes before it is matched again.)
  assert.equal((await merged(6, 8, [file("c.ts", 30, 31)])).body.attribution.now.agent_lines, 2);
  await db.query(`UPDATE pull_sessions SET matched = '{"c.ts": ["${h(30)}"]}' WHERE repo = $1 AND number = 6`, [repo]);
  assert.deepEqual((await count(6, [file("c.ts", 30, 31)])).body.stored.map((row: any) => [row.agent_lines, row.surviving]), [[1, 1]]);
  // and one with no hashes kept has nothing to look for
  assert.equal((await merged(7, 8, [file("c.ts", 30, 31)])).status, 200);
  await db.query(`UPDATE pull_sessions SET matched = '{}' WHERE repo = $1 AND number = 7`, [repo]);
  assert.deepEqual(await due(), []);
  assert.deepEqual((await count(7, [file("c.ts", 30, 31)])).body.stored, []);
  // Another organisation sees none of them.
  await newOrg(db, "org-after");
  assert.deepEqual(await db.asOrg("org-after", (scoped) => scoped.query(`SELECT 1 FROM pull_after_merge`)), []);
  assert.equal((await db.asOrg("default", (scoped) => scoped.query(`SELECT 1 FROM pull_after_merge WHERE repo = $1`, [repo]))).length, 4);
});

test("pull requests and sessions from before the cost was shown have one after the upgrade", async (t) => {
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-cost-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const url = folder ? `file:${join(folder, "db")}` : fresh;
  const old = await openDb(url, { migrations: migrationAt("ALTER TABLE sessions ADD COLUMN hashed_lines") });
  await old.query(`INSERT INTO orgs (id, name) VALUES ('old-cost', 'Old')`);
  const lines = JSON.stringify([{ path: "a.ts", hashes: [h(1), h(2), h(3)] }, { path: "b.ts", hashes: [h(4)] }, { path: "c.ts" }]);
  await old.query(
    `INSERT INTO sessions (org_id, machine_id, source, session_id, owner_email, content, cost_usd, cost_source, payload) VALUES
       ('old-cost', 'm1', 'claude-code', 's1', 'ann@example.com', 'metadata', 8, 'recorded', $1::jsonb),
       ('old-cost', 'm1', 'claude-code', 's2', 'ann@example.com', 'metadata', 1, 'recorded', '{"session":{}}')`,
    [JSON.stringify({ session: {}, lines: JSON.parse(lines) })],
  );
  const attribution = `{"first":{"lines":2,"agent_lines":2},"now":{"lines":2,"agent_lines":2,"by":[]},"by":[]}`;
  await old.query(
    `INSERT INTO pull_requests (org_id, repo, number, author, state, first_event, last_event, first_files, last_files, attribution, detail) VALUES
       ('old-cost', 'github.com/acme/old', 1, 'ann', 'merged', 'opened', 'closed', '[]', '[]', $1::jsonb, $2::jsonb),
       ('old-cost', 'github.com/acme/old', 2, 'ann', 'merged', 'opened', 'closed', '[]', '[]', $1::jsonb, NULL),
       ('old-cost', 'github.com/acme/old', 3, 'ann', 'merged', 'opened', 'closed', '[]', '[]', $1::jsonb, $2::jsonb)`,
    [attribution, JSON.stringify({
      files: [],
      sessions: [
        { machine_id: "m1", source: "claude-code", session_id: "s1", lines: 2 },
        { machine_id: "m1", source: "claude-code", session_id: "s0", lines: 0 },
      ],
    })],
  );
  await old.query(`UPDATE pull_requests SET reporter_version = '0.4.0', commits = 7 WHERE org_id = 'old-cost' AND number = 1`);
  await old.close();

  const upgraded = await openDb(url);
  try {
    const hashed = () =>
      upgraded
        .query(`SELECT session_id, hashed_lines FROM sessions WHERE org_id = 'old-cost' ORDER BY session_id`)
        .then((rows) => rows.map((row) => [row.session_id, row.hashed_lines == null ? null : Number(row.hashed_lines)]));
    // not counted by the upgrade itself, which would hold every session meanwhile, but once the server is up
    assert.deepEqual(await hashed(), [["s1", null], ["s2", null]]);
    assert.deepEqual(await countHashedLines(upgraded, 1), { counted: 2, failed: 0 });
    assert.deepEqual(await hashed(), [["s1", 4], ["s2", 0]]);
    assert.deepEqual(await countHashedLines(upgraded), { counted: 0, failed: 0 });
    // the database counts them itself when a payload is stored, whoever stores it: a server from before this too
    await upgraded.query(`UPDATE sessions SET payload = '{"session":{},"lines":[{"path":"a.ts","hashes":["0000000000000001"]}]}' WHERE org_id = 'old-cost' AND session_id = 's2'`);
    assert.deepEqual(await hashed(), [["s1", 4], ["s2", 1]]);
    const upgradedApp = createApp(upgraded);
    const admin = await tokenFor(upgraded, { email: "boss@example.com", role: "admin" }, "old-cost");
    // until the server has charged the sessions it held to their pull requests, what one is charged of
    // each is not known, and is said so
    const early = await (await upgradedApp.request("/api/v1/prs?state=merged", { headers: { authorization: `Bearer ${admin}` } })).json() as any;
    const first = early.pulls.find((p: any) => p.number === 1).cost;
    assert.deepEqual([first.usd, first.sessions_without_cost, first.sessions_uncounted], [null, 1, 1]);
    // and its row says so, where it would have a share; the one with no line in it is no session of it
    const page = await (await upgradedApp.request("/api/v1/prs/detail?repo=github.com/acme/old&number=1", { headers: { authorization: `Bearer ${admin}` } })).json() as any;
    assert.deepEqual(page.sessions.map((s: any) => [s.session_id, s.cost_share_usd, s.uncounted]), [["s1", null, true]]);
    // the first history row is the figures already stored, and the sessions that had lines then
    const kept = (sessions: { session_id: string; lines: number }[]) => sessions.map((s) => [s.session_id, s.lines]).sort();
    assert.equal(page.history.length, 1);
    assert.equal(page.history[0].change.reason, null);
    assert.equal(page.history[0].event, "closed");
    assert.equal(page.history[0].reporter_version, "0.4.0");
    assert.deepEqual([page.history[0].commits, page.history[0].lines, page.history[0].agent_lines], [7, 2, 2]);
    assert.deepEqual(kept(page.history[0].sessions), [["s1", 2]]);
    const bare = await (await upgradedApp.request("/api/v1/prs/detail?repo=github.com/acme/old&number=2", { headers: { authorization: `Bearer ${admin}` } })).json() as any;
    assert.equal(bare.history.length, 1);
    assert.deepEqual(bare.history[0].sessions, []);
    const third = await (await upgradedApp.request("/api/v1/prs/detail?repo=github.com/acme/old&number=3", { headers: { authorization: `Bearer ${admin}` } })).json() as any;
    assert.equal(third.history[0].reporter_version, null);
    assert.deepEqual(kept(third.history[0].sessions), [["s1", 2]]);
    // which it does once it is up, a batch at a time
    let after: SessionAt | null = null;
    while ((after = await upgraded.asOrg("old-cost", (tx) => weighKeptSome(tx, after, 1)))) continue;
    assert.equal(await upgraded.asOrg("old-cost", (tx) => weighKeptSome(tx)), null);
    const list = await (await upgradedApp.request("/api/v1/prs?state=merged", { headers: { authorization: `Bearer ${admin}` } })).json() as any;
    const costs = Object.fromEntries(list.pulls.map((p: any) => [p.number, p.cost && [p.cost.usd, p.cost.estimated, p.cost.sessions_unshared, p.cost.opened_usd]]));
    // these were last reported before what they are matched by was kept: matching again cannot share the lines out, and that is said
    assert.deepEqual(list.pulls.filter((p: any) => p.cost).map((p: any) => [p.matchable, p.cost.sessions_unshared_for_good]), [[false, 1], [false, 1]]);
    // two lines of the session in each of two, and all it cost between them: which lines was not kept, so they
    // may be the same two, and the cost is said to be an estimate; what they were opened with cost is not known.
    // The other was reported before sessions were kept at all.
    assert.deepEqual(costs, { 1: [4, true, 1, null], 2: null, 3: [4, true, 1, null] });
    const summary = await (await upgradedApp.request("/api/v1/prs/summary", { headers: { authorization: `Bearer ${admin}` } })).json() as any;
    // that one has agent lines and no cost: the total is a floor
    assert.deepEqual([summary.total.cost_usd, summary.total.cost_estimated, summary.total.pulls_with_cost_missing], [8, true, 1]);
  } finally {
    await upgraded.close();
  }
});
