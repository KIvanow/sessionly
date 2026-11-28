import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ciOptions, ciReading, naming, reduceCi, runCi, runWorkflowRun, sayCi, workflowFile, workflowPath } from "../src/ci.mjs";
import { run } from "../src/main.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
// A check run of another workflow run than this one's (`GITHUB_RUN_ID` 500 below), in suite 40, unless `more` says.
const check = (name, conclusion, more = {}) => ({
  id: 1,
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  details_url: "https://github.com/acme/web/actions/runs/400/job/9",
  check_suite: { id: 40 },
  app: { slug: "github-actions" },
  ...more,
});
const status = (context, state) => ({ context, state });
/** A check suite of GitHub Actions with no check runs, as a workflow run that never had jobs leaves. */
const suite = (id, status, conclusion, more = {}) => ({ id, status, conclusion, latest_check_runs_count: 0, app: { slug: "github-actions", name: "GitHub Actions" }, ...more });
/** A workflow run as GitHub lists them for a commit: from which file, started by what, on which branch, and how it ended. */
const workflow = (check_suite_id, path, more = {}) => ({ id: check_suite_id * 10, check_suite_id, path, name: path.replace(/^.*\//, "").replace(/\.ya?ml$/, ""), event: "pull_request", head_branch: "parser", status: "completed", conclusion: "success", ...more });
const bySuite = (runs) => new Map(runs.map((run) => [run.check_suite_id, run]));

test("what checks and statuses come to: red on any failure, pending while any waits, none with nothing to go by", () => {
  assert.deepEqual(reduceCi([check("tests", "success"), check("lint", "neutral")], []), { state: "success", failed: 0, total: 2, cancelled: 0 });
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
  // a skipped job never counts, in no direction: a job whose `if:` said no, Sessionly's or anyone's
  assert.deepEqual(reduceCi([check("after-merge", "skipped"), check("docs", "skipped")], []), { state: "none", failed: 0, total: 0, cancelled: 0 });
  assert.deepEqual(reduceCi([check("after-merge", "skipped"), check("tests", "failure")], []), { state: "failure", failed: 1, total: 1, cancelled: 0 });
  // a conclusion from after this is neither
  assert.equal(reduceCi([check("tests", "something_new")], []).state, "pending");
});

test("a workflow run that never had jobs is read from its workflow run: waiting for approval or queued is pending, failed to start is red, and failed when its pull request was closed is not known", () => {
  const runs = bySuite([
    workflow(1, ".github/workflows/ci.yml", { conclusion: "action_required" }),
    workflow(2, ".github/workflows/ci.yml", { conclusion: "startup_failure" }),
    workflow(3, ".github/workflows/ci.yml", { status: "queued", conclusion: null }),
    // GitHub fails an unapproved run when its pull request is closed: nothing ran
    workflow(4, ".github/workflows/ci.yml", { conclusion: "failure" }),
    workflow(5, ".github/workflows/nightly.yml", { conclusion: "startup_failure" }),
  ]);
  const suites = [suite(1, "completed", "action_required"), suite(2, "completed", "failure"), suite(3, "queued", null), suite(4, "completed", "failure"), suite(5, "completed", "failure")];
  assert.deepEqual(reduceCi([], [], { suites: suites.slice(0, 1), runsBySuite: runs }), { state: "pending", failed: 0, total: 1, cancelled: 0 });
  assert.deepEqual(reduceCi([check("tests", "success")], [], { suites: suites.slice(1, 2), runsBySuite: runs, names: true }), { state: "failure", failed: 1, total: 2, cancelled: 0, failed_checks: ["ci"] });
  assert.equal(reduceCi([], [], { suites: suites.slice(2, 3), runsBySuite: runs }).state, "pending");
  assert.deepEqual(reduceCi([], [], { suites: suites.slice(3, 4), runsBySuite: runs }), { state: "none", failed: 0, total: 0, cancelled: 0 });
  // ci-only and ci-ignore go by the workflow run's name; a suite whose workflow run is not known is nothing
  assert.equal(reduceCi([], [], { suites: suites.slice(4, 5), runsBySuite: runs, ignore: naming("nightly") }).state, "none");
  assert.equal(reduceCi([], [], { suites: suites.slice(4, 5), runsBySuite: runs, only: naming("ci") }).state, "none");
  assert.equal(reduceCi([], [], { suites: suites.slice(4, 5), runsBySuite: runs }).state, "failure");
  assert.equal(reduceCi([], [], { suites: [suite(9, "completed", "startup_failure")], runsBySuite: runs }).state, "none");
  // one with check runs is read through them, and said nothing of itself; so is one whose runs were read, and another app's
  assert.deepEqual(reduceCi([check("tests", "success", { check_suite: { id: 7 } })], [], { suites: [suite(7, "completed", "failure", { latest_check_runs_count: 1 })], runsBySuite: bySuite([workflow(7, ".github/workflows/ci.yml", { conclusion: "startup_failure" })]) }), { state: "success", failed: 0, total: 1, cancelled: 0 });
  assert.deepEqual(reduceCi([check("tests", "success", { check_suite: { id: 7 } })], [], { suites: [suite(7, "completed", "failure")], runsBySuite: bySuite([workflow(7, ".github/workflows/ci.yml", { conclusion: "startup_failure" })]) }), { state: "success", failed: 0, total: 1, cancelled: 0 });
  assert.equal(reduceCi([], [], { suites: [suite(1, "completed", "failure", { app: { slug: "codecov" } })], runsBySuite: runs }).state, "none");
});

test("Sessionly's check runs are left out by workflow file, and this job's by id or page", () => {
  const own = (more = {}) => ({ checkRunId: "77", runId: "123", ...more });
  const mine = check("report", "failure", { id: 77, details_url: "https://github.com/acme/web/actions/runs/123/job/77", check_suite: { id: 1 } });
  const theirs = check("tests", "success", { id: 78, details_url: "https://github.com/acme/web/actions/runs/124/job/78", check_suite: { id: 2 } });
  const other = check("build", "success", { id: 79, details_url: "https://github.com/acme/web/actions/runs/125/job/79", check_suite: { id: 3 } });
  assert.deepEqual(reduceCi([mine, theirs, other], [], { own: own() }), { state: "success", failed: 0, total: 2, cancelled: 0 });
  // without the id, by this run's page; a run of this run id's prefix is another run; with neither, nothing is
  assert.deepEqual(reduceCi([mine, theirs, other], [], { own: own({ checkRunId: "" }) }), { state: "success", failed: 0, total: 2, cancelled: 0 });
  assert.equal(reduceCi([check("x", "failure", { details_url: "https://github.com/acme/web/actions/runs/1234/job/1" })], [], { own: own({ checkRunId: "" }) }).state, "failure");
  assert.equal(reduceCi([mine, theirs], [], { own: own({ checkRunId: "", runId: "" }) }).state, "failure");
  // earlier Sessionly runs on this commit (reported when opened, then reviewed): their suites are from its file, and go whole
  const earlier = [
    check("report", "success", { id: 50, details_url: "https://github.com/acme/web/actions/runs/100/job/50", check_suite: { id: 10 } }),
    check("report", "failure", { id: 55, details_url: "https://github.com/acme/web/actions/runs/105/job/55", check_suite: { id: 11 } }),
    check("tests", "failure", { id: 52, details_url: "https://github.com/acme/web/actions/runs/101/job/52", check_suite: { id: 12 } }),
  ];
  assert.deepEqual(reduceCi(earlier, [], { own: own(), excluded: new Set([10, 11]) }), { state: "failure", failed: 1, total: 1, cancelled: 0 });
  // a repository with no CI of its own: nothing, not green
  assert.deepEqual(reduceCi(earlier.slice(0, 2), [], { own: own(), excluded: new Set([10, 11]) }), { state: "none", failed: 0, total: 0, cancelled: 0 });
  // a same-named job of another file counts: nothing goes by name
  const mixed = [
    check("report", "success", { id: 60, details_url: "https://github.com/acme/web/actions/runs/106/job/60", check_suite: { id: 20 } }),
    check("tests", "failure", { id: 61, details_url: "https://github.com/acme/web/actions/runs/106/job/61", check_suite: { id: 20 } }),
    check("report", "success", { id: 62, details_url: "https://github.com/acme/web/actions/runs/107/job/62", check_suite: { id: 21 } }),
  ];
  assert.deepEqual(reduceCi(mixed, [], { own: own() }), { state: "failure", failed: 1, total: 3, cancelled: 0 });
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
  // the files that are Sessionly's: this run's own, or exactly those named, however they are written
  const env = { SESSIONLY_CI_IGNORE: "a*", SESSIONLY_CI_CHECK_NAMES: "true", SESSIONLY_CHECK_RUN_ID: " 5 ", GITHUB_RUN_ID: "9", GITHUB_REPOSITORY: "acme/web", GITHUB_WORKFLOW_REF: "acme/web/.github/workflows/sessionly.yml@refs/heads/main" };
  const options = ciOptions(env);
  assert.deepEqual([options.ignore("abc"), options.ignore("b"), options.only, options.own, [...options.files], options.names], [
    true, false, null, { checkRunId: "5", runId: "9" }, [".github/workflows/sessionly.yml"], true,
  ]);
  assert.deepEqual([...ciOptions({ ...env, SESSIONLY_WORKFLOWS: "nightly.yml, ./.github/workflows/Report.yaml\n/.github/workflows/sessionly.yml" }).files], [".github/workflows/nightly.yml", ".github/workflows/report.yaml", ".github/workflows/sessionly.yml"]);
  assert.deepEqual([...ciOptions({ ...env, SESSIONLY_WORKFLOWS: " none " }).files], []);
  assert.deepEqual([...ciOptions({ ...env, SESSIONLY_WORKFLOWS: " , " }).files], []);
  assert.deepEqual([workflowPath("ci.yml"), workflowPath("./.github/workflows/ci.yml"), workflowPath("/x/y.yml"), workflowPath(" "), workflowPath(null)], [".github/workflows/ci.yml", ".github/workflows/ci.yml", "x/y.yml", null, null]);
  assert.equal(workflowFile({ GITHUB_WORKFLOW_REF: "Acme/Web/.github/workflows/CI.yml@refs/pull/7/merge", GITHUB_REPOSITORY: "acme/web" }), ".github/workflows/ci.yml");
  assert.equal(workflowFile({ GITHUB_WORKFLOW_REF: "acme/web/.github/workflows/ci.yaml@refs/heads/release@2026" }), ".github/workflows/ci.yaml");
  assert.equal(workflowFile({ GITHUB_WORKFLOW_REF: "acme/web/.github/workflows/ci.yml" }), null);
  assert.equal(workflowFile({}), null);
  assert.deepEqual([sayCi({ state: "failure", failed: 1, total: 3 }), sayCi({ state: "pending", total: 2 }), sayCi({ state: "none", cancelled: 2 }), sayCi({ state: "none", cancelled: 0 })], ["red (1 of 3 checks failed)", "still running (2 checks so far)", "nothing to go by (2 checks cancelled)", "no checks"]);
});

test("of a merge commit, GitHub Actions counts only for the runs its push started on the branch; other apps' checks and statuses always", () => {
  const runs = [
    check("tests", "success", { check_suite: { id: 1 } }),
    check("CodeQL", "failure", { check_suite: { id: 2 } }),
    check("Dependabot", "failure", { check_suite: { id: 3 } }),
    check("release", "failure", { check_suite: { id: 4 } }),
    check("codecov/patch", "failure", { check_suite: { id: 5 }, app: { slug: "codecov" } }),
  ];
  assert.deepEqual(reduceCi(runs, [], {}), { state: "failure", failed: 4, total: 5, cancelled: 0 });
  // suite 1 the push's on main, 2 a schedule's, 3 someone's, 4 the push of a tag at the same commit
  assert.deepEqual(reduceCi(runs, [], { pushSuites: new Set([1]) }), { state: "failure", failed: 1, total: 2, cancelled: 0 });
  assert.deepEqual(reduceCi(runs.slice(0, 4), [], { pushSuites: new Set([1]) }), { state: "success", failed: 0, total: 1, cancelled: 0 });
  assert.equal(reduceCi(runs.slice(0, 4), [status("ci/x", "failure")], { pushSuites: new Set([1]) }).state, "failure");
  // a workflow run of the push that never had jobs counts; another's does not
  const zero = bySuite([workflow(6, ".github/workflows/ci.yml", { event: "push", head_branch: "main", conclusion: "startup_failure" }), workflow(7, ".github/workflows/nightly.yml", { event: "schedule", conclusion: "startup_failure" })]);
  assert.equal(reduceCi([], [], { suites: [suite(6, "completed", "failure"), suite(7, "completed", "failure")], runsBySuite: zero, pushSuites: new Set([6]) }).failed, 1);
});

/**
 * GitHub with check runs, statuses, check suites and workflow runs on
 * commits, which pull requests each is in (by the repository asked, when
 * `pulls` is by name), and check runs by id; `fail` answers the status asked
 * with for a commit, `refuse` for a path.
 */
function fakeChecks(commits, { fail = {}, refuse = [], remaining, checkRuns = {} } = {}) {
  const calls = [];
  const api = {
    calls,
    get remaining() {
      return remaining;
    },
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      if (refuse.some((part) => path.includes(part))) throw Object.assign(new Error(`GitHub answered 403 to GET ${path}: Resource not accessible by integration`), { status: 403 });
      const one = /\/check-runs\/(\d+)$/.exec(path);
      if (one) {
        if (!checkRuns[one[1]]) throw Object.assign(new Error(`GitHub answered 404 to GET ${path}: Not Found`), { status: 404 });
        return checkRuns[one[1]];
      }
      const listed = /\/actions\/runs\?head_sha=([0-9a-f]+)(?:.*[?&]page=(\d+))?/.exec(path);
      if (listed) {
        const list = commits[listed[1]]?.workflows ?? [];
        return { total_count: list.length, workflow_runs: list };
      }
      const asked = /\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/(check-runs|status|check-suites|pulls)(?:\?.*[?&]page=(\d+))?/.exec(path);
      if (!asked) throw new Error(`unexpected ${path}`);
      const [, repo, at, what, page] = asked;
      if (fail[at]) throw Object.assign(new Error(`GitHub answered ${fail[at]} to GET ${path}: no`), { status: fail[at], rateLimited: fail[at] === 429 });
      const commit = commits[at] ?? {};
      if (what === "pulls") return Array.isArray(commit.pulls) ? commit.pulls : (commit.pulls?.[repo] ?? []);
      const list = what === "check-runs" ? (commit.runs ?? []) : what === "status" ? (commit.statuses ?? []) : (commit.suites ?? []);
      const from = (Number(page ?? 1) - 1) * 100;
      const batch = list.slice(from, from + 100);
      if (what === "check-runs") return { total_count: list.length, check_runs: batch };
      if (what === "check-suites") return { total_count: list.length, check_suites: batch };
      return { state: "pending", total_count: list.length, statuses: batch };
    },
  };
  return api;
}

const quiet = () => {};
const SESSIONLY = ".github/workflows/sessionly.yml";
const CI = ".github/workflows/ci.yml";
/** The check runs this run (500, suite 50, the sessionly file) left on the commit it runs on: the workflow's jobs, one skipped. */
const thisRun = () => [
  check("report", "success", { id: 77, details_url: "https://github.com/acme/web/actions/runs/500/job/77", check_suite: { id: 50 } }),
  check("after-merge", "skipped", { id: 78, details_url: "https://github.com/acme/web/actions/runs/500/job/78", check_suite: { id: 50 } }),
];
const thisWorkflow = (more = {}) => workflow(50, SESSIONLY, { id: 500, ...more });
/** An earlier Sessionly run's check runs on a commit: the same jobs, another run, from the same file. */
const earlierRun = (id) => [
  check("report", "success", { id: id * 10, details_url: `https://github.com/acme/web/actions/runs/${id}/job/${id * 10}`, check_suite: { id } }),
  check("after-merge", "skipped", { id: id * 10 + 1, details_url: `https://github.com/acme/web/actions/runs/${id}/job/${id * 10 + 1}`, check_suite: { id } }),
];
const earlierWorkflow = (id, more = {}) => workflow(id, SESSIONLY, { id, ...more });
const OPTIONS = { GITHUB_RUN_ID: "500", SESSIONLY_CHECK_RUN_ID: "77", GITHUB_REPOSITORY: "acme/web", GITHUB_WORKFLOW_REF: `acme/web/${SESSIONLY}@refs/heads/main` };

test("a commit's CI is read past 100 check runs and statuses, with its check suites and workflow runs; 403, 404 and the rate limit leave it unknown, said once", async () => {
  const many = Array.from({ length: 150 }, (_, i) => check(`c${i}`, i === 149 ? "failure" : "success"));
  const api = fakeChecks({ [sha(1)]: { runs: many, statuses: Array.from({ length: 101 }, (_, i) => status(`s${i}`, "success")) }, [sha(2)]: {}, [sha(3)]: {} }, { fail: { [sha(3)]: 404 } });
  const logged = [];
  const reading = ciReading(api, "acme/web", (line) => logged.push(line));
  assert.deepEqual(await reading.of(sha(1)), { sha: sha(1), state: "failure", failed: 1, total: 251, cancelled: 0 });
  assert.deepEqual(api.calls, [
    `GET /repos/acme/web/actions/runs?head_sha=${sha(1)}&per_page=100&page=1`,
    `GET /repos/acme/web/commits/${sha(1)}/check-runs?filter=latest&per_page=100&page=1`,
    `GET /repos/acme/web/commits/${sha(1)}/check-runs?filter=latest&per_page=100&page=2`,
    `GET /repos/acme/web/commits/${sha(1)}/status?per_page=100&page=1`,
    `GET /repos/acme/web/commits/${sha(1)}/status?per_page=100&page=2`,
    `GET /repos/acme/web/commits/${sha(1)}/check-suites?per_page=100&page=1`,
  ]);
  // asked once
  await reading.of(sha(1));
  assert.equal(api.calls.length, 6);
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
  assert.equal(refused.calls.filter((c) => c.includes("/check-runs")).length, 1);
  assert.deepEqual(said.length, 1);
  assert.match(said[0], /checks: read and statuses: read/);
  // few requests left: nothing is asked
  const low = fakeChecks({ [sha(6)]: {} }, { remaining: 50 });
  const stopped = ciReading(low, "acme/web", quiet);
  assert.equal(await stopped.of(sha(6)), null);
  assert.deepEqual(low.calls, []);
  assert.match(stopped.state.stop, /few more requests/);
});

test("Sessionly's workflow runs are left out by file on every commit, a merge commit is read for its push's runs on the branch, and without actions: read only this job's check run goes", async () => {
  const commits = {
    // a head: this run's jobs (from the sessionly file), an earlier Sessionly run's, and the repository's own CI
    [sha(1)]: { runs: [...thisRun(), ...earlierRun(300), check("tests", "success", { check_suite: { id: 60 } })], workflows: [thisWorkflow(), earlierWorkflow(300), workflow(60, CI)] },
    // a head reported earlier, where only Sessionly ran, twice: nothing to go by, not green
    [sha(2)]: { runs: [...earlierRun(301), ...earlierRun(302)], workflows: [earlierWorkflow(301), earlierWorkflow(302)] },
    // a merge commit: its push ran tests (suite 70) and Sessionly (71); a nightly CodeQL run (72), a workflow waiting for
    // approval (73) and a release tag's push (74) came later; codecov's check run is another app's
    [sha(3)]: {
      runs: [
        check("tests", "success", { check_suite: { id: 70 } }), ...earlierRun(71), check("CodeQL", "failure", { check_suite: { id: 72 } }),
        check("release", "failure", { check_suite: { id: 74 } }), check("codecov/patch", "failure", { check_suite: { id: 75 }, app: { slug: "codecov" } }),
      ],
      suites: [suite(73, "completed", "action_required")],
      workflows: [
        workflow(70, CI, { event: "push", head_branch: "main" }), earlierWorkflow(71, { event: "push", head_branch: "main" }), workflow(72, ".github/workflows/codeql.yml", { event: "schedule", head_branch: "main" }),
        workflow(73, CI, { event: "pull_request", conclusion: "action_required" }), workflow(74, ".github/workflows/release.yml", { event: "push", head_branch: "v1.2.0" }),
      ],
    },
  };
  const api = fakeChecks(commits);
  const logged = [];
  // on a workflow_run or a schedule this run's own check runs are on another commit: it makes no difference
  const reading = ciReading(api, "acme/web", (line) => logged.push(line), ciOptions(OPTIONS));
  assert.deepEqual(await reading.of(sha(2)), { sha: sha(2), state: "none", failed: 0, total: 0, cancelled: 0 });
  assert.deepEqual(await reading.of(sha(1)), { sha: sha(1), state: "success", failed: 0, total: 1, cancelled: 0 });
  // the merge: tests and codecov count, not the nightly run, the tag's push, the fork's wait, nor Sessionly
  assert.deepEqual(await reading.of(sha(3), { merge: true, base: "main" }), { sha: sha(3), state: "failure", failed: 1, total: 2, cancelled: 0 });
  assert.equal(api.calls.filter((c) => c.includes(`actions/runs?head_sha=${sha(3)}`)).length, 1);
  // the same commit as a head is all but Sessionly's
  assert.deepEqual(await reading.of(sha(3)), { sha: sha(3), state: "failure", failed: 3, total: 5, cancelled: 0 });
  // nothing else was asked: no check run by id, no jobs of this run
  assert.ok(!api.calls.some((c) => /\/check-runs\/\d+$|\/jobs/.test(c)));
  assert.deepEqual(logged, []);
  // the files named stand in place of this run's own: a Sessionly job in the CI file leaves that file's jobs counting
  const inCi = fakeChecks({
    [sha(4)]: {
      runs: [check("report", "success", { id: 77, details_url: "https://github.com/acme/web/actions/runs/500/job/77", check_suite: { id: 50 } }), check("tests", "failure", { id: 78, details_url: "https://github.com/acme/web/actions/runs/500/job/78", check_suite: { id: 50 } }), ...earlierRun(33)],
      workflows: [workflow(50, CI, { id: 500 }), workflow(33, ".github/workflows/nightly.yml", { id: 33 })],
    },
  });
  const split = ciReading(inCi, "acme/web", quiet, ciOptions({ ...OPTIONS, GITHUB_WORKFLOW_REF: `acme/web/${CI}@refs/heads/main`, SESSIONLY_WORKFLOWS: "nightly.yml" }));
  assert.deepEqual(await split.of(sha(4)), { sha: sha(4), state: "failure", failed: 1, total: 1, cancelled: 0 });
  // named as none: only this job's own check run goes, and the CI file is read whole
  const alone = ciReading(inCi, "acme/web", quiet, ciOptions({ ...OPTIONS, GITHUB_WORKFLOW_REF: `acme/web/${CI}@refs/heads/main`, SESSIONLY_WORKFLOWS: "none" }));
  assert.deepEqual(await alone.of(sha(4)), { sha: sha(4), state: "failure", failed: 1, total: 2, cancelled: 0 });
  // without actions: read, only this job's check run and skipped runs are left out, said once; a merge commit's CI is not known
  const refused = fakeChecks({ [sha(1)]: commits[sha(1)], [sha(3)]: { runs: [check("tests", "success")] } }, { refuse: ["/actions/runs"] });
  const said = [];
  const noRuns = ciReading(refused, "acme/web", (line) => said.push(line), ciOptions(OPTIONS));
  assert.deepEqual(await noRuns.of(sha(1)), { sha: sha(1), state: "success", failed: 0, total: 2, cancelled: 0 });
  assert.equal(await noRuns.of(sha(3), { merge: true, base: "main" }), null);
  assert.equal((await noRuns.of(sha(3))).state, "success");
  assert.equal(said.length, 1);
  assert.match(said[0], /actions: read/);
  assert.equal(refused.calls.filter((c) => c.includes("/actions/runs")).length, 1);
});

function environment(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sessionly-ci-"));
  writeFileSync(join(dir, "event.json"), "{}");
  writeFileSync(join(dir, "summary"), "");
  return {
    SESSIONLY_URL: "https://sessionly.example.com/",
    SESSIONLY_TOKEN: "sly_secret",
    SESSIONLY_GITHUB_TOKEN: "gh",
    GITHUB_EVENT_PATH: join(dir, "event.json"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    ...OPTIONS,
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
    if (/\/commits\/[0-9a-f]+\/(check-runs|status|check-suites|pulls)/.test(path) || path.includes("/actions/runs") || /\/check-runs\/\d+$/.test(path)) return checks.request(method, path);
    checks.calls.push(`${method} ${path}`);
    if (method !== "GET") return {};
    if (path.includes("/issues/") || path.includes("/files") || path.includes("/reviews") || path.includes("/comments")) return [];
    if (path.includes("/commits")) return [{ sha: sha(1), commit: { author: { email: "ann@example.com" }, committer: { email: "ann@example.com" } } }];
    return pull;
  };
  return { request, calls: checks.calls, get remaining() { return checks.remaining; } };
}

test("after a pull request is reported, the CI of its head and of the heads the server says are pending is read and sent in the same run, without Sessionly's own runs", async () => {
  const api = fakePull(PULL, {
    // the head: this run's jobs beside the repository's tests, still running
    [sha(1)]: { runs: [check("tests", null, { id: 1, check_suite: { id: 60 } }), ...thisRun()], workflows: [thisWorkflow(), workflow(60, CI)] },
    // a head from before, where tests failed and Sessionly reported
    [sha(3)]: { runs: [check("tests", "failure", { id: 2, check_suite: { id: 61 } }), ...earlierRun(300)], workflows: [workflow(61, CI), earlierWorkflow(300)] },
  });
  const sent = [];
  const server = async (method, path, body) => (sent.push([method, path, body]), { heads: 2, merges: 0 });
  const deliver = async (url, token, report) => ({ stored: true, attribution: { first: { lines: 0, agent_lines: 0 }, now: { lines: 0, agent_lines: 0, by: [] }, by: [] }, ci_pending: [{ number: 7, sha: sha(3) }, { number: 7, sha: sha(1) }] });
  const logged = [];
  const env = environment({ GITHUB_EVENT_NAME: "pull_request", SESSIONLY_COMMENT: "false" });
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ action: "synchronize", pull_request: { number: 7 } }));
  const out = await run(env, { api, deliver, server, log: (line) => logged.push(line) });
  // the head, still running without Sessionly's checks, and the pending head, red; each once
  assert.deepEqual(sent, [["PUT", "/prs/ci", { repo: "github.com/acme/web", heads: [{ number: 7, sha: sha(1), state: "pending", failed: 0, total: 1, cancelled: 0 }, { number: 7, sha: sha(3), state: "failure", failed: 1, total: 1, cancelled: 0 }], merges: [] }]]);
  assert.deepEqual(out.ci.stored, { heads: 2, merges: 0 });
  assert.ok(logged.includes(`CI at ${sha(3).slice(0, 12)} is red (1 of 1 check failed).`));
  // once merged, the commit it was merged as too: the checks its push started on the base branch
  const merged = fakePull({ ...PULL, state: "closed", merged: true, merged_at: "2026-11-11T10:00:00Z" }, {
    [sha(1)]: { runs: [check("tests", "success")], workflows: [] },
    [sha(2)]: {
      runs: [check("tests", "failure", { check_suite: { id: 20 } }), check("nightly", "failure", { check_suite: { id: 21 } }), check("tag", "failure", { check_suite: { id: 22 } })],
      workflows: [workflow(20, CI, { event: "push", head_branch: "main" }), workflow(21, ".github/workflows/nightly.yml", { event: "schedule", head_branch: "main" }), workflow(22, CI, { event: "push", head_branch: "v2" })],
    },
  });
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
    // the branch's tip this run is on: this run's jobs
    [sha(9)]: { runs: thisRun(), workflows: [thisWorkflow({ event: "schedule", head_branch: "main" })] },
    [sha(1)]: { runs: [check("tests", "success", { check_suite: { id: 60 } }), ...earlierRun(300)], workflows: [workflow(60, CI), earlierWorkflow(300)] },
    [sha(2)]: {
      runs: [check("tests", "failure", { name: "tests", check_suite: { id: 20 } }), check("CodeQL", "failure", { check_suite: { id: 21 } })],
      statuses: [status("ci/deploy", "failure")],
      workflows: [workflow(20, CI, { event: "push", head_branch: "main" }), workflow(21, ".github/workflows/codeql.yml", { event: "schedule", head_branch: "main" })],
    },
    [sha(3)]: { workflows: [] },
  }, { fail: { [sha(4)]: 404 } });
  const sent = [];
  const server = async (method, path, body) => {
    if (path.startsWith("/prs/due")) return { due: [] };
    if (path.startsWith("/prs/ci/due")) {
      assert.match(path, /repo=github\.com%2Facme%2Fweb$/);
      return { heads: [{ number: 1, sha: sha(1) }, { number: 2, sha: sha(4) }], merges: [{ number: 1, sha: sha(2), base_ref: "main" }, { number: 3, sha: sha(3), base_ref: "main" }] };
    }
    sent.push([method, path, body]);
    return { heads: 1, merges: 2 };
  };
  const logged = [];
  const env = environment({ GITHUB_EVENT_NAME: "schedule", GITHUB_SHA: sha(9), SESSIONLY_OUTCOMES: "false", SESSIONLY_CI_CHECK_NAMES: "true" });
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
  assert.ok(!api.calls.some((c) => c.includes(sha(9))), "the commit this run is on is not read for itself");
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

