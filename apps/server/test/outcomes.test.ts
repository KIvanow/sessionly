import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { BadReport } from "../src/pulls.ts";
import { checkOutcomes, classify, MOST_LINES, MOST_LINES_A_COMMIT } from "../src/outcomes.ts";
import { testDb, tokenFor } from "./helpers.ts";

// Hashes are 16 hex digits; these stand for lines.
const h = (n: number) => n.toString(16).padStart(16, "0");
const file = (path: string, ...lines: number[]) => ({ path, hashes: lines.map(h) });
const sha = (n: number) => n.toString(16).padStart(40, "0");
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

let db: Db;
let app: Hono<Env>;
const tokens = { admin: "", ann: "", ci: "" };
const later: Promise<void>[] = [];

before(async () => {
  db = await testDb();
  app = createApp(db, { background: (work) => void later.push(work) });
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
  await Promise.all(later.splice(0));
  return { status: response.status, body: (await response.json()) as any };
}

function upload(repo: string, id: string, source: string, lines: { path: string; hashes: string[] }[], startedDays = 60) {
  const body = {
    schema_version: 1,
    session: {
      schema_version: 1,
      source,
      machine_id: "m1",
      session_id: id,
      content: "metadata",
      started_at: ago(startedDays),
      repo: { root: "~/src/web", remote: repo },
      models: [`${source}-model`],
    },
    rewrite: null,
    lines: lines.map((l) => ({ ...l, model: null })),
  };
  return call(tokens.ann, "PUT", `/sessions/m1/${source}/${id}`, body);
}

function merged(repo: string, number: number, days: number, files: unknown[], more: Record<string, unknown> = {}) {
  return call(tokens.ci, "PUT", "/prs", {
    repo,
    number,
    title: "Add the parser",
    author: "ann",
    state: "merged",
    created_at: ago(days + 2),
    merged_at: ago(days),
    base_ref: "main",
    event: "closed",
    commits: 1,
    reviews: 0,
    changes_requested: 0,
    review_comments: 0,
    bot_review_comments: 0,
    review_rounds: 0,
    files,
    ...more,
  });
}

/** A later commit as the Action sends it. */
const commit = (n: number, landed: string, files: { path: string; removed?: number[]; added?: number[] }[], more: Record<string, unknown> = {}) => ({
  sha: sha(n),
  url: `https://github.com/acme/later/commit/${sha(n)}`,
  landed_at: landed,
  pulls: [],
  after: [1],
  signals: [],
  reverts: { shas: [], pulls: [] },
  removed_total: files.reduce((sum, f) => sum + (f.removed?.length ?? 0), 0),
  files: files.map((f) => ({ path: f.path, removed: (f.removed ?? []).map(h), added: (f.added ?? []).map(h) })),
  ...more,
});

test("a revert names the merge commit or its pull request, or takes most of the lines; a reapply reverts nothing", () => {
  const pull = { number: 4, merge_commit_sha: sha(44) };
  const none = { signals: [] as string[], reverts: { shas: [] as string[], pulls: [] as number[] } };
  assert.deepEqual(classify({ ...none, reverts: { shas: [sha(44).slice(0, 7)], pulls: [] } }, pull, { agent: 1, before: 10 }), { kind: "revert", signals: ["revert_sha"] });
  assert.deepEqual(classify({ ...none, reverts: { shas: [], pulls: [4] } }, pull, { agent: 1, before: 10 }), { kind: "revert", signals: ["revert_pull"] });
  // a revert subject: only with half the lines still there
  assert.equal(classify({ ...none, signals: ["revert_subject"] }, pull, { agent: 4, before: 10 }).kind, "rework");
  assert.deepEqual(classify({ ...none, signals: ["revert_pr_title"] }, pull, { agent: 5, before: 10 }), { kind: "revert", signals: ["revert_bulk"] });
  assert.deepEqual(classify({ ...none, signals: ["fix_message", "fix_branch"] }, pull, { agent: 2, before: 10 }), { kind: "fix", signals: ["fix_message", "fix_branch"] });
  assert.equal(classify({ ...none, reapply: true, signals: ["revert_subject"], reverts: { shas: [sha(44)], pulls: [] } }, pull, { agent: 10, before: 10 }).kind, "rework");
  // but its pull request saying it reverts this one is so whatever the chain of reverts it is in
  assert.deepEqual(classify({ ...none, reapply: true, reverts: { shas: [sha(44)], pulls: [4] } }, pull, { agent: 1, before: 10 }), { kind: "revert", signals: ["revert_pull"] });
});

test("later commits on the base branch are walked against a merged pull request's lines", async () => {
  const repo = "github.com/acme/later";
  const q = encodeURIComponent(repo);
  await db.query(`UPDATE orgs SET outcomes_since = now() - interval '20 days' WHERE id = 'default'`);
  assert.equal((await upload(repo, "o-claude", "claude-code", [file("a.ts", 1, 2, 3, 4, 5, 6)])).status, 200);
  assert.equal((await upload(repo, "o-cursor", "cursor", [file("b.ts", 10, 11, 12)])).status, 200);
  // #1, merged 10 days ago: 6 Claude Code lines and 3 Cursor lines, and a line of a person's (9).
  const first = await merged(repo, 1, 10, [file("a.ts", 1, 2, 3, 4, 5, 6, 9), file("b.ts", 10, 11, 12)], { merge_commit_sha: sha(100), head_sha: sha(99) });
  assert.equal(first.body.attribution.now.agent_lines, 9);
  // #2 has no agent lines; #3 is from before the organisation read any.
  assert.equal((await merged(repo, 2, 5, [file("docs.md", 70)])).status, 200);
  assert.equal((await merged(repo, 3, 40, [file("a.ts", 1)])).status, 200);

  const due = await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`);
  assert.equal(due.status, 200);
  assert.deepEqual(due.body, {
    branches: [{
      base_ref: "main",
      since: due.body.branches[0].since,
      until: due.body.branches[0].until,
      pulls: [{ number: 1, merged_at: due.body.branches[0].pulls[0].merged_at, merge_commit_sha: sha(100), since: due.body.branches[0].pulls[0].merged_at, tips: null, paths: ["a.ts", "b.ts"] }],
    }],
  });
  assert.ok(!JSON.stringify(due.body).includes(h(1)), "no hashes are sent out");
  // Asked for earlier ones too, the older one is due as well, first.
  const back = await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}&since=${encodeURIComponent(ago(60))}`);
  assert.deepEqual(back.body.branches[0].pulls.map((p: any) => p.number), [3, 1]);
  assert.equal((await call(tokens.ann, "GET", `/prs/outcomes/due?repo=${q}`)).status, 403);

  const scan = (commits: unknown[], until = ago(0), pulls = [{ number: 1, found: true }]) =>
    call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", tip: sha(999), scanned_until: until, pulls, commits });
  const commits = [
    // Before the merge: not later.
    commit(1, ago(11), [{ path: "a.ts", removed: [1, 2] }], { signals: ["fix_message"] }),
    // A fix of 2 Claude Code lines, a person's line and a line of nobody's in the pull request.
    commit(2, ago(9.5), [{ path: "a.ts", removed: [1, 2, 9, 80], added: [81] }], { signals: ["fix_conventional"], removed_total: 4 }),
    // Not after the merge commit in the history: it never saw the lines.
    commit(3, ago(9), [{ path: "a.ts", removed: [3, 4] }], { after: [] }),
    // The pull request's own (merged with it): not counted, though its lines go.
    commit(4, ago(9), [{ path: "a.ts", removed: [3, 4] }], { pulls: [1] }),
    // One line only: too little to say whose it was.
    commit(5, ago(8), [{ path: "b.ts", removed: [10] }]),
    // Moved to c.ts: followed there, where rework then takes them.
    commit(6, ago(7.5), [], { moves: [{ from: "b.ts", to: "c.ts", hashes: [h(11), h(12)] }], removed_total: 0 }),
    commit(7, ago(7), [{ path: "c.ts", removed: [11, 12] }]),
    // A revert of the merge commit, then its revert: the lines come back.
    commit(8, ago(6), [{ path: "a.ts", removed: [3, 4, 5, 6] }], { signals: ["revert_subject"], reverts: { shas: [sha(100).slice(0, 12)], pulls: [] } }),
    commit(9, ago(2), [{ path: "a.ts", added: [3, 4, 5, 6] }], { reapply: true, reverts: { shas: [sha(8)], pulls: [] } }),
    // And a later change of them counts again.
    commit(10, ago(1), [{ path: "a.ts", removed: [5, 6] }], { signals: ["fix_message"], removed_total: 10 }),
  ];
  const stored = await scan(commits);
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.deepEqual(stored.body.stored.map((row: any) => [row.number, row.sha, row.kind]), [
    [1, sha(2), "fix"],
    [1, sha(7), "rework"],
    [1, sha(8), "revert"],
    [1, sha(10), "fix"],
  ]);
  // Only the pull request's own lines are kept of what a commit removed.
  const [kept] = await db.query(`SELECT removed FROM pull_outcome_commits WHERE repo = $1 AND sha = $2`, [repo, sha(2)]);
  assert.deepEqual(kept!.removed, { "a.ts": [h(1), h(2), h(9)] });
  // Sent again: kept once.
  assert.deepEqual((await scan(commits)).body.stored, []);

  const page = (await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`)).body;
  const outcomes = page.outcomes;
  assert.ok(outcomes.scanned_until);
  assert.deepEqual(outcomes.commits.map((c: any) => [c.sha, c.kind, c.lines, c.agent_lines, c.counted, c.likely]), [
    // half of what it removed was the agents': a likely fix
    [sha(2), "fix", 3, 2, true, true],
    [sha(7), "rework", 2, 2, true, false],
    // the two its own commit took out were gone already
    [sha(8), "revert", 2, 2, true, false],
    [sha(10), "fix", 2, 2, true, false],
  ]);
  const revert = outcomes.commits[2];
  assert.equal(revert.relanded_at, commits[8]!.landed_at);
  // it names the merge commit, and it took all that was left
  assert.deepEqual(revert.signals, ["revert_sha", "revert_bulk"]);
  assert.deepEqual(outcomes.commits[1].sessions.map((s: any) => [s.session_id, s.lines]), [["o-cursor", 2]]);
  // 1 and 7 days are reached; 30 are not.
  const { "1d": one, "7d": seven, "30d": thirty } = outcomes.windows;
  assert.deepEqual([one.reached, one.fix_commits, one.agent_lines_fixed], [true, 1, 2]);
  assert.deepEqual([seven.reached, seven.fix_commits, seven.rework_commits, seven.revert_commits, seven.reverted], [true, 1, 1, 1, true]);
  // by 30 days the revert was reverted
  assert.deepEqual([thirty.reached, thirty.fix_commits, thirty.revert_commits, thirty.reverted], [false, 2, 1, false]);

  // By tool: lines add up to the total, a commit counts in each group it changed and once in the total.
  const summary = (await call(tokens.admin, "GET", "/prs/outcomes/summary?by=tool")).body;
  const group = (key: string) => summary.groups.find((g: any) => g.key === key).outcomes_7d;
  assert.deepEqual(summary.groups.map((g: any) => g.key), ["claude-code", "cursor"]);
  assert.deepEqual([group("claude-code").pulls_reached, group("claude-code").agent_lines, group("claude-code").fix_commits, group("claude-code").pulls_reverted], [1, 6, 1, 1]);
  assert.deepEqual([group("cursor").rework_commits, group("cursor").agent_lines_reworked, group("cursor").pulls_reverted], [1, 2, 0]);
  assert.equal(summary.total.outcomes_7d.agent_lines, 9);
  // #3 was merged before the server began reading them, and was never read: in neither
  assert.deepEqual([summary.total.outcomes_7d.pulls_reached, summary.total.outcomes_7d.pulls_total], [1, 1]);
  assert.equal(summary.total.outcomes_30d.pulls_reached, 0);
  assert.equal((await call(tokens.admin, "GET", "/prs/outcomes/summary?by=planet")).status, 400);
  assert.equal((await call(tokens.ci, "GET", "/prs/outcomes/summary")).status, 403);
  assert.equal((await call(tokens.admin, "GET", "/prs/outcomes/summary?by=tool&tool=cursor")).body.groups.length, 1);

  // The split follows the sessions: one deleted takes its lines with it, and the commit stays.
  assert.equal((await call(tokens.ann, "DELETE", "/sessions/m1/cursor/o-cursor")).status, 200);
  const without = (await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`)).body.outcomes;
  assert.deepEqual(without.commits[1].sessions, []);
  assert.equal(without.commits[1].counted, false);

  // A report from an Action before 0.5.0 says nothing of the merge commit: what is known stays.
  await merged(repo, 1, 10, [file("a.ts", 1, 2, 3, 4, 5, 6, 9), file("b.ts", 10, 11, 12)], { reporter: { name: "sessionly-action", version: "0.4.0" } });
  const [row] = await db.query(`SELECT merge_commit_sha, head_sha FROM pull_requests WHERE repo = $1 AND number = 1`, [repo]);
  assert.deepEqual([row!.merge_commit_sha, row!.head_sha], [sha(100), sha(99)]);

  // Read to its 30 days, it is not due again.
  await db.query(`UPDATE pull_requests SET outcomes_scanned_until = merged_at + interval '30 days' WHERE repo = $1 AND number = 1`, [repo]);
  assert.deepEqual((await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body, { branches: [] });
});

