import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import { arrivals, checkCiReport, mergeCiOf, PENDING_DAYS, redOnArrival, stateNow, type HeadRead } from "../src/ci.ts";
import type { Db } from "../src/db.ts";
import { BadReport, checkCi, MOST_HEADS } from "../src/pulls.ts";
import { newOrg, testDb, tokenFor } from "./helpers.ts";

// Hashes are 16 hex digits; these stand for lines.
const h = (n: number) => n.toString(16).padStart(16, "0");
const file = (path: string, ...lines: number[]) => ({ path, hashes: lines.map(h) });
const sha = (n: number) => n.toString(16).padStart(40, "0");
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

let db: Db;
let app: Hono<Env>;
const tokens = { admin: "", ann: "", ci: "", other: "" };
const later: Promise<void>[] = [];

before(async () => {
  db = await testDb();
  app = createApp(db, { background: (work) => void later.push(work) });
  tokens.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" });
  tokens.ann = await tokenFor(db, { email: "ann@example.com", role: "member" });
  tokens.ci = await tokenFor(db, { email: "ci@example.com", role: "ci" });
  await newOrg(db, "other");
  tokens.other = await tokenFor(db, { email: "boss@other.example.com", role: "admin" }, "other");
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
      started_at: ago(30),
      repo: { root: "~/src/web", remote: repo },
      models: [`${source}-model`],
    },
    rewrite: null,
    lines: lines.map((l) => ({ ...l, model: null })),
  };
  return call(tokens.ann, "PUT", `/sessions/m1/${source}/${id}`, body);
}