test("a workflow_run that completed sends the CI of its commit for the pull requests it is in, a fork's asked of the fork, and as a merge commit only when its push started the run", async () => {
  const into = (number, more = {}) => ({ number, merged_at: null, merge_commit_sha: sha(99), base: { ref: "main", repo: { full_name: "acme/web" } }, ...more });
  const commits = {
    // a fork's pull request: the event names none, and this repository does not know the commit's pull requests; the fork does
    [sha(1)]: { runs: [check("tests", "failure")], workflows: [workflow(40, CI)], pulls: { "acme/web": [], "someone/web": [into(7), into(3, { base: { ref: "main", repo: { full_name: "someone/web" } } })] } },
    // the merge commit of #5, and the head of #8 (stacked on it)
    [sha(2)]: {
      runs: [check("tests", "success", { check_suite: { id: 20 } }), check("nightly", "failure", { check_suite: { id: 21 } })],
      workflows: [workflow(20, CI, { event: "push", head_branch: "main" }), workflow(21, ".github/workflows/nightly.yml", { event: "schedule", head_branch: "main" })],
      pulls: [into(5, { merged_at: "2026-11-11T10:00:00Z", merge_commit_sha: sha(2) }), into(8)],
    },
    [sha(3)]: { runs: [], pulls: [] },
    [sha(4)]: { runs: [check("tests", "failure")], workflows: [workflow(40, CI, { event: "schedule" })], pulls: [into(6, { merged_at: "2026-11-11T10:00:00Z", merge_commit_sha: sha(4) })] },
  };
  const api = fakeChecks(commits);
  const sent = [];
  const server = async (method, path, body) => (sent.push(body), { heads: body.heads.length, merges: body.merges.length });
  const env = environment({ GITHUB_EVENT_NAME: "workflow_run" });
  const event = (action, head_sha, pull_requests = [], more = {}) =>
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ action, workflow_run: { head_sha, pull_requests, name: "CI", event: "pull_request", head_repository: { full_name: "acme/web" }, ...more } }));
  event("completed", sha(1), [], { head_repository: { full_name: "someone/web" } });
  const fork = await run(env, { api, server, log: quiet, deliver: () => assert.fail("no pull request is reported") });
  assert.deepEqual(sent, [{ repo: "github.com/acme/web", heads: [{ number: 7, sha: sha(1), state: "failure", failed: 1, total: 1, cancelled: 0 }], merges: [] }]);
  assert.ok(api.calls.includes(`GET /repos/someone/web/commits/${sha(1)}/pulls?per_page=100`));
  assert.ok(!api.calls.some((c) => c.startsWith(`GET /repos/acme/web/commits/${sha(1)}/pulls`)));
  assert.deepEqual(fork.ci.stored, { heads: 1, merges: 0 });
  // the event's own pull requests count with GitHub's answer; the merge commit of one goes as its merge when the push started this run
  sent.length = 0;
  event("completed", sha(2), [{ number: 8 }, { number: 9 }], { event: "push" });
  await run(env, { api, server, log: quiet });
  assert.deepEqual(sent, [{
    repo: "github.com/acme/web",
    heads: [{ number: 8, sha: sha(2), state: "failure", failed: 1, total: 2, cancelled: 0 }, { number: 9, sha: sha(2), state: "failure", failed: 1, total: 2, cancelled: 0 }],
    merges: [{ number: 5, sha: sha(2), state: "success", failed: 0, total: 1, cancelled: 0 }],
  }]);
  // a run a schedule started on the branch's tip says nothing of the merge
  sent.length = 0;
  const logged = [];
  event("completed", sha(4), [], { event: "schedule" });
  assert.deepEqual((await run(env, { api, server, log: (line) => logged.push(line) })).ci, { heads: [], merges: [] });
  assert.ok(logged.some((line) => /as a merge commit, and this run was not started by its push \(schedule\)/.test(line)));
  assert.deepEqual(sent, []);
  // a commit in no pull request, or a run not completed yet, tells the server nothing
  event("completed", sha(3));
  logged.length = 0;
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
  const refused = fakeChecks({ [sha(1)]: { runs: [check("tests", "success")] } }, { refuse: ["/pulls"] });
  sent.length = 0;
  event("completed", sha(1), [{ number: 7 }]);
  const said = [];
  await runWorkflowRun(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")), { api: refused, server, repo: "acme/web", host: "github.com", log: (line) => said.push(line) });
  assert.deepEqual(sent[0].heads.map((h) => h.number), [7]);
  assert.ok(said.some((line) => /pull-requests: read/.test(line)));
  assert.deepEqual(await runCi(environment(), { api, server: async () => ({ heads: [], merges: [] }), repo: "acme/web", host: "github.com", log: quiet }), { heads: [], merges: [] });
});
