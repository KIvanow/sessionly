import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ciOptions, ciReading, naming, reduceCi, runCi, runWorkflowRun, sayCi } from "../src/ci.mjs";
import { run } from "../src/main.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
// Of another workflow run than this one's (`GITHUB_RUN_ID` 500 below), unless `more` says.
const check = (name, conclusion, more = {}) => ({ id: 1, name, status: conclusion === null ? "in_progress" : "completed", conclusion, details_url: "https://github.com/acme/web/actions/runs/400/job/9", ...more });
const status = (context, state) => ({ context, state });

test("what checks and statuses come to: red on any failure, pending while any waits, none with nothing to go by", () => {
  assert.deepEqual(reduceCi([check("tests", "success"), check("lint", "neutral"), check("docs", "skipped")], []), { state: "success", failed: 0, total: 3, cancelled: 0 });
  assert.deepEqual(reduceCi([check("tests", "failure"), check("lint", "success")], [status("ci/deploy", "success")]), { state: "failure", failed: 1, total: 3, cancelled: 0 });
  assert.equal(reduceCi([check("tests", "timed_out")], []).state, "failure");
  assert.equal(reduceCi([], [status("ci/x", "error")]).state, "failure");
  // one still running, or waiting for someone (a fork's workflows), is pending, and so is a status that is
  assert.equal(reduceCi([check("tests", null), check("lint", "success")], []).state, "pending");
  assert.equal(reduceCi([check("tests", "action_required")], []).state, "pending");
  assert.equal(reduceCi([check("tests", "success")], [status("ci/x", "pending")]).state, "pending");
  // a failure outranks a run still going
  assert.equal(reduceCi([check("tests", "failure"), check("lint", null)], []).state, "failure");
  // nothing at all, or all cancelled (a concurrency group), is none, not red; GitHub's own "pending" for no statuses is not read
  assert.deepEqual(reduceCi([], []), { state: "none", failed: 0, total: 0, cancelled: 0 });
  assert.deepEqual(reduceCi([check("tests", "cancelled"), check("lint", "cancelled"), check("old", "stale")], []), { state: "none", failed: 0, total: 0, cancelled: 2 });
  assert.deepEqual(reduceCi([check("tests", "cancelled"), check("lint", "success")], []), { state: "success", failed: 0, total: 1, cancelled: 1 });
  // a conclusion from after this is neither
  assert.equal(reduceCi([check("tests", "something_new")], []).state, "pending");
});

test("the job's own check run is left out, by its id or failing that by this run's page; ci-ignore and ci-only by name", () => {
  const mine = check("Sessionly", "failure", { id: 77, details_url: "https://github.com/acme/web/actions/runs/123/job/77" });
  const theirs = check("tests", "success", { id: 78, details_url: "https://github.com/acme/web/actions/runs/123/job/78" });
  const other = check("build", "success", { id: 79, details_url: "https://github.com/acme/web/actions/runs/124/job/79" });
  assert.deepEqual(reduceCi([mine, theirs, other], [], { own: { checkRunId: "77", runId: "123" } }), { state: "success", failed: 0, total: 2, cancelled: 0 });
  // without the id, every check run of this workflow run is taken for its own
  assert.deepEqual(reduceCi([mine, theirs, other], [], { own: { checkRunId: "", runId: "123" } }), { state: "success", failed: 0, total: 1, cancelled: 0 });
  // and with neither, nothing is
  assert.equal(reduceCi([mine, theirs], [], { own: { checkRunId: "", runId: "" } }).state, "failure");
  // a run of this run id's prefix is another run
  assert.equal(reduceCi([check("x", "failure", { details_url: "https://github.com/acme/web/actions/runs/1234/job/1" })], [], { own: { checkRunId: "", runId: "123" } }).state, "failure");
  const ignore = naming("*deploy-*, Codecov");
  assert.deepEqual(reduceCi([check("deploy-staging", "failure"), check("codecov", "failure"), check("tests", "success")], [status("ci/deploy-prod", "error")], { ignore }), { state: "success", failed: 0, total: 1, cancelled: 0 });
  const only = naming("tests\nlint");
  assert.deepEqual(reduceCi([check("tests", "success"), check("lint", "success"), check("flaky", "failure")], [], { only }), { state: "success", failed: 0, total: 2, cancelled: 0 });
  assert.equal(naming(""), null);
  assert.equal(naming(" , \n"), null);
  // names only when asked, of the failed, cut to 20 of 100 characters
  const many = Array.from({ length: 25 }, (_, i) => check(`check-${i}-${"x".repeat(120)}`, "failure"));
  assert.equal(reduceCi(many, [], {}).failed_checks, undefined);
  const named = reduceCi(many, [status("ci/late", "failure")], { names: true });
  assert.equal(named.failed_checks.length, 20);
  assert.ok(named.failed_checks.every((name) => name.length === 100));
  assert.deepEqual(reduceCi([check("tests", "success")], [], { names: true }).failed_checks, undefined);
  assert.deepEqual(reduceCi([], [status("ci/x", "failure")], { names: true }).failed_checks, ["ci/x"]);
  const options = ciOptions({ SESSIONLY_CI_IGNORE: "a*", SESSIONLY_CI_CHECK_NAMES: "true", SESSIONLY_CHECK_RUN_ID: " 5 ", GITHUB_RUN_ID: "9" });
  assert.deepEqual([options.ignore("abc"), options.ignore("b"), options.only, options.own, options.names], [true, false, null, { checkRunId: "5", runId: "9" }, true]);
  assert.deepEqual([sayCi({ state: "failure", failed: 1, total: 3 }), sayCi({ state: "none", cancelled: 2 }), sayCi({ state: "none", cancelled: 0 })], ["red (1 of 3 checks failed)", "nothing to go by (2 checks cancelled)", "no checks"]);
});