/** A report of a pull request, open unless `more` says, at a head. */
function report(repo: string, number: number, head: number, files: unknown[], more: Record<string, unknown> = {}) {
  return call(tokens.ci, "PUT", "/prs", {
    repo,
    number,
    title: "Add the parser",
    author: "ann",
    state: "open",
    created_at: ago(5),
    base_ref: "main",
    head_sha: sha(head),
    event: "synchronize",
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

const ci = (n: number, state: string, more: Record<string, unknown> = {}) => ({ sha: sha(n), state, failed: state === "failure" ? 1 : 0, total: 3, cancelled: 0, ...more });

async function headsOf(repo: string, number: number) {
  const rows = await db.query(`SELECT sha, ci_state, ci_failed, failed_checks, hashes FROM pull_heads WHERE repo = $1 AND number = $2 ORDER BY first_reported_at, sha`, [repo, number]);
  return rows.map((r) => ({ sha: String(r.sha), state: r.ci_state, failed: r.ci_failed == null ? null : Number(r.ci_failed), names: r.failed_checks ?? null, hashes: r.hashes }));
}

test("what CI says of a commit is checked: its state, counts and at most 20 names of 100 characters", () => {
  const fail = (what: string): never => {
    throw new BadReport(what);
  };
  assert.equal(checkCi(undefined, fail), undefined);
  assert.deepEqual(checkCi([], fail), []);
  assert.deepEqual(checkCi([ci(1, "failure", { failed_checks: ["lint"] }), ci(1, "success")], fail), [{ sha: sha(1), state: "failure", failed: 1, total: 3, cancelled: 0, failed_checks: ["lint"] }]);
  assert.throws(() => checkCi([{ sha: "abc", state: "success" }], fail), /needs a SHA/);
  assert.throws(() => checkCi([ci(1, "red")], fail), /state must be one of/);
  assert.throws(() => checkCi([ci(1, "failure", { failed: -1 })], fail), /whole number/);
  assert.throws(() => checkCi([ci(1, "failure", { total: 1.5 })], fail), /whole number/);
  assert.throws(() => checkCi([ci(1, "failure", { failed_checks: Array(21).fill("x") })], fail), /at most 20 names/);
  assert.throws(() => checkCi([ci(1, "failure", { failed_checks: ["x".repeat(101)] })], fail), /100 characters/);
  assert.throws(() => checkCi(Array(21).fill(ci(1, "success")), fail), /at most 20 commits/);
  // the report of CI alone: by pull request, up to 100, a commit once with each
  const checked = checkCiReport({ repo: "github.com/acme/web/", heads: [{ number: 1, ...ci(1, "success") }, { number: 2, ...ci(1, "success") }, { number: 1, ...ci(1, "failure") }] });
  assert.deepEqual(checked, { repo: "github.com/acme/web", heads: [{ number: 1, ...ci(1, "success") }, { number: 2, ...ci(1, "success") }], merges: [] });
  assert.throws(() => checkCiReport({ repo: "r", heads: [ci(1, "success")] }), /needs a pull request number/);
  assert.throws(() => checkCiReport({ repo: "r", merges: Array(101).fill({ number: 1, ...ci(1, "success") }) }), /at most 100 commits/);
  assert.throws(() => checkCiReport({ heads: [] }), /repo is required/);
});

test("where a session's lines arrived is the first head that brought one of them, copies as the last to come, and red only where that head's CI is known red", () => {
  const heads: HeadRead[] = [
    { sha: sha(1), first_reported_at: 0, state: "failure" as const, hashes: { "a.ts": [h(1), h(2), h(50)] } },
    { sha: sha(2), first_reported_at: 1, state: "success" as const, hashes: { "a.ts": [h(3), h(50)], "b.ts": [h(1)] } },
    { sha: sha(3), first_reported_at: 2, state: "pending" as const, hashes: { "a.ts": [h(4)] } },
    { sha: sha(4), first_reported_at: 3, state: "none" as const, hashes: { "a.ts": [h(5)] } },
    { sha: sha(5), first_reported_at: 4, state: "unknown" as const, hashes: { "a.ts": [h(6)] } },
  ];
  const at = arrivals(heads);
  assert.deepEqual(at.get(`a.ts\n${h(50)}`), [0, 1]);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(3), h(1)] }), true);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(3)] }), false);
  // the same hash in another file arrived with the second head
  assert.equal(redOnArrival(heads, at, { "b.ts": [h(1)] }), false);
  // a line the pull request has two copies of, one red, one green: a session with one copy has the later one;
  // with both, the earlier too
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(3), h(50)] }), false);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(50), h(50)] }), true);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(50), h(50), h(50)] }), true);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(4)] }), null);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(5)] }), null);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(6)] }), null);
  assert.equal(redOnArrival(heads, at, { "a.ts": [h(9)] }), null);
  assert.equal(redOnArrival(heads, at, null), null);
  // a head no run has read is not known, whatever its age; one read as pending has none after 7 days
  const day = 86_400_000;
  assert.equal(stateNow("pending", 0, PENDING_DAYS * day - 1, 10), "pending");
  assert.equal(stateNow("pending", 0, PENDING_DAYS * day, 10), "none");
  assert.equal(stateNow("pending", 0, PENDING_DAYS * day, null), "unknown");
  assert.equal(stateNow("pending", 0, 0, null), "unknown");
  assert.equal(stateNow("failure", 0, PENDING_DAYS * day, 10), "failure");
  // a merge read as pending likewise, read as the page reads it
  assert.equal(mergeCiOf({ state: "pending" }, 0, PENDING_DAYS * day - 1)!.state, "pending");
  assert.equal(mergeCiOf({ state: "pending" }, 0, PENDING_DAYS * day)!.state, "none");
  assert.equal(mergeCiOf({ state: "pending" }, null, PENDING_DAYS * day)!.state, "pending");
  assert.equal(mergeCiOf(null, 0, 0), null);
});

