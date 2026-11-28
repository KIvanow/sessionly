// CI: what the checks and statuses on a commit came to, read on GitHub and
// sent to the server as a state and counts. Of a pull request's head that
// says whether the push was red, and of the commit it was merged as whether
// the base branch went red after it. What ran, and what it said, stays on
// GitHub; the names of the checks that failed go only when asked for
// (`ci-check-names`). Sessionly's own check runs are left out, and whatever
// `ci-ignore` names; with `ci-only`, nothing but what that names counts.
import { RATE_FLOOR } from "./outcomes.mjs";

/** A check run's conclusion that is a failure, and one that is fine; `cancelled` and `stale` say nothing either way. */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const PASSED = new Set(["success", "neutral", "skipped"]);
/** A status's state. */
const STATUS_FAILED = new Set(["failure", "error"]);
/** The app whose check suites are workflow runs. */
const ACTIONS = "github-actions";

/** No more names of failed checks than this are sent, each cut to this many characters. */
export const MOST_NAMES = 20;
export const NAME_LENGTH = 100;
/** No more check runs, statuses or check suites than this are read for one commit. */
const MOST_CHECKS = 1000;

/** A full commit SHA. */
const isSha = (text) => typeof text === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text);

/**
 * Names, or patterns of names with `*`, separated by commas or new lines,
 * as a test of a check's name or a status's context. Case does not matter.
 */
export function naming(patterns) {
  const tests = String(patterns ?? "")
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"));
  return tests.length === 0 ? null : (name) => tests.some((test) => test.test(String(name ?? "")));
}

/** What the inputs say of reading CI: what to leave out, what alone to count, which check run and workflow run are this job's, and whether to name failed checks. */
export function ciOptions(env) {
  const on = (value) => /^(true|yes|on|1)$/i.test((value ?? "").trim());
  return {
    ignore: naming(env.SESSIONLY_CI_IGNORE),
    only: naming(env.SESSIONLY_CI_ONLY),
    own: { checkRunId: (env.SESSIONLY_CHECK_RUN_ID ?? "").trim(), runId: (env.GITHUB_RUN_ID ?? "").trim(), names: new Set(), suites: new Set() },
    names: on(env.SESSIONLY_CI_CHECK_NAMES),
  };
}

/**
 * Whether a check run is this workflow run's: the one whose id the job was
 * given (`check-run-id`), or any whose page is under this run's
 * (`/runs/<run id>/`), the jobs skipped by an `if:` included. The report
 * runs beside the pull request's checks, and must not count itself as one.
 */
function isThisRun(run, own) {
  if (own?.checkRunId && String(run?.id) === own.checkRunId) return true;
  return Boolean(own?.runId) && String(run?.details_url ?? "").includes(`/runs/${own.runId}/`);
}

/**
 * Whether a check run is Sessionly's: this workflow run's, or a job of the
 * same workflow run earlier on this commit (reported when it was opened,
 * reviewed, closed: each a run, each with the workflow's jobs as check
 * runs), which is known by the names the jobs have in this run (`own.names`,
 * learnt from this run's own check runs) and by the check suites those are
 * in. A workflow's job names are the same from run to run; another
 * workflow's job of the same name is taken for Sessionly's too.
 */
function isOwn(run, own) {
  if (isThisRun(run, own)) return true;
  if (own?.suites?.has(run?.check_suite?.id)) return true;
  const app = run?.app?.slug;
  return Boolean(own?.names?.has(run?.name)) && (app == null || app === ACTIONS);
}

/**
 * What check runs, statuses and check suites on one commit come to:
 * `failure` when any failed (or timed out), else `pending` while any is
 * still running or waiting (`action_required` is waiting for someone, as a
 * first-time contributor's workflows do), else `success` when any came out
 * well (neutral and skipped are well), else `none`: nothing to go by.
 * Cancelled runs say nothing either way, and are counted apart
 * (`cancelled`): a push cancels the run before it, and a commit whose runs
 * were all cancelled has none. Sessionly's own check runs, what `ignore`
 * names, and what `only` does not name, are not looked at. A check suite
 * without check runs is a workflow run that never had jobs: waiting for
 * approval (pending), failed to start (red), or still queued (pending). With
 * `pushSuites` (the suites of the workflow runs a push started), only check
 * runs and suites among them count: the checks a merge commit's push ran,
 * not a nightly run on the branch's tip months later. The names of the
 * failed ones only with `names`.
 */