/** GitHub with check runs and statuses on commits, counted by request; `fail` answers the status asked with. */
function fakeChecks(commits, { fail = {}, remaining } = {}) {
  const calls = [];
  const api = {
    calls,
    get remaining() {
      return remaining;
    },
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      const asked = /\/commits\/([0-9a-f]+)\/(check-runs|status|pulls)(?:\?.*[?&]page=(\d+))?/.exec(path);
      if (!asked) throw new Error(`unexpected ${path}`);
      const [, at, what, page] = asked;
      if (fail[at]) throw Object.assign(new Error(`GitHub answered ${fail[at]} to GET ${path}: no`), { status: fail[at], rateLimited: fail[at] === 429 });
      const commit = commits[at] ?? {};
      if (what === "pulls") return commit.pulls ?? [];
      const list = what === "check-runs" ? (commit.runs ?? []) : (commit.statuses ?? []);
      const from = (Number(page ?? 1) - 1) * 100;
      const batch = list.slice(from, from + 100);
      return what === "check-runs" ? { total_count: list.length, check_runs: batch } : { state: "pending", total_count: list.length, statuses: batch };
    },
  };
  return api;
}

const quiet = () => {};

test("a commit's CI is read past 100 check runs and statuses; 403, 404 and the rate limit leave it unknown, said once", async () => {
  const many = Array.from({ length: 150 }, (_, i) => check(`c${i}`, i === 149 ? "failure" : "success"));
  const api = fakeChecks({ [sha(1)]: { runs: many, statuses: Array.from({ length: 101 }, (_, i) => status(`s${i}`, "success")) }, [sha(2)]: {}, [sha(3)]: {} }, { fail: { [sha(3)]: 404 } });
  const logged = [];
  const reading = ciReading(api, "acme/web", (line) => logged.push(line));
  assert.deepEqual(await reading.of(sha(1)), { sha: sha(1), state: "failure", failed: 1, total: 251, cancelled: 0 });
  assert.deepEqual(api.calls, [
    `GET /repos/acme/web/commits/${sha(1)}/check-runs?filter=latest&per_page=100&page=1`,
    `GET /repos/acme/web/commits/${sha(1)}/check-runs?filter=latest&per_page=100&page=2`,
    `GET /repos/acme/web/commits/${sha(1)}/status?per_page=100&page=1`,
    `GET /repos/acme/web/commits/${sha(1)}/status?per_page=100&page=2`,
  ]);
  // asked once
  await reading.of(sha(1));
  assert.equal(api.calls.length, 4);
  assert.equal((await reading.of(sha(2))).state, "none");
  assert.equal(await reading.of(sha(3)), null);
  assert.equal(await reading.of("nope"), null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /does not know commit 000000000000/);
  // a token that may not read checks: said once, and nothing more is asked
  const refused = fakeChecks({}, { fail: { [sha(4)]: 403 } });
  const said = [];
  const noChecks = ciReading(refused, "acme/web", (line) => said.push(line));
  assert.equal(await noChecks.of(sha(4)), null);
  assert.equal(await noChecks.of(sha(5)), null);
  assert.equal(refused.calls.length, 1);
  assert.deepEqual(said.length, 1);
  assert.match(said[0], /checks: read and statuses: read/);
  // few requests left: nothing is asked
  const low = fakeChecks({ [sha(6)]: {} }, { remaining: 50 });
  const stopped = ciReading(low, "acme/web", quiet);
  assert.equal(await stopped.of(sha(6)), null);
  assert.deepEqual(low.calls, []);
  assert.match(stopped.state.stop, /few more requests/);
});