test("a report keeps the head it is at with the lines new there, answers which heads are pending, and takes what CI said", async () => {
  const repo = "github.com/acme/heads";
  // Pushed twice: the second head adds a line to a.ts and a file; the same head reported again is no new head.
  const first = await report(repo, 1, 1, [file("a.ts", 1, 2, 2)]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.ci_pending, [{ number: 1, sha: sha(1) }]);
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2, 2, 3, 50), file("b.ts", 1)], { event: "synchronize" })).status, 200);
  const again = await report(repo, 1, 2, [file("a.ts", 1, 2, 2, 3, 50), file("b.ts", 1)], { event: "review" });
  assert.deepEqual(again.body.ci_pending, [{ number: 1, sha: sha(1) }, { number: 1, sha: sha(2) }]);
  assert.deepEqual(await headsOf(repo, 1), [
    { sha: sha(1), state: "pending", failed: null, names: null, hashes: { "a.ts": [h(1), h(2), h(2)] } },
    { sha: sha(2), state: "pending", failed: null, names: null, hashes: { "a.ts": [h(3), h(50)], "b.ts": [h(1)] } },
  ]);
  // Not read yet, which is not running: the page is told so, however old the head.
  const page = await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`);
  assert.deepEqual(page.body.heads.map((x: any) => [x.sha, x.ci.state, x.ci.checked_at]), [[sha(1), "unknown", null], [sha(2), "unknown", null]]);
  await db.query(`UPDATE pull_heads SET first_reported_at = now() - interval '9 days' WHERE repo = $1 AND number = 1 AND sha = $2`, [repo, sha(1)]);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${encodeURIComponent(repo)}&number=1`)).body.heads[0].ci.state, "unknown");
  await db.query(`UPDATE pull_heads SET first_reported_at = now() - interval '1 hour' WHERE repo = $1 AND number = 1 AND sha = $2`, [repo, sha(1)]);
  // What CI said comes with a report, and is applied to its heads; a commit that is no head of it is passed over.
  const told = await report(repo, 1, 2, [file("a.ts", 1, 2, 2, 3), file("b.ts", 1)], {
    event: "review",
    ci: [ci(1, "failure", { failed_checks: ["lint", "tests"] }), ci(2, "success", { failed_checks: ["ignored: not a failure"] }), ci(9, "failure")],
  });
  assert.deepEqual(told.body.ci_pending, []);
  assert.deepEqual((await headsOf(repo, 1)).map((x) => [x.sha, x.state, x.failed, x.names]), [[sha(1), "failure", 1, ["lint", "tests"]], [sha(2), "success", 0, null]]);
  // A report without `ci` says nothing of it: what is kept stays.
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2, 2, 3), file("b.ts", 1)], { event: "review" })).status, 200);
  assert.deepEqual((await headsOf(repo, 1)).map((x) => x.state), ["failure", "success"]);
  // One that is no SHA is refused with the report.
  assert.equal((await report(repo, 1, 2, [], { ci: [{ sha: "x", state: "success" }] })).status, 422);
  // A report from an Action that names no head keeps none; the first head known after has every line.
  assert.equal((await report(repo, 2, 0, [file("a.ts", 7)], { head_sha: undefined })).status, 200);
  assert.deepEqual(await headsOf(repo, 2), []);
  assert.equal((await report(repo, 2, 5, [file("a.ts", 7, 8)])).status, 200);
  assert.deepEqual((await headsOf(repo, 2)).map((x) => x.hashes), [{ "a.ts": [h(7), h(8)] }]);
});

test("no more than 100 heads are kept for a pull request: the oldest go", async () => {
  const repo = "github.com/acme/many-heads";
  for (let i = 1; i <= MOST_HEADS + 3; i += 1) {
    await db.query(
      `INSERT INTO pull_requests (org_id, repo, number, author, state, created_at, last_event, first_event, first_files, last_files, attribution)
       VALUES ('default', $1, 1, 'ann', 'open', now(), 'opened', 'opened', '[]', '[]', '{}') ON CONFLICT DO NOTHING`,
      [repo],
    );
    await db.query(`INSERT INTO pull_heads (org_id, repo, number, sha, first_reported_at, hashes) VALUES ('default', $1, 1, $2, now() - make_interval(mins => $3), '{}')`, [
      repo, sha(1000 + i), MOST_HEADS + 10 - i,
    ]);
  }
  assert.equal((await report(repo, 1, 2000, [file("a.ts", 1)])).status, 200);
  const kept = await headsOf(repo, 1);
  assert.equal(kept.length, MOST_HEADS);
  assert.equal(kept.at(-1)!.sha, sha(2000));
  assert.ok(!kept.some((x) => x.sha === sha(1001)));
});