test("what the Action reads of a real history is what the server walks", async () => {
  type Stored = { number: number; sha: string; kind: string };
  const action: { runOutcomes: (env: Record<string, string>, ctx: Record<string, unknown>) => Promise<{ stored: Stored[] }> } = await import(
    new URL("../../../action/src/outcomes.mjs", import.meta.url).href
  );
  const { gitIn }: { gitIn: (cwd: string, spawn: typeof spawnSync) => unknown } = await import(new URL("../../../action/src/history.mjs", import.meta.url).href);
  const { lineHash }: { lineHash: (line: string) => string } = await import(new URL("../../../action/src/lines.mjs", import.meta.url).href);
  const dir = mkdtempSync(join(tmpdir(), "sessionly-outcomes-"));
  try {
    const at = (days: number) => Math.floor((Date.now() - days * 86_400_000) / 1000);
    const git = (args: string[], when = at(20)) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, GIT_AUTHOR_DATE: `@${when} +0000`, GIT_COMMITTER_DATE: `@${when} +0000`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const done = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
      assert.equal(done.status, 0, done.stderr);
      return done.stdout.trim();
    };
    const lines = (...ns: number[]) => ns.map((n) => `compute_${n}(input, ${n});`);
    git(["init", "-q", "--initial-branch", "main"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "app.ts"), `${lines(1, 2, 3, 4).join("\n")}\n`);
    git(["add", "-A"], at(12));
    git(["commit", "-q", "-m", "Add compute (#1)"], at(12));
    const merge = git(["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "app.ts"), `${lines(3, 4).join("\n")}\nfixed();\n`);
    git(["commit", "-q", "-am", "Fix the crash in compute"], at(11));
    const fix = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const repo = "github.com/acme/real";
    await db.query(`UPDATE orgs SET outcomes_since = now() - interval '20 days' WHERE id = 'default'`);
    const hashes = lines(1, 2, 3, 4).map(lineHash);
    assert.equal((await upload(repo, "real-1", "codex", [{ path: "app.ts", hashes }])).status, 200);
    const merged_at = new Date(at(12) * 1000 + 60_000).toISOString();
    await call(tokens.ci, "PUT", "/prs", {
      repo, number: 1, author: "ann", state: "merged", created_at: ago(13), merged_at, base_ref: "main", event: "closed",
      commits: 1, reviews: 0, changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0,
      files: [{ path: "app.ts", hashes }], merge_commit_sha: merge,
    });
    const { branches } = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${encodeURIComponent(repo)}`)).body;
    assert.equal(branches.length, 1);
    // The Action's whole run, against this server: GitHub says nothing of any commit.
    const api = { request: async () => [], graphql: async () => ({ repository: {} }) };
    const server = async (method: string, path: string, body?: unknown) => {
      const answer = await call(tokens.ci, method, path, body);
      if (answer.status !== 200) throw Object.assign(new Error(JSON.stringify(answer.body)), { status: answer.status });
      return answer.body;
    };
    const run = () => action.runOutcomes({}, { api, server, repo: "acme/real", host: "github.com", log: () => {}, git: gitIn(dir, spawnSync) });
    assert.deepEqual((await run()).stored, [{ number: 1, sha: fix, kind: "fix" }]);
    // Run again, it is read on from where it was: nothing more.
    assert.deepEqual((await run()).stored, []);
    const outcomes = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body.outcomes;
    assert.deepEqual(outcomes.commits.map((c: any) => [c.sha, c.kind, c.agent_lines, c.likely, c.signals]), [[fix, "fix", 2, true, ["fix_message"]]]);
    assert.equal(outcomes.windows["1d"].reached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch merged in after a reading, and a push of a commit days old, are read from where the last run got to, once each", async () => {
  type Stored = { number: number; sha: string; kind: string };
  const action: { runOutcomes: (env: Record<string, string>, ctx: Record<string, unknown>) => Promise<{ stored: Stored[] }> } = await import(
    new URL("../../../action/src/outcomes.mjs", import.meta.url).href
  );
  const { gitIn }: { gitIn: (cwd: string, spawn: typeof spawnSync) => unknown } = await import(new URL("../../../action/src/history.mjs", import.meta.url).href);
  const { lineHash }: { lineHash: (line: string) => string } = await import(new URL("../../../action/src/lines.mjs", import.meta.url).href);
  const dir = mkdtempSync(join(tmpdir(), "sessionly-outcomes-"));
  try {
    const at = (days: number) => Math.floor((Date.now() - days * 86_400_000) / 1000);
    const git = (args: string[], when = at(20)) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, GIT_AUTHOR_DATE: `@${when} +0000`, GIT_COMMITTER_DATE: `@${when} +0000`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const done = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
      assert.equal(done.status, 0, done.stderr);
      return done.stdout.trim();
    };
    const lines = (...ns: number[]) => ns.map((n) => `compute_${n}(input, ${n});`);
    git(["init", "-q", "--initial-branch", "main"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "app.ts"), `${lines(1, 2, 3, 4, 5, 6).join("\n")}\n`);
    git(["add", "-A"], at(12));
    git(["commit", "-q", "-m", "Add compute (#1)"], at(12));
    const merge = git(["rev-parse", "HEAD"]);
    // A branch from the merge, made a day later, merged only after the first run.
    git(["checkout", "-q", "-b", "feature"], at(11));
    writeFileSync(join(dir, "app.ts"), `${lines(1, 2, 3, 4).join("\n")}\nreworked();\n`);
    git(["commit", "-q", "-am", "Rework compute"], at(11));
    const rework = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "main"]);
    writeFileSync(join(dir, "other.ts"), "other();\n");
    git(["add", "-A"], at(10));
    git(["commit", "-q", "-m", "Other"], at(10));
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const repo = "github.com/acme/merged-in";
    const q = encodeURIComponent(repo);
    await db.query(`UPDATE orgs SET outcomes_since = now() - interval '20 days' WHERE id = 'default'`);
    const hashes = lines(1, 2, 3, 4, 5, 6).map(lineHash);
    assert.equal((await upload(repo, "merged-in-1", "codex", [{ path: "app.ts", hashes }])).status, 200);
    await call(tokens.ci, "PUT", "/prs", {
      repo, number: 1, author: "ann", state: "merged", created_at: ago(13), merged_at: new Date(at(12) * 1000 + 60_000).toISOString(), base_ref: "main", event: "closed",
      commits: 1, reviews: 0, changes_requested: 0, review_comments: 0, bot_review_comments: 0, review_rounds: 0,
      files: [{ path: "app.ts", hashes }], merge_commit_sha: merge,
    });
    const api = { request: async () => [], graphql: async () => ({ repository: {} }) };
    const server = async (method: string, path: string, body?: unknown) => {
      const answer = await call(tokens.ci, method, path, body);
      if (answer.status !== 200) throw Object.assign(new Error(JSON.stringify(answer.body)), { status: answer.status });
      return answer.body;
    };
    const run = async () => (await action.runOutcomes({}, { api, server, repo: "acme/merged-in", host: "github.com", log: () => {}, git: gitIn(dir, spawnSync) })).stored;
    assert.deepEqual(await run(), []);
    const [due] = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body.branches;
    assert.deepEqual(due.pulls[0].tips, [git(["rev-parse", "main"])]);
    // The branch is merged with a merge commit: its own commit is from day 11, long before the last reading.
    git(["merge", "-q", "--no-ff", "--no-edit", "feature"], at(0.5));
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    assert.deepEqual(await run(), [{ number: 1, sha: rework, kind: "rework" }]);
    // And a push of a commit made days ago.
    writeFileSync(join(dir, "app.ts"), `${lines(1, 2).join("\n")}\nreworked();\n`);
    git(["commit", "-q", "-am", "Fix compute"], at(9));
    const fix = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    assert.deepEqual(await run(), [{ number: 1, sha: fix, kind: "fix" }]);
    assert.deepEqual(await run(), []);
    const outcomes = (await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`)).body.outcomes;
    assert.deepEqual(outcomes.commits.map((c: any) => [c.sha, c.kind]), [[rework, "rework"], [fix, "fix"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scan is checked before anything of it is kept", async () => {
  const put = (body: unknown, token = tokens.ci) => call(token, "PUT", "/prs/outcomes", body);
  const base = { repo: "github.com/acme/later", base_ref: "main", scanned_until: ago(0), pulls: [], commits: [] };
  assert.equal((await put(base)).status, 200);
  assert.equal((await put(base, tokens.ann)).status, 403);
  assert.equal((await put({ ...base, base_ref: "" })).status, 422);
  assert.equal((await put({ ...base, scanned_until: "soon" })).status, 422);
  const bad = (more: Record<string, unknown>) => put({ ...base, pulls: [{ number: 1, found: false }], commits: [{ ...commit(1, ago(1), []), ...more }] });
  assert.equal((await bad({ sha: "abc" })).status, 422);
  assert.equal((await bad({ signals: ["looks_wrong"] })).status, 422);
  assert.equal((await bad({ files: [{ path: "a.ts", removed: ["the line itself"] }] })).status, 422);
  assert.equal((await bad({ reverts: { shas: ["xyz"], pulls: [] } })).status, 422);
  assert.equal((await bad({})).status, 200);
  assert.equal((await put({ ...base, commits: Array.from({ length: 501 }, (_, i) => commit(i + 1, ago(1), [])) })).status, 422);
  // a branch the pull request was not merged into says nothing of it
  const other = await put({ ...base, base_ref: "release", pulls: [{ number: 1, found: false }], commits: [commit(50, ago(1), [{ path: "a.ts", removed: [1, 2, 3] }])] });
  assert.deepEqual(other.body.stored, []);
});

/** The organisation's merged pull requests are read from this many days ago. */
const readingSince = (days = 60) => db.query(`UPDATE orgs SET outcomes_since = now() - make_interval(days => $1) WHERE id = 'default'`, [days]);

/** One branch's scan of the pull requests named, none of them found in the history. */
const scanOf = (repo: string, numbers: number[], commits: unknown[], more: Record<string, unknown> = {}) =>
  call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", scanned_until: ago(0), pulls: numbers.map((number) => ({ number, found: false })), commits, ...more });

test("a commit that removes many lines is walked in time linear in them, and a scan past the limits is refused", async () => {
  await readingSince();
  const repo = "github.com/acme/large";
  assert.equal((await merged(repo, 1, 5, [file("a.ts", ...Array.from({ length: 20_000 }, (_, i) => i + 1))])).status, 200);
  // 100,000 lines of nobody's in the pull request, and two of its own.
  const removed = [1, 2, ...Array.from({ length: 100_000 }, (_, i) => 1_000_000 + i)];
  const started = performance.now();
  const put = await scanOf(repo, [1], [commit(1, ago(4), [{ path: "a.ts", removed }])]);
  const took = performance.now() - started;
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.stored.map((s: any) => s.sha), [sha(1)]);
  assert.ok(took < 5_000, `took ${Math.round(took)} ms`);
  // A commit of more lines than a whole reading has, or a scan of more in all, is not kept.
  const big = Array.from({ length: MOST_LINES_A_COMMIT + 1 }, (_, i) => h(i));
  assert.equal((await scanOf(repo, [1], [{ ...commit(2, ago(3), []), files: [{ path: "a.ts", removed: big.slice(0, 1000), added: big.slice(1000) }] }])).status, 422);
  const each = Array.from({ length: Math.ceil(MOST_LINES / 4) + 1 }, (_, i) => h(i));
  const many = [3, 4, 5, 6].map((n) => ({ ...commit(n, ago(3), []), files: [{ path: "a.ts", removed: each, added: [] }] }));
  assert.throws(() => checkOutcomes({ repo, base_ref: "main", scanned_until: ago(0), pulls: [], commits: many }), BadReport);
  const [row] = await db.query(`SELECT count(*)::int AS n FROM pull_outcome_commits WHERE repo = $1`, [repo]);
  assert.equal(row!.n, 1);
});

test("a revert subject that takes all the agents' lines still there is a revert, whatever a person added elsewhere", async () => {
  await readingSince();
  const repo = "github.com/acme/r3";
  assert.equal((await upload(repo, "r3-s", "claude-code", [file("a.ts", 1, 2, 3, 4)])).status, 200);
  // Four agent lines in a.ts, and twenty of a person's in h.ts, which is never read.
  await merged(repo, 1, 5, [file("a.ts", 1, 2, 3, 4), file("h.ts", ...Array.from({ length: 20 }, (_, i) => 100 + i))]);
  const due = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${encodeURIComponent(repo)}`)).body;
  assert.deepEqual(due.branches[0].pulls[0].paths, ["a.ts"]);
  const put = await scanOf(repo, [1], [commit(1, ago(4), [{ path: "a.ts", removed: [1, 2, 3, 4] }], { signals: ["revert_subject"] })]);
  assert.deepEqual(put.body.stored.map((s: any) => s.kind), ["revert"]);
  const page = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body;
  assert.deepEqual(page.outcomes.commits[0].signals, ["revert_bulk"]);
});

test("lines three sessions wrote in a file are common: a commit that removes only those counts nowhere", async () => {
  await readingSince();
  const repo = "github.com/acme/common";
  // Three sessions add the same two lines to a.ts; the latest also writes 5 and 6, and so has them all.
  assert.equal((await upload(repo, "c-1", "claude-code", [file("a.ts", 1, 2)], 50)).status, 200);
  assert.equal((await upload(repo, "c-2", "claude-code", [file("a.ts", 1, 2)], 40)).status, 200);
  assert.equal((await upload(repo, "c-3", "claude-code", [file("a.ts", 1, 2, 5, 6)], 30)).status, 200);
  await merged(repo, 1, 5, [file("a.ts", 1, 2, 5, 6)]);
  const put = await scanOf(repo, [1], [commit(1, ago(4), [{ path: "a.ts", removed: [1, 2] }]), commit(2, ago(3), [{ path: "a.ts", removed: [5, 6] }])]);
  assert.equal(put.status, 200);
  const page = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body;
  assert.deepEqual(page.outcomes.commits.map((c: any) => [c.sha, c.agent_lines, c.counted]), [[sha(1), 2, false], [sha(2), 2, true]]);
  assert.equal(page.outcomes.windows["7d"].rework_commits, 1);
});

test("a session matched after its pull request was read has the later commits of its files read from the merge", async () => {
  await readingSince();
  const repo = "github.com/acme/late";
  const q = encodeURIComponent(repo);
  assert.equal((await upload(repo, "late-1", "claude-code", [file("a.ts", 1, 2, 3)])).status, 200);
  await merged(repo, 1, 10, [file("a.ts", 1, 2, 3), file("b.ts", 20, 21, 22), file("c.ts", 30, 31)]);
  const first = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body.branches[0].pulls[0];
  assert.deepEqual(first.paths, ["a.ts"]);
  assert.equal((await scanOf(repo, [1], [])).status, 200);
  // b.ts's lines turn out to be an agent's too: read again from the merge, so a commit there before now counts.
  assert.equal((await upload(repo, "late-2", "codex", [file("b.ts", 20, 21, 22)])).status, 200);
  const again = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body.branches[0].pulls[0];
  assert.deepEqual([again.paths, again.since], [["a.ts", "b.ts"], first.merged_at]);
  const put = await scanOf(repo, [1], [commit(1, ago(5), [{ path: "b.ts", removed: [20, 21] }])]);
  assert.deepEqual(put.body.stored.map((s: any) => [s.sha, s.kind]), [[sha(1), "rework"]]);
  // Read up to some commits, and then matched with a file new to it: those say nothing of the new file.
  assert.equal((await scanOf(repo, [1], [], { pulls: [{ number: 1, found: true, from: null, tips: [sha(70)] }] })).status, 200);
  assert.equal((await upload(repo, "late-3", "cursor", [file("c.ts", 30, 31)])).status, 200);
  const third = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body.branches[0].pulls[0];
  assert.deepEqual([third.paths, third.since, third.tips], [["a.ts", "b.ts", "c.ts"], first.merged_at, null]);
  // Matched again with nothing new, it is not read again.
  assert.equal((await scanOf(repo, [1], [])).status, 200);
  assert.equal((await call(tokens.admin, "POST", "/prs/match", { repo, number: 1 })).status, 200);
  const [row] = await db.query(`SELECT outcomes_scanned_until IS NOT NULL AS read FROM pull_requests WHERE repo = $1`, [repo]);
  assert.equal(row!.read, true);
});

test("a pull request's page and the summary split many removed lines quickly", async () => {
  await readingSince();
  const repo = "github.com/acme/split";
  const hashes = Array.from({ length: 30_000 }, (_, i) => h(i + 1));
  assert.equal((await upload(repo, "big", "claude-code", [{ path: "a.ts", hashes }])).status, 200);
  await merged(repo, 1, 5, [{ path: "a.ts", hashes }]);
  const put = await scanOf(repo, [1], [{ ...commit(1, ago(4.5), [], { signals: ["revert_subject"] }), files: [{ path: "a.ts", removed: hashes, added: [] }] }]);
  assert.deepEqual(put.body.stored.map((s: any) => s.kind), ["revert"]);
  const started = performance.now();
  const page = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body;
  const summary = (await call(tokens.admin, "GET", `/prs/outcomes/summary?by=tool&repo=${encodeURIComponent("acme/split")}`)).body;
  const took = performance.now() - started;
  assert.equal(page.outcomes.commits[0].agent_lines, 30_000);
  assert.equal(summary.total.outcomes_1d.agent_lines_reverted, 30_000);
  assert.ok(took < 3_000, `took ${Math.round(took)} ms`);
});

test("a commit that changed two pull requests' lines counts once in the total, and so does the session it fixed", async () => {
  await readingSince();
  const repo = "github.com/acme/twice";
  assert.equal((await upload(repo, "tw-1", "codex", [file("a.ts", 1, 2, 3), file("b.ts", 7, 8, 9)])).status, 200);
  await merged(repo, 1, 10, [file("a.ts", 1, 2, 3)]);
  await merged(repo, 2, 9, [file("b.ts", 7, 8, 9)]);
  const put = await scanOf(repo, [1, 2], [commit(77, ago(8), [{ path: "a.ts", removed: [1, 2] }, { path: "b.ts", removed: [7, 8] }], { signals: ["fix_message"] })]);
  assert.equal(put.body.stored.length, 2);
  const summary = (await call(tokens.admin, "GET", `/prs/outcomes/summary?by=tool&repo=${encodeURIComponent("acme/twice")}`)).body;
  const pick = (at: any) => [at.pulls_reached, at.fix_commits, at.likely_fix_commits, at.sessions_fixed, at.agent_lines_fixed];
  assert.deepEqual(pick(summary.total.outcomes_7d), [2, 1, 1, 1, 4]);
  assert.deepEqual(pick(summary.groups[0].outcomes_7d), [2, 1, 1, 1, 4]);
});

test("pull requests that can never be read are not among those to reach", async () => {
  const repo = "github.com/acme/unread";
  await readingSince(20);
  assert.equal((await upload(repo, "un-1", "codex", [file("a.ts", 1, 2, 3)])).status, 200);
  await merged(repo, 1, 10, [file("a.ts", 1, 2, 3)]);
  // Merged before the server began reading them, and never read; and with no base branch.
  await merged(repo, 2, 40, [file("a.ts", 1, 2, 3)]);
  await merged(repo, 3, 5, [file("a.ts", 1, 2, 3)], { base_ref: null });
  assert.equal((await scanOf(repo, [1], [])).status, 200);
  const total = (await call(tokens.admin, "GET", `/prs/outcomes/summary?by=tool&repo=${encodeURIComponent("acme/unread")}`)).body.total;
  assert.deepEqual([total.outcomes_7d.pulls_reached, total.outcomes_7d.pulls_total], [1, 1]);
  // One read from before, when the Action was asked to, is among them.
  await db.query(`UPDATE pull_requests SET outcomes_scanned_until = merged_at + interval '30 days' WHERE repo = $1 AND number = 2`, [repo]);
  const after = (await call(tokens.admin, "GET", `/prs/outcomes/summary?by=tool&repo=${encodeURIComponent("acme/unread")}`)).body.total;
  assert.deepEqual([after.outcomes_7d.pulls_reached, after.outcomes_7d.pulls_total], [2, 2]);
});

test("a ci token reaches only the pull request routes, whatever a path ends with", async () => {
  const body = {
    schema_version: 1,
    session: { schema_version: 1, source: "prs", machine_id: "m", session_id: "outcomes", content: "metadata", started_at: ago(3), repo: { root: "~/x", remote: "github.com/acme/x" }, models: ["m"] },
    rewrite: null,
    lines: [{ path: "a.ts", hashes: [h(1), h(2)], model: null }],
  };
  assert.equal((await call(tokens.ci, "PUT", "/sessions/m/prs/outcomes", body)).status, 403);
  assert.equal((await call(tokens.ci, "PUT", "/sessions/m/prs/ping", { ...body, session: { ...body.session, session_id: "ping" } })).status, 403);
  assert.equal((await call(tokens.ci, "GET", "/sessions/m/prs/due")).status, 403);
  const [kept] = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE source = 'prs'`);
  assert.equal(kept!.n, 0);
  assert.equal((await call(tokens.ci, "GET", "/ping")).status, 200);
  assert.equal((await call(tokens.ci, "GET", "/prs/outcomes/due?repo=github.com/acme/x")).status, 200);
});

test("a file named like an object's own property is walked like any other", async () => {
  await readingSince();
  const repo = "github.com/acme/proto";
  assert.equal((await upload(repo, "pr-1", "codex", [file("constructor", 1, 2, 3), file("__proto__", 4, 5, 6)])).status, 200);
  await merged(repo, 1, 10, [file("constructor", 1, 2, 3), file("__proto__", 4, 5, 6)]);
  await merged(repo, 2, 9, [file("constructor", 1, 2, 3)]);
  const put = await scanOf(repo, [1, 2], [commit(5, ago(8), [{ path: "constructor", removed: [1, 2] }, { path: "__proto__", removed: [4, 5] }])]);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.stored.map((s: any) => s.number), [1, 2]);
  const page = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body;
  assert.deepEqual(page.outcomes.commits.map((c: any) => [c.lines, c.agent_lines, c.counted]), [[4, 4, true]]);
  const [row] = await db.query(`SELECT removed FROM pull_outcome_commits WHERE repo = $1 AND number = 1`, [repo]);
  assert.deepEqual(Object.keys(row!.removed as object).sort(), ["__proto__", "constructor"]);
});