function environment(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sessionly-ci-"));
  writeFileSync(join(dir, "event.json"), "{}");
  writeFileSync(join(dir, "summary"), "");
  return {
    SESSIONLY_URL: "https://sessionly.example.com/",
    SESSIONLY_TOKEN: "sly_secret",
    SESSIONLY_GITHUB_TOKEN: "gh",
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_EVENT_PATH: join(dir, "event.json"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    GITHUB_RUN_ID: "500",
    ...extra,
  };
}

const PULL = {
  number: 7,
  title: "Add the parser",
  user: { login: "ann" },
  state: "open",
  merged: false,
  created_at: "2026-11-10T10:00:00Z",
  head: { ref: "parser", sha: sha(1), repo: { full_name: "acme/web" } },
  base: { ref: "main", sha: sha(90), repo: { full_name: "acme/web" } },
  merge_commit_sha: sha(2),
};

/** GitHub with one pull request, and checks on its commits. */
function fakePull(pull, commits, more = {}) {
  const checks = fakeChecks(commits, more);
  const request = async (method, path) => {
    if (/\/commits\/[0-9a-f]+\/(check-runs|status|pulls)/.test(path)) return checks.request(method, path);
    checks.calls.push(`${method} ${path}`);
    if (method !== "GET") return {};
    if (path.includes("/issues/") || path.includes("/files") || path.includes("/reviews") || path.includes("/comments")) return [];
    if (path.includes("/commits")) return [{ sha: sha(1), commit: { author: { email: "ann@example.com" }, committer: { email: "ann@example.com" } } }];
    return pull;
  };
  return { request, calls: checks.calls, get remaining() { return checks.remaining; } };
}

test("after a pull request is reported, the CI of its head and of the heads the server says are pending is read and sent in the same run", async () => {
  const api = fakePull(PULL, {
    [sha(1)]: { runs: [check("tests", null, { id: 1 }), check("Sessionly", "success", { id: 77 })] },
    [sha(3)]: { runs: [check("tests", "failure", { id: 2 })] },
  });
  const sent = [];
  const server = async (method, path, body) => (sent.push([method, path, body]), { heads: 2, merges: 0 });
  const deliver = async (url, token, report) => ({ stored: true, attribution: { first: { lines: 0, agent_lines: 0 }, now: { lines: 0, agent_lines: 0, by: [] }, by: [] }, ci_pending: [{ number: 7, sha: sha(3) }, { number: 7, sha: sha(1) }] });
  const logged = [];
  const env = environment({ GITHUB_EVENT_NAME: "pull_request", SESSIONLY_COMMENT: "false", SESSIONLY_CHECK_RUN_ID: "77" });
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ action: "synchronize", pull_request: { number: 7 } }));
  const out = await run(env, { api, deliver, server, log: (line) => logged.push(line) });
  // the head, still running without the Action's own check, and the pending head, red; each once
  assert.deepEqual(sent, [["PUT", "/prs/ci", { repo: "github.com/acme/web", heads: [{ number: 7, sha: sha(1), state: "pending", failed: 0, total: 1, cancelled: 0 }, { number: 7, sha: sha(3), state: "failure", failed: 1, total: 1, cancelled: 0 }], merges: [] }]]);
  assert.deepEqual(out.ci.stored, { heads: 2, merges: 0 });
  assert.ok(logged.includes(`CI at ${sha(3).slice(0, 12)} is red (1 of 1 check failed).`));
  // once merged, the commit it was merged as too
  const merged = fakePull({ ...PULL, state: "closed", merged: true, merged_at: "2026-11-11T10:00:00Z" }, { [sha(1)]: { runs: [check("tests", "success")] }, [sha(2)]: { runs: [check("tests", "failure")] } });
  sent.length = 0;
  await run(env, { api: merged, deliver: async () => ({ attribution: { first: { lines: 0, agent_lines: 0 }, now: { lines: 0, agent_lines: 0, by: [] }, by: [] } }), server, log: quiet });
  assert.deepEqual(sent[0][2].merges, [{ number: 7, sha: sha(2), state: "failure", failed: 1, total: 1, cancelled: 0 }]);
  // with ci off, nothing is read; a server from before this is said, and the report stands
  sent.length = 0;
  const off = await run({ ...env, SESSIONLY_CI: "false" }, { api: fakePull(PULL, {}), deliver, server, log: quiet });
  assert.deepEqual([sent, off.ci], [[], null]);
  const said = [];
  const older = async () => { throw Object.assign(new Error("the Sessionly server answered 404: not found"), { status: 404 }); };
  const stood = await run(env, { api: fakePull(PULL, { [sha(1)]: {} }), deliver, server: older, log: (line) => said.push(line) });
  assert.equal(stood.ci.stored, null);
  assert.ok(said.some((line) => /does not keep what CI said/.test(line)));
  // a server that refuses is a warning, and fails the run only when asked to
  const down = async () => { throw Object.assign(new Error("the Sessionly server answered 503: no"), { status: 503 }); };
  const warned = [];
  assert.equal((await run(env, { api: fakePull(PULL, { [sha(1)]: {} }), deliver, server: down, log: (line) => warned.push(line) })).ci, null);
  assert.ok(warned.some((line) => /::warning title=Sessionly::What CI said of this pull request could not be sent/.test(line)));
  await assert.rejects(run({ ...env, SESSIONLY_FAIL_ON_ERROR: "true" }, { api: fakePull(PULL, { [sha(1)]: {} }), deliver, server: down, log: quiet }), /answered 503/);
});