test("the Action is told which heads and merge commits to read CI for, and what it says is kept where the server knows the commit", async () => {
  const repo = "github.com/acme/ci-due";
  const q = encodeURIComponent(repo);
  assert.equal((await upload(repo, "d-claude", "claude-code", [file("a.ts", 1, 2)])).status, 200);
  // #1 open at two heads; #2 merged with agent lines; #3 merged without; #4 merged, from an Action that named no merge commit.
  assert.equal((await report(repo, 1, 1, [file("a.ts", 1)])).status, 200);
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2)])).status, 200);
  assert.equal((await report(repo, 2, 3, [file("a.ts", 1, 2)], { state: "merged", merged_at: ago(1), merge_commit_sha: sha(30), event: "closed" })).status, 200);
  assert.equal((await report(repo, 3, 4, [file("docs.md", 70)], { state: "merged", merged_at: ago(1), merge_commit_sha: sha(40), event: "closed" })).status, 200);
  assert.equal((await report(repo, 4, 5, [file("a.ts", 1, 2)], { state: "merged", merged_at: ago(2), event: "closed" })).status, 200);
  const due = await call(tokens.ci, "GET", `/prs/ci/due?repo=${q}`);
  assert.equal(due.status, 200);
  assert.deepEqual(due.body, {
    heads: [{ number: 1, sha: sha(1) }, { number: 1, sha: sha(2) }, { number: 2, sha: sha(3) }, { number: 3, sha: sha(4) }, { number: 4, sha: sha(5) }],
    merges: [{ number: 2, sha: sha(30), base_ref: "main" }],
  });
  assert.ok(!JSON.stringify(due.body).includes("hashes"), "no hashes are sent out");
  assert.equal((await call(tokens.ann, "GET", `/prs/ci/due?repo=${q}`)).status, 403);
  assert.equal((await call(tokens.ci, "GET", `/prs/ci/due`)).status, 400);

  // What was read: heads of #1, the merge of #2, and a commit the server does not know, which is passed over.
  const sent = await call(tokens.ci, "PUT", "/prs/ci", {
    repo,
    heads: [{ number: 1, ...ci(1, "failure", { failed_checks: ["tests"] }) }, { number: 1, ...ci(2, "pending") }, { number: 7, ...ci(70, "success") }],
    merges: [{ number: 2, ...ci(30, "failure", { failed: 2, total: 5, cancelled: 1 }) }, { number: 3, ...ci(99, "success") }],
  });
  assert.deepEqual([sent.status, sent.body], [200, { heads: 2, merges: 1 }]);
  assert.deepEqual((await headsOf(repo, 1)).map((x) => [x.state, x.names]), [["failure", ["tests"]], ["pending", null]]);
  const [two] = await db.query(`SELECT merge_ci FROM pull_requests WHERE repo = $1 AND number = 2`, [repo]);
  const kept = typeof two!.merge_ci === "string" ? JSON.parse(two!.merge_ci) : two!.merge_ci;
  assert.deepEqual({ ...kept, checked_at: typeof kept.checked_at }, { state: "failure", failed: 2, total: 5, cancelled: 1, checked_at: "string" });
  // Read once, the merge is not due again; the head still pending is.
  const left = await call(tokens.ci, "GET", `/prs/ci/due?repo=${q}`);
  assert.deepEqual(left.body.merges, []);
  assert.ok(left.body.heads.some((x: any) => x.sha === sha(2)) && !left.body.heads.some((x: any) => x.sha === sha(1)));
  // A state that came out one way is not put back to pending, head or merge; success over failure is (a re-run, or a
  // read that left out what it should not have), and failure over success.
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs/ci", { repo, heads: [{ number: 1, ...ci(1, "pending") }], merges: [{ number: 2, ...ci(30, "pending") }] })).body, { heads: 0, merges: 0 });
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs/ci", { repo, heads: [{ number: 1, ...ci(1, "success") }], merges: [{ number: 2, ...ci(30, "success") }] })).body, { heads: 1, merges: 1 });
  assert.deepEqual((await headsOf(repo, 1)).map((x) => [x.state, x.names]), [["success", null], ["pending", null]]);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=2`)).body.merge_ci.state, "success");
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs/ci", { repo, merges: [{ number: 2, ...ci(30, "failure") }] })).body, { heads: 0, merges: 1 });
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=2`)).body.merge_ci.state, "failure");
  // Read as none to go by (workflows that started late), a merge is replaced by what comes out.
  await db.query(`UPDATE pull_requests SET merge_ci = NULL WHERE repo = $1 AND number = 2`, [repo]);
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs/ci", { repo, merges: [{ number: 2, ...ci(30, "none", { total: 0 }) }] })).body, { heads: 0, merges: 1 });
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs/ci", { repo, merges: [{ number: 2, ...ci(30, "failure") }] })).body, { heads: 0, merges: 1 });
  // A merge commit with nothing to go by is known as such, and not due again; a head read as pending 7 days ago likewise.
  assert.deepEqual((await call(tokens.ci, "PUT", "/prs/ci", { repo, merges: [{ number: 2, ...ci(30, "none", { total: 0 }) }] })).body, { heads: 0, merges: 1 });
  await db.query(`UPDATE pull_heads SET first_reported_at = now() - interval '8 days' WHERE repo = $1 AND number = 1 AND sha = $2`, [repo, sha(2)]);
  // One that old no run has read is not due either, and stays as it is: not known, rather than none to go by.
  await db.query(`UPDATE pull_heads SET first_reported_at = now() - interval '8 days' WHERE repo = $1 AND number = 3`, [repo]);
  const aged = await call(tokens.ci, "GET", `/prs/ci/due?repo=${q}`);
  assert.deepEqual(aged.body.heads.map((x: any) => x.number), [2, 4]);
  assert.deepEqual((await headsOf(repo, 1)).map((x) => [x.sha, x.state]), [[sha(2), "none"], [sha(1), "success"]]);
  assert.deepEqual((await headsOf(repo, 3)).map((x) => x.state), ["pending"]);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=3`)).body.heads[0].ci.state, "unknown");
  // Refused as a whole when any of it is wrong, and by a member.
  assert.equal((await call(tokens.ci, "PUT", "/prs/ci", { repo, heads: [{ number: 1, ...ci(1, "red") }] })).status, 422);
  assert.equal((await call(tokens.ci, "PUT", "/prs/ci", { repo, heads: [{ number: 1, ...ci(1, "failure", { failed_checks: Array(21).fill("x") }) }] })).status, 422);
  assert.equal((await call(tokens.ann, "PUT", "/prs/ci", { repo, heads: [] })).status, 403);
  // Another organisation sees none of it.
  assert.deepEqual((await call(tokens.other, "GET", `/prs/ci/due?repo=${q}`)).body, { heads: [], merges: [] });
  assert.deepEqual((await call(tokens.other, "PUT", "/prs/ci", { repo, heads: [{ number: 1, ...ci(1, "failure") }] })).body, { heads: 0, merges: 0 });
});

test("a pull request's page says what CI said of each head and of the merge, and for each session whether it was red where its lines arrived", async () => {
  const repo = "github.com/acme/arrival";
  const q = encodeURIComponent(repo);
  assert.equal((await upload(repo, "a-claude", "claude-code", [file("a.ts", 1, 2)])).status, 200);
  // Head 1 brings Claude Code's lines; CI is red there. Head 2 brings the lines of a session uploaded only after; green.
  assert.equal((await report(repo, 1, 1, [file("a.ts", 1, 2, 9)], { event: "opened" })).status, 200);
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2, 9), file("b.ts", 10, 11)], { ci: [ci(1, "failure", { failed_checks: ["tests"] })] })).status, 200);
  // Matched after the push: its lines arrived with head 2 all the same.
  assert.equal((await upload(repo, "a-cursor", "cursor", [file("b.ts", 10, 11)])).status, 200);
  const before = await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.heads.map((x: any) => [x.sha, x.ci.state, x.ci.failed, x.ci.failed_checks ?? null]), [[sha(1), "failure", 1, ["tests"]], [sha(2), "unknown", null, null]]);
  assert.equal(before.body.merge_ci, null);
  const arrived = (page: any) => Object.fromEntries(page.sessions.map((s: any) => [s.session_id, s.red_on_arrival]));
  assert.deepEqual(arrived(before.body), { "a-claude": true, "a-cursor": null });
  assert.equal((await call(tokens.ci, "PUT", "/prs/ci", { repo, heads: [{ number: 1, ...ci(2, "success") }] })).status, 200);
  assert.deepEqual(arrived((await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`)).body), { "a-claude": true, "a-cursor": false });
  // Merged: the merge commit's CI, when read, is on the page too.
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2, 9), file("b.ts", 10, 11)], { state: "merged", merged_at: ago(0), merge_commit_sha: sha(20), event: "closed", ci: [ci(20, "failure")] })).status, 200);
  const merged = await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`);
  assert.deepEqual({ ...merged.body.merge_ci, checked_at: typeof merged.body.merge_ci.checked_at }, { state: "failure", failed: 1, total: 3, cancelled: 0, checked_at: "string" });
  assert.equal(merged.body.merge_commit_sha, sha(20));
  // One read as pending 7 days after merging has none, on the page as on the schedule.
  await db.query(`UPDATE pull_requests SET merge_ci = '{"state": "pending"}', merged_at = now() - interval '8 days' WHERE repo = $1 AND number = 1`, [repo]);
  assert.equal((await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`)).body.merge_ci.state, "none");
  await db.query(`UPDATE pull_requests SET merge_ci = '{"state": "failure", "failed": 1, "total": 3, "cancelled": 0}', merged_at = now() WHERE repo = $1 AND number = 1`, [repo]);
  assert.ok(!JSON.stringify(merged.body.heads).includes("hashes"), "no hashes on the page");
  // A session deleted takes its arrival with it; the heads stay.
  assert.equal((await call(tokens.ann, "DELETE", "/sessions/m1/cursor/a-cursor")).status, 200);
  const fewer = await call(tokens.admin, "GET", `/prs/detail?repo=${q}&number=1`);
  assert.deepEqual(arrived(fewer.body), { "a-claude": true, "a-cursor": null });
  assert.equal(fewer.body.heads.length, 2);
});