test("pull request numbers, names and paths too large to keep are refused before anything is kept", async () => {
  await readingSince();
  const repo = "github.com/acme/big";
  assert.equal((await upload(repo, "b-s", "claude-code", [file("a.ts", 1, 2, 3)])).status, 200);
  await merged(repo, 1, 5, [file("a.ts", 1, 2, 3)]);
  const removing = [commit(1, ago(4), [{ path: "a.ts", removed: [1, 2, 3] }])];
  const refused = async (body: Record<string, unknown>) => {
    const put = await call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", scanned_until: ago(0), pulls: [{ number: 1, found: false }], commits: removing, ...body });
    assert.equal(put.status, 422, JSON.stringify(body).slice(0, 200));
  };
  await refused({ pulls: [{ number: 1, found: false }, { number: 2 ** 31, found: false }] });
  await refused({ commits: [{ ...removing[0], pulls: [2 ** 33] }] });
  await refused({ commits: [{ ...removing[0], after: [2 ** 31] }] });
  await refused({ commits: [{ ...removing[0], reverts: { shas: [], pulls: [2 ** 31] } }] });
  await refused({ base_ref: "b".repeat(2000) });
  await refused({ repo: `github.com/acme/${"x".repeat(2000)}` });
  await refused({ commits: [commit(1, ago(4), [{ path: `${"d/".repeat(3000)}a.ts`, removed: [1, 2] }])] });
  await refused({ commits: [commit(1, ago(4), [], { moves: [{ from: "a.ts", to: "z".repeat(5000), hashes: [h(1)] }] })] });
  const [row] = await db.query(`SELECT outcomes_scanned_until FROM pull_requests WHERE repo = $1`, [repo]);
  assert.equal(row!.outcomes_scanned_until, null);
  assert.deepEqual(await db.query(`SELECT 1 FROM pull_outcome_commits WHERE repo = $1`, [repo]), []);
});