test("on a schedule, the heads still pending and the merge commits not known yet are read and sent, apart from counting and later commits", async () => {
  const api = fakeChecks({
    [sha(1)]: { runs: [check("tests", "success")] },
    [sha(2)]: { runs: [check("tests", "failure", { name: "tests" })], statuses: [status("ci/deploy", "failure")] },
    [sha(3)]: {},
  }, { fail: { [sha(4)]: 404 } });
  const sent = [];
  const server = async (method, path, body) => {
    if (path.startsWith("/prs/due")) return { due: [] };
    if (path.startsWith("/prs/ci/due")) {
      assert.match(path, /repo=github\.com%2Facme%2Fweb$/);
      return { heads: [{ number: 1, sha: sha(1) }, { number: 2, sha: sha(4) }], merges: [{ number: 1, sha: sha(2) }, { number: 3, sha: sha(3) }] };
    }
    sent.push([method, path, body]);
    return { heads: 1, merges: 2 };
  };
  const logged = [];
  const env = environment({ GITHUB_EVENT_NAME: "schedule", SESSIONLY_OUTCOMES: "false", SESSIONLY_CI_CHECK_NAMES: "true" });
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ schedule: "17 5 * * *" }));
  const { ci } = await run(env, { api, server, log: (line) => logged.push(line), deliver: () => assert.fail("no pull request is reported") });
  assert.deepEqual(sent, [["PUT", "/prs/ci", {
    repo: "github.com/acme/web",
    heads: [{ number: 1, sha: sha(1), state: "success", failed: 0, total: 1, cancelled: 0 }],
    merges: [
      { number: 1, sha: sha(2), state: "failure", failed: 2, total: 2, cancelled: 0, failed_checks: ["tests", "ci/deploy"] },
      { number: 3, sha: sha(3), state: "none", failed: 0, total: 0, cancelled: 0 },
    ],
  }]]);
  assert.deepEqual(ci.stored, { heads: 1, merges: 2 });
  assert.ok(logged.includes("Read CI for 3 of 4 commits of acme/web that were due: 1 red."));
  assert.ok(logged.includes(`#1: CI at the commit it was merged as, ${sha(2).slice(0, 12)}, is red (2 of 2 checks failed).`));
  // nothing due says so; an older server is said and skipped; a failure of it is the run's when nothing else failed
  const none = async (method, path) => (path.startsWith("/prs/ci/due") ? { heads: [], merges: [] } : { due: [] });
  const quietly = [];
  assert.deepEqual((await run(env, { api, server: none, log: (line) => quietly.push(line) })).ci, { heads: [], merges: [] });
  assert.ok(quietly.includes("No commit was due for its CI to be read."));
  const older = async (method, path) => {
    if (path.startsWith("/prs/ci/due")) throw Object.assign(new Error("the Sessionly server answered 403: this token only reports pull requests"), { status: 403 });
    return { due: [] };
  };
  assert.equal((await run(env, { api, server: older, log: quiet })).ci.skipped, true);
  const down = async (method, path) => {
    if (path.startsWith("/prs/ci/due")) throw Object.assign(new Error("the Sessionly server answered 503: no"), { status: 503 });
    return { due: [] };
  };
  await assert.rejects(run(env, { api, server: down, log: quiet }), /CI was not read: the Sessionly server answered 503/);
  // with ci off, the server is not asked
  const asked = [];
  await run({ ...env, SESSIONLY_CI: "false" }, { api, server: async (method, path) => (asked.push(path), { due: [] }), log: quiet });
  assert.deepEqual(asked, ["/prs/due?repo=github.com%2Facme%2Fweb"]);
});