test("the summary counts red pushes, sessions red on arrival and base branches red after merging, by group and in all, with CI not known left out", async () => {
  const repo = "github.com/acme/ci-summary";
  const q = encodeURIComponent(repo);
  await db.query(`UPDATE orgs SET outcomes_since = now() - interval '20 days' WHERE id = 'default'`);
  assert.equal((await upload(repo, "s-claude", "claude-code", [file("a.ts", 1, 2, 3)])).status, 200);
  assert.equal((await upload(repo, "s-cursor", "cursor", [file("b.ts", 10, 11)])).status, 200);
  assert.equal((await upload(repo, "s-codex", "codex", [file("c.ts", 20, 21)])).status, 200);
  // #1: Claude Code's lines at a red head, Cursor's at a green one (a copy of one of its lines came red, a person's); merged red.
  assert.equal((await report(repo, 1, 1, [file("a.ts", 1, 2, 3), file("b.ts", 11)], { event: "opened" })).status, 200);
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2, 3), file("b.ts", 10, 11, 11)], { ci: [ci(1, "failure")] })).status, 200);
  assert.equal((await report(repo, 1, 2, [file("a.ts", 1, 2, 3), file("b.ts", 10, 11, 11)], { state: "merged", merged_at: ago(3), merge_commit_sha: sha(100), event: "closed", ci: [ci(2, "success"), ci(100, "failure")] })).status, 200);
  // A head pushed again and never read is not known, and in no figure.
  assert.equal((await report(repo, 1, 5, [file("a.ts", 1, 2, 3), file("b.ts", 10, 11, 11, 12)], { state: "merged", merged_at: ago(3), merge_commit_sha: sha(100), event: "closed" })).status, 200);
  // #2: Codex's lines, a head with nothing to go by, merged with CI not read. #3: no agent lines, which is in no figure.
  assert.equal((await report(repo, 2, 3, [file("c.ts", 20, 21)], { state: "merged", merged_at: ago(2), merge_commit_sha: sha(200), event: "closed", ci: [ci(3, "none", { total: 0 })] })).status, 200);
  assert.equal((await report(repo, 3, 4, [file("docs.md", 70)], { state: "merged", merged_at: ago(2), merge_commit_sha: sha(300), event: "closed", ci: [ci(4, "failure"), ci(300, "failure")] })).status, 200);
  const summary = await call(tokens.admin, "GET", `/prs/outcomes/summary?by=tool&repo=${q}`);
  assert.equal(summary.status, 200);
  const byTool = Object.fromEntries(summary.body.groups.map((g: any) => [g.key, g.ci]));
  assert.deepEqual(byTool, {
    "claude-code": { heads_with_ci: 2, heads_failed: 1, sessions_with_ci: 1, red_on_arrival_sessions: 1, pulls_merge_known: 1, pulls_merge_failed: 1, pulls_ci_unknown: 0 },
    cursor: { heads_with_ci: 2, heads_failed: 1, sessions_with_ci: 1, red_on_arrival_sessions: 0, pulls_merge_known: 1, pulls_merge_failed: 1, pulls_ci_unknown: 0 },
    codex: { heads_with_ci: 0, heads_failed: 0, sessions_with_ci: 0, red_on_arrival_sessions: 0, pulls_merge_known: 0, pulls_merge_failed: 0, pulls_ci_unknown: 1 },
  });
  // In all, #1's heads and merge count once.
  assert.deepEqual(summary.body.total.ci, { heads_with_ci: 2, heads_failed: 1, sessions_with_ci: 2, red_on_arrival_sessions: 1, pulls_merge_known: 1, pulls_merge_failed: 1, pulls_ci_unknown: 1 });
  // The same filtered to one tool.
  const cursor = await call(tokens.admin, "GET", `/prs/outcomes/summary?by=repo&repo=${q}&tool=cursor`);
  assert.deepEqual(cursor.body.total.ci, byTool.cursor);
});

test("a ci token reaches the CI routes and no other, and the summary of CI is for readers", async () => {
  assert.equal((await call(tokens.ci, "GET", "/prs/ci/due?repo=github.com/acme/x")).status, 200);
  assert.equal((await call(tokens.ci, "PUT", "/prs/ci", { repo: "github.com/acme/x", heads: [] })).status, 200);
  assert.equal((await call(tokens.ci, "GET", "/prs/ci/summary")).status, 403);
  assert.equal((await call(tokens.ci, "GET", "/prs/outcomes/summary")).status, 403);
  assert.equal((await call(tokens.ci, "GET", "/prs/detail?repo=x&number=1")).status, 403);
});