test("a scan said to reach past now is read up to now, and an older one ending later leaves the newer tip", async () => {
  await readingSince();
  const repo = "github.com/acme/future";
  const q = encodeURIComponent(repo);
  assert.equal((await upload(repo, "f-s", "claude-code", [file("a.ts", 1, 2, 3)])).status, 200);
  await merged(repo, 1, 2, [file("a.ts", 1, 2, 3)]);
  const future = new Date(Date.now() + 40 * 86_400_000).toISOString();
  const put = await scanOf(repo, [1], [], { scanned_until: future, tip: sha(500) });
  assert.equal(put.status, 200);
  assert.ok(Date.parse(put.body.scanned_until) <= Date.now());
  const due = (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body;
  assert.deepEqual(due.branches.map((b: any) => b.pulls.map((p: any) => p.number)), [[1]]);
  // A commit that lands after, sent then, counts.
  const later = new Date(Date.parse(put.body.scanned_until) + 1).toISOString();
  const next = await scanOf(repo, [1], [commit(9, later, [{ path: "a.ts", removed: [1, 2, 3] }])], { tip: sha(501) });
  assert.deepEqual(next.body.stored.map((s: any) => s.sha), [sha(9)]);
  // A run that read less, and finished after, says nothing of the tip.
  assert.equal((await scanOf(repo, [1], [], { scanned_until: ago(1), tip: sha(400) })).status, 200);
  const [scan] = await db.query(`SELECT tip FROM repo_outcome_scans WHERE repo = $1`, [repo]);
  assert.equal(scan!.tip, sha(501));
});

test("a later commit's link is to the repository's own commit, whatever was sent", async () => {
  await readingSince();
  const repo = "github.com/acme/link";
  assert.equal((await upload(repo, "l-s", "claude-code", [file("a.ts", 1, 2, 3)])).status, 200);
  await merged(repo, 1, 5, [file("a.ts", 1, 2, 3)]);
  await scanOf(repo, [1], [commit(1, ago(4), [{ path: "a.ts", removed: [1, 2] }], { url: "https://evil.example/phish" })]);
  const page = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body;
  assert.equal(page.outcomes.commits[0].url, `https://github.com/acme/link/commit/${sha(1)}`);
});

test("a scan reads each pull request on from the commits it was read up to, unless another run moved it meanwhile", async () => {
  await readingSince();
  const repo = "github.com/acme/tips";
  const q = encodeURIComponent(repo);
  assert.equal((await upload(repo, "t-1", "claude-code", [file("a.ts", 1, 2, 3, 4, 5, 6)])).status, 200);
  await merged(repo, 1, 10, [file("a.ts", 1, 2, 3, 4, 5, 6)]);
  const tipsDue = async () => (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body.branches[0].pulls[0].tips;
  assert.equal(await tipsDue(), null);
  const read = (from: unknown, tips: unknown, commits: unknown[] = []) =>
    call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", scanned_until: ago(0), pulls: [{ number: 1, found: true, from, tips }], commits });
  // Read by time the first time, its tips are kept.
  assert.equal((await read(null, [sha(80), sha(81), sha(80)])).status, 200);
  assert.deepEqual((await tipsDue()).sort(), [sha(80), sha(81)]);
  const [before] = await db.query<{ outcomes_scanned_until: unknown }>(`SELECT outcomes_scanned_until FROM pull_requests WHERE repo = $1`, [repo]);
  const landed = new Date(new Date(before!.outcomes_scanned_until as string).getTime() + 1).toISOString();
  // A run that began from others leaves it as it is: no commit walked, how far it was read unchanged.
  const stale = await read([sha(70)], [sha(90)], [commit(1, landed, [{ path: "a.ts", removed: [1, 2] }], { after: [1] })]);
  assert.deepEqual(stale.body.stored, []);
  const [still] = await db.query(`SELECT outcomes_scanned_until FROM pull_requests WHERE repo = $1`, [repo]);
  assert.deepEqual(still!.outcomes_scanned_until, before!.outcomes_scanned_until);
  assert.deepEqual((await tipsDue()).sort(), [sha(80), sha(81)]);
  // One from the tips it has now goes on, in any order; and an Action that says nothing of tips is not checked.
  const fresh = await read([sha(81), sha(80)], [sha(91)], [commit(2, landed, [{ path: "a.ts", removed: [3, 4] }], { after: [1] })]);
  assert.deepEqual(fresh.body.stored.map((s: any) => s.sha), [sha(2)]);
  assert.deepEqual(await tipsDue(), [sha(91)]);
  const older = await call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", scanned_until: ago(0), pulls: [{ number: 1, found: false }], commits: [] });
  assert.equal(older.status, 200);
  assert.equal(await tipsDue(), null);
  // Tips are commit SHAs, 20 at most.
  assert.equal((await read(null, ["main"])).status, 422);
  assert.equal((await read(Array.from({ length: 21 }, (_, i) => sha(i)), null)).status, 422);
});

test("pull requests merged into branches that are gone are not asked for again, and count nowhere", async () => {
  await readingSince();
  const repo = "github.com/acme/stacked";
  const q = encodeURIComponent(repo);
  assert.equal((await upload(repo, "st-1", "codex", [file("a.ts", 1, 2, 3)])).status, 200);
  for (let n = 1; n <= 50; n += 1) await merged(repo, n, 40 - n * 0.1, [file("a.ts", 1, 2, 3)], { base_ref: `feature/stack-${n}` });
  await merged(repo, 99, 3, [file("a.ts", 1, 2, 3)]);
  const bases = async () => (await call(tokens.ci, "GET", `/prs/outcomes/due?repo=${q}`)).body.branches.map((b: any) => b.base_ref);
  const first = await bases();
  assert.equal(first.length, 50);
  assert.ok(!first.includes("main"));
  for (const base of first) {
    const n = Number(base.slice("feature/stack-".length));
    // (One named for another branch than its own is left as it is.)
    const sent = await call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: base, tip: null, scanned_until: ago(0), pulls: [], commits: [], gone: [n, 99] });
    assert.deepEqual(sent.body.stored, []);
  }
  assert.deepEqual(await bases(), ["main"]);
  const rows = await db.query(`SELECT number, outcomes_scanned_until, outcomes_gone_at IS NOT NULL AS gone FROM pull_requests WHERE repo = $1 ORDER BY number`, [repo]);
  assert.deepEqual(rows.map((r: any) => [r.number, r.outcomes_scanned_until, r.gone]).slice(-2), [[50, null, true], [99, null, false]]);
  const total = (await call(tokens.admin, "GET", `/prs/outcomes/summary?by=tool&repo=${encodeURIComponent("acme/stacked")}`)).body.total;
  assert.equal(total.outcomes_1d.pulls_total, 1);
  assert.equal((await call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", scanned_until: ago(0), pulls: [], commits: [], gone: [2 ** 31] })).status, 422);
});