test("a workflow_run that completed sends the CI of its commit for the pull requests it is in, a fork's too, and as a merge commit", async () => {
  const commits = {
    // a fork's pull request: the event names none, GitHub is asked
    [sha(1)]: { runs: [check("tests", "failure")], pulls: [{ number: 7, merged_at: null, merge_commit_sha: sha(99), base: { repo: { full_name: "acme/web" } } }, { number: 3, base: { repo: { full_name: "someone/web" } } }] },
    // the merge commit of #5, and the head of #8 (stacked on it)
    [sha(2)]: { runs: [check("tests", "success")], pulls: [{ number: 5, merged_at: "2026-11-11T10:00:00Z", merge_commit_sha: sha(2), base: { repo: { full_name: "acme/web" } } }, { number: 8, merged_at: null, merge_commit_sha: sha(98), base: { repo: { full_name: "acme/web" } } }] },
    [sha(3)]: { runs: [], pulls: [] },
  };
  const api = fakeChecks(commits);
  const sent = [];
  const server = async (method, path, body) => (sent.push(body), { heads: body.heads.length, merges: body.merges.length });
  const env = environment({ GITHUB_EVENT_NAME: "workflow_run" });
  const event = (action, head_sha, pull_requests = []) => writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ action, workflow_run: { head_sha, pull_requests, name: "CI" } }));
  event("completed", sha(1));
  const fork = await run(env, { api, server, log: quiet, deliver: () => assert.fail("no pull request is reported") });
  assert.deepEqual(sent, [{ repo: "github.com/acme/web", heads: [{ number: 7, sha: sha(1), state: "failure", failed: 1, total: 1, cancelled: 0 }], merges: [] }]);
  assert.deepEqual(fork.ci.stored, { heads: 1, merges: 0 });
  // the event's own pull requests count with GitHub's answer; the merge commit of one goes as its merge
  sent.length = 0;
  event("completed", sha(2), [{ number: 8 }, { number: 9 }]);
  await run(env, { api, server, log: quiet });
  assert.deepEqual(sent, [{ repo: "github.com/acme/web", heads: [{ number: 8, sha: sha(2), state: "success", failed: 0, total: 1, cancelled: 0 }, { number: 9, sha: sha(2), state: "success", failed: 0, total: 1, cancelled: 0 }], merges: [{ number: 5, sha: sha(2), state: "success", failed: 0, total: 1, cancelled: 0 }] }]);
  // a commit in no pull request, or a run not completed yet, tells the server nothing
  sent.length = 0;
  event("completed", sha(3));
  const logged = [];
  assert.deepEqual((await run(env, { api, server, log: (line) => logged.push(line) })).ci, { heads: [], merges: [] });
  assert.ok(logged.some((line) => /is in no pull request of acme\/web/.test(line)));
  event("requested", sha(1));
  assert.equal((await run(env, { api, server, log: quiet })).ci.skipped, true);
  assert.deepEqual(sent, []);
  // and one that names no commit is an error; with ci off, nothing is done
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ action: "completed", workflow_run: {} }));
  await assert.rejects(run(env, { api, server, log: quiet }), /names no commit/);
  assert.equal((await run({ ...env, SESSIONLY_CI: "false" }, { api, server, log: quiet })).ci, null);
  // a token that may not read pull requests: only the event's own are told
  const refused = fakeChecks({ [sha(1)]: { runs: [check("tests", "success")] } }, { fail: {} });
  refused.request = (() => {
    const inner = refused.request;
    return async (method, path) => {
      if (path.includes("/pulls")) throw Object.assign(new Error(`GitHub answered 403 to GET ${path}: Resource not accessible by integration`), { status: 403 });
      return inner(method, path);
    };
  })();
  sent.length = 0;
  event("completed", sha(1), [{ number: 7 }]);
  const said = [];
  await runWorkflowRun(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")), { api: refused, server, repo: "acme/web", host: "github.com", log: (line) => said.push(line) });
  assert.deepEqual(sent[0].heads.map((h) => h.number), [7]);
  assert.ok(said.some((line) => /pull-requests: read/.test(line)));
  assert.deepEqual(await runCi(environment(), { api, server: async () => ({ heads: [], merges: [] }), repo: "acme/web", host: "github.com", log: quiet }), { heads: [], merges: [] });
});
