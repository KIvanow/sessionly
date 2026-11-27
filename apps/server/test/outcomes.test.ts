import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { classify } from "../src/outcomes.ts";
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

function upload(repo: string, id: string, source: string, lines: { path: string; hashes: string[] }[]) {
  const body = {
    schema_version: 1,
    session: {
      schema_version: 1,
      source,
      machine_id: "m1",
      session_id: id,
      content: "metadata",
      started_at: ago(60),
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
  assert.deepEqual(classify({ ...none, reverts: { shas: [sha(44).slice(0, 7)], pulls: [] } }, pull, { lines: 1, before: 10 }), { kind: "revert", signals: ["revert_sha"] });
  assert.deepEqual(classify({ ...none, reverts: { shas: [], pulls: [4] } }, pull, { lines: 1, before: 10 }), { kind: "revert", signals: ["revert_pull"] });
  // a revert subject: only with half the lines still there
  assert.equal(classify({ ...none, signals: ["revert_subject"] }, pull, { lines: 4, before: 10 }).kind, "rework");
  assert.deepEqual(classify({ ...none, signals: ["revert_pr_title"] }, pull, { lines: 5, before: 10 }), { kind: "revert", signals: ["revert_bulk"] });
  assert.deepEqual(classify({ ...none, signals: ["fix_message", "fix_branch"] }, pull, { lines: 2, before: 10 }), { kind: "fix", signals: ["fix_message", "fix_branch"] });
  assert.equal(classify({ ...none, reapply: true, signals: ["revert_subject"], reverts: { shas: [sha(44)], pulls: [4] } }, pull, { lines: 10, before: 10 }).kind, "rework");
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
      pulls: [{ number: 1, merged_at: due.body.branches[0].pulls[0].merged_at, merge_commit_sha: sha(100), since: due.body.branches[0].pulls[0].merged_at, paths: ["a.ts", "b.ts"] }],
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
  // #3 was never read: out of the ones reached, not in them
  assert.deepEqual([summary.total.outcomes_7d.pulls_reached, summary.total.outcomes_7d.pulls_total], [1, 2]);
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
  type Action = {
    scanBranch: (o: Record<string, unknown>) => Promise<Record<string, unknown> & { commits: unknown[] }>;
    chunks: (scan: unknown) => { commits: unknown[]; scanned_until: string }[];
  };
  const action: Action = await import(new URL("../../../action/src/outcomes.mjs", import.meta.url).href);
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
    const api = { request: async () => [], graphql: async () => ({ repository: {} }) };
    const scan = await action.scanBranch({ git: gitIn(dir, spawnSync), api, repo: "acme/real", host: "github.com", branch: branches[0] });
    for (const part of action.chunks(scan)) {
      const sent = await call(tokens.ci, "PUT", "/prs/outcomes", { repo, base_ref: "main", tip: scan.tip, scanned_until: part.scanned_until, pulls: scan.pulls, commits: part.commits });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.deepEqual(sent.body.stored, [{ number: 1, sha: fix, kind: "fix" }]);
    }
    const outcomes = (await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body.outcomes;
    assert.deepEqual(outcomes.commits.map((c: any) => [c.sha, c.kind, c.agent_lines, c.likely, c.signals]), [[fix, "fix", 2, true, ["fix_message"]]]);
    assert.equal(outcomes.windows["1d"].reached, true);
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