export function reduceCi(checkRuns, statuses, { ignore = null, only = null, own = null, names = false, suites = [], pushSuites = null } = {}) {
  const counted = (name) => (!only || only(name)) && !(ignore && ignore(name));
  let failed = 0;
  let total = 0;
  let cancelled = 0;
  let pending = 0;
  const red = [];
  // Sessionly's suites: those given, and those of its check runs here (found first, so that a job of
  // its run listed before its own check run is left out too). And the suites whose runs were read: a
  // suite is read whole only when it has none.
  const ownSuites = new Set(own?.suites ?? []);
  for (const run of checkRuns ?? []) if (run && run.check_suite?.id != null && isOwn(run, own)) ownSuites.add(run.check_suite.id);
  const withRuns = new Set();
  for (const run of checkRuns ?? []) {
    if (!run) continue;
    const suite = run.check_suite?.id;
    if (ownSuites.has(suite) || isOwn(run, own)) continue;
    if (suite != null) withRuns.add(suite);
    if (!counted(run.name) || (pushSuites && !pushSuites.has(suite))) continue;
    if (run.status !== "completed" || run.conclusion == null || run.conclusion === "action_required") {
      total += 1;
      pending += 1;
    } else if (FAILED.has(run.conclusion)) {
      total += 1;
      failed += 1;
      red.push(run.name);
    } else if (PASSED.has(run.conclusion)) {
      total += 1;
    } else if (run.conclusion === "cancelled") {
      cancelled += 1;
    } else if (run.conclusion === "stale") {
      // Left over from before a push: nothing.
    } else {
      // A conclusion GitHub adds later: not red, not green.
      total += 1;
      pending += 1;
    }
  }
  for (const suite of suites ?? []) {
    if (!suite || suite.app?.slug !== ACTIONS || ownSuites.has(suite.id) || withRuns.has(suite.id) || suite.latest_check_runs_count > 0) continue;
    if (pushSuites && !pushSuites.has(suite.id)) continue;
    if (suite.status !== "completed" || suite.conclusion == null || suite.conclusion === "action_required") {
      total += 1;
      pending += 1;
    } else if (FAILED.has(suite.conclusion)) {
      total += 1;
      failed += 1;
      red.push(suite.app?.name ?? "a workflow that did not start");
    }
  }
  for (const status of statuses ?? []) {
    if (!status || !counted(status.context)) continue;
    total += 1;
    if (STATUS_FAILED.has(status.state)) {
      failed += 1;
      red.push(status.context);
    } else if (status.state !== "success") pending += 1;
  }
  const state = failed > 0 ? "failure" : pending > 0 ? "pending" : total > 0 ? "success" : "none";
  const out = { state, failed, total, cancelled };
  if (names && red.length > 0) out.failed_checks = red.slice(0, MOST_NAMES).map((name) => String(name ?? "").slice(0, NAME_LENGTH));
  return out;
}

/** Every page of a list GitHub serves under `key`, up to `MOST_CHECKS`. */
async function pages(api, path, key) {
  const items = [];
  for (let page = 1; items.length < MOST_CHECKS; page += 1) {
    const found = await api.request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = Array.isArray(found?.[key]) ? found[key] : [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** Text as one line, for a warning. */
const oneLine = (err) => String(err?.message ?? err).replace(/\r?\n/g, " ");

/**
 * Reading commits' CI in one run: `of(sha)` is what it came to, or null
 * when it is not known, which is not sent. A token that may not read checks
 * is said once, and nothing more is asked; so is GitHub allowing few more
 * requests (`RATE_FLOOR`), or none. A commit GitHub does not know, or will
 * not answer for, is said once and left. Each commit is asked about once.
 *
 * Sessionly's own check runs are told by this run's (`ownSha`: the commit
 * this run's check runs are on, read first): their job names and check
 * suites, then left out on every commit. `of(sha, { merge: true })` reads a
 * merge commit: only the checks the push of it started count, which takes
 * the workflow runs of that push (`actions: read`); refused, the merge's CI
 * is not known, and that is said once.
 */
export function ciReading(api, repo, log, options = {}, { ownSha = null } = {}) {
  const known = new Map();
  const checks = new Map();
  const state = { stop: null, refused: false, refusedRuns: false, said: new Set(), learnt: false };
  const own = options.own ?? { names: new Set(), suites: new Set() };
  own.names ??= new Set();
  own.suites ??= new Set();
  const say = (key, text) => {
    if (state.said.has(key)) return;
    state.said.add(key);
    log(`::warning title=Sessionly::${text}`);
  };
  const checksOn = async (sha) => {
    if (!checks.has(sha)) {
      const base = `/repos/${repo}/commits/${sha}`;
      checks.set(sha, {
        runs: await pages(api, `${base}/check-runs?filter=latest`, "check_runs"),
        statuses: await pages(api, `${base}/status`, "statuses"),
        suites: await pages(api, `${base}/check-suites`, "check_suites"),
      });
    }
    return checks.get(sha);
  };
  /** Which check runs on the commit this run is on are this run's: their names and suites are Sessionly's. */
  const learn = async () => {
    if (state.learnt) return;
    state.learnt = true;
    if (!isSha(ownSha)) return;
    const { runs } = await checksOn(ownSha);
    for (const run of runs) {
      if (!isThisRun(run, own)) continue;
      if (run.name != null) own.names.add(run.name);
      if (run.check_suite?.id != null) own.suites.add(run.check_suite.id);
    }
  };
  /** The check suites of the workflow runs the push of a commit started; null when GitHub would not say. */
  const pushSuitesOf = async (sha) => {
    if (state.refusedRuns) return null;
    try {
      const runs = await pages(api, `/repos/${repo}/actions/runs?head_sha=${sha}&event=push`, "workflow_runs");
      return new Set(runs.map((run) => run?.check_suite_id).filter((id) => id != null));
    } catch (err) {
      if (err.status === 403 && !err.rateLimited) {
        state.refusedRuns = true;
        say("runs", `GitHub would not say which workflow runs a merge commit's push started (${oneLine(err)}), so the CI of merge commits is not known. Give the job actions: read, or set ci: false.`);
        return null;
      }
      throw err;
    }
  };
  const of = async (sha, { merge = false } = {}) => {
    if (!isSha(sha)) return null;
    const key = `${merge ? "merge" : "head"}\n${sha}`;
    if (known.has(key)) return known.get(key);
    if (state.refused || state.stop) return null;
    if (api.remaining !== undefined && api.remaining < RATE_FLOOR) {
      state.stop = "GitHub allows this run few more requests";
      say("stop", `${state.stop}, so the CI of the commits left was not read. It is read at the next run.`);
      return null;
    }
    let read;
    try {
      await learn();
      const pushSuites = merge ? await pushSuitesOf(sha) : null;
      if (merge && !pushSuites) return null;
      const { runs, statuses, suites } = await checksOn(sha);
      read = { sha, ...reduceCi(runs, statuses, { ...options, own, suites, pushSuites }) };
    } catch (err) {
      if (err.status === 403 && !err.rateLimited) {
        state.refused = true;
        say("refused", `GitHub would not say what CI made of the commits (${oneLine(err)}). Give the job checks: read and statuses: read, or set ci: false. Nothing else is affected.`);
      } else if (err.status === 404 || err.status === 422) {
        say(`missing ${sha}`, `GitHub does not know commit ${sha.slice(0, 12)}, or will not show it (${oneLine(err)}): its CI is not known.`);
      } else if (err.rateLimited || err.status === 429) {
        state.stop = `GitHub's rate limit stopped this run (${oneLine(err)})`;
        say("stop", `${state.stop}, so the CI of the commits left was not read. It is read at the next run.`);
      } else {
        say(`failed ${sha}`, `The CI of commit ${sha.slice(0, 12)} could not be read (${oneLine(err)}). It is tried again at the next run.`);
      }
      return null;
    }
    known.set(key, read);
    return read;
  };
  return { of, state, own };
}

/** A commit's CI in a few words, for the log. */
export function sayCi(ci) {
  const checks = (n) => `${n} ${n === 1 ? "check" : "checks"}`;
  if (ci.state === "failure") return `red (${ci.failed} of ${checks(ci.total)} failed)`;
  if (ci.state === "success") return `green (${checks(ci.total)})`;
  if (ci.state === "pending") return `still running (${checks(ci.total)})`;
  return ci.cancelled > 0 ? `nothing to go by (${checks(ci.cancelled)} cancelled)` : "no checks";
}

/**
 * Tell the server what CI said of heads and merge commits, where anything
 * was read. A server from before this is said, and nothing is sent. What
 * the server kept, or null when nothing was sent.
 */
export async function sendCi(server, name, { heads = [], merges = [] }, log) {
  if (heads.length === 0 && merges.length === 0) return null;
  try {
    return await server("PUT", "/prs/ci", { repo: name, heads, merges });
  } catch (err) {
    if (err.status === 404 || (err.status === 403 && /only reports pull requests/.test(err.message ?? ""))) {
      log(`::warning title=Sessionly::The Sessionly server does not keep what CI said of pull requests' commits (${err.message}): it is from before that. Nothing else is affected.`);
      return null;
    }
    throw err;
  }
}

/**
 * On a schedule: the server says which heads are still pending and which
 * merge commits it knows nothing of yet, their CI is read, and what it
 * came to goes back. A server from before this is said and skipped. This
 * run's check runs are on the commit it runs on (`GITHUB_SHA`).
 */
export async function runCi(env, { api, server, repo, host, log }) {
  const name = `${host}/${repo}`;
  let due;
  try {
    due = await server("GET", `/prs/ci/due?repo=${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status === 404 || (err.status === 403 && /only reports pull requests/.test(err.message ?? ""))) {
      log(`::warning title=Sessionly::The Sessionly server does not keep what CI said of pull requests' commits (${err.message}): it is from before that. Nothing else is affected.`);
      return { skipped: true, heads: [], merges: [] };
    }
    if (err.status === 403) throw new Error(`the Sessionly server would not say which commits' CI is due (${err.message}): the token needs the ci or admin role`);
    throw err;
  }
  const asked = { heads: Array.isArray(due?.heads) ? due.heads : [], merges: Array.isArray(due?.merges) ? due.merges : [] };
  if (asked.heads.length === 0 && asked.merges.length === 0) {
    log("No commit was due for its CI to be read.");
    return { heads: [], merges: [] };
  }
  const reading = ciReading(api, repo, log, ciOptions(env), { ownSha: (env.GITHUB_SHA ?? "").trim() });
  const read = async (list, merge) => {
    const out = [];
    for (const { number, sha } of list) {
      const ci = await reading.of(sha, { merge });
      if (ci) out.push({ number, ...ci });
    }
    return out;
  };
  const heads = await read(asked.heads, false);
  const merges = await read(asked.merges, true);
  for (const head of heads) log(`#${head.number}: CI at ${head.sha.slice(0, 12)} is ${sayCi(head)}.`);
  for (const merge of merges) log(`#${merge.number}: CI at the commit it was merged as, ${merge.sha.slice(0, 12)}, is ${sayCi(merge)}.`);
  const stored = await sendCi(server, name, { heads, merges }, log);
  const red = [...heads, ...merges].filter((c) => c.state === "failure").length;
  log(`Read CI for ${heads.length + merges.length} of ${asked.heads.length + asked.merges.length} commits of ${repo} that were due: ${red === 0 ? "none" : red} red.`);
  return { heads, merges, stored };
}

/**
 * After a pull request was reported: the CI of its head, of the heads the
 * server says are still pending, and once merged of the commit it was
 * merged as, read now and sent. Whatever is not known yet is read on
 * `workflow_run` or at the next scheduled run. This run's check runs are on
 * the head (a `pull_request` run's are), or on the commit it runs on.
 */
export async function reportCi(env, { api, server, repo, host, log }, report, answer) {
  const name = `${host}/${repo}`;
  const ownSha = isSha(report.head_sha) ? report.head_sha : (env.GITHUB_SHA ?? "").trim();
  const reading = ciReading(api, repo, log, ciOptions(env), { ownSha });
  const pending = Array.isArray(answer?.ci_pending) ? answer.ci_pending.filter((p) => p && isSha(p.sha)) : [];
  const shas = [...new Set([report.head_sha, ...pending.map((p) => p.sha)].filter(isSha))];
  const heads = [];
  for (const sha of shas) {
    const ci = await reading.of(sha);
    if (ci) heads.push({ number: report.number, ...ci });
  }
  const merges = [];
  if (report.state === "merged" && isSha(report.merge_commit_sha)) {
    const ci = await reading.of(report.merge_commit_sha, { merge: true });
    if (ci) merges.push({ number: report.number, ...ci });
  }
  for (const head of heads) log(`CI at ${head.sha.slice(0, 12)} is ${sayCi(head)}.`);
  for (const merge of merges) log(`CI at the commit it was merged as, ${merge.sha.slice(0, 12)}, is ${sayCi(merge)}.`);
  return { heads, merges, stored: await sendCi(server, name, { heads, merges }, log) };
}

/** A repository's name as GitHub gives it, lower-cased, or null. */
const fullName = (repo) => (typeof repo?.full_name === "string" ? repo.full_name.toLowerCase() : null);

/**
 * A workflow of the repository's own CI finished (`workflow_run`,
 * completed): the CI of the commit it ran on is read whole and sent, as a
 * head of the pull requests that commit is in and, when the run was started
 * by the push of a commit a pull request was merged as, as that pull
 * request's merge CI. Which pull requests is asked of GitHub (the event
 * names none for a fork's): of this repository for its own commits, and of
 * the fork for a fork's, which this repository does not answer for; only
 * pull requests into this repository count. The server keeps it where it
 * knows the commit.
 */
export async function runWorkflowRun(env, payload, { api, server, repo, host, log }) {
  const name = `${host}/${repo}`;
  const run = payload?.workflow_run;
  if (payload?.action && payload.action !== "completed") {
    log(`This workflow run has ${payload.action}, not completed: its CI is read when it has.`);
    return { skipped: true, heads: [], merges: [] };
  }
  const sha = run?.head_sha;
  if (!isSha(sha)) throw new Error("the workflow_run event names no commit (workflow_run.head_sha): nothing to read the CI of");
  const numbers = new Set((Array.isArray(run.pull_requests) ? run.pull_requests : []).map((p) => p?.number).filter((n) => Number.isInteger(n) && n >= 1));
  const merged = [];
  // A fork's commit: this repository does not answer which pull requests it is in; the fork does.
  const head = fullName(run.head_repository);
  const askedOf = head && head !== repo.toLowerCase() && numbers.size === 0 ? run.head_repository.full_name : repo;
  try {
    const found = await api.request("GET", `/repos/${askedOf}/commits/${sha}/pulls?per_page=100`);
    for (const pull of Array.isArray(found) ? found : []) {
      if (!Number.isInteger(pull?.number) || pull.number < 1) continue;
      // The pull requests of this repository: a fork's own are not reported here.
      if (fullName(pull.base?.repo) && fullName(pull.base.repo) !== repo.toLowerCase()) continue;
      if (pull.merged_at && pull.merge_commit_sha === sha) merged.push(pull.number);
      else numbers.add(pull.number);
    }
  } catch (err) {
    if (err.status === 403 && !err.rateLimited) {
      log(`::warning title=Sessionly::GitHub would not say which pull requests commit ${sha.slice(0, 12)} is in (${oneLine(err)}). Give the job pull-requests: read; only the pull requests the event names are told.`);
    } else if (err.status !== 404 && err.status !== 422) throw err;
  }
  // The merge commit's CI is the checks its push started: a run a schedule or someone started on the branch's tip says nothing of the merge.
  const pushed = run.event === "push";
  if (numbers.size === 0 && (merged.length === 0 || !pushed)) {
    log(`Commit ${sha.slice(0, 12)} is in no pull request of ${repo}${merged.length > 0 ? ` but as a merge commit, and this run was not started by its push (${run.event ?? "no event"})` : ""}: nothing to tell the server.`);
    return { heads: [], merges: [] };
  }
  const reading = ciReading(api, repo, log, ciOptions(env), { ownSha: sha });
  const heads = [];
  if (numbers.size > 0) {
    const ci = await reading.of(sha);
    if (ci) {
      log(`CI at ${sha.slice(0, 12)} is ${sayCi(ci)}.`);
      heads.push(...[...numbers].sort((a, b) => a - b).map((number) => ({ number, ...ci })));
    }
  }
  const merges = [];
  if (merged.length > 0 && pushed) {
    const ci = await reading.of(sha, { merge: true });
    if (ci) {
      log(`CI at the commit merged as ${sha.slice(0, 12)} is ${sayCi(ci)}.`);
      merges.push(...merged.sort((a, b) => a - b).map((number) => ({ number, ...ci })));
    }
  }
  return { heads, merges, stored: await sendCi(server, name, { heads, merges }, log) };
}
