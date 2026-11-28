// CI: what the checks and statuses on a commit came to, read on GitHub and
// sent to the server as a state and counts. Of a pull request's head that
// says whether the push was red, and of the commit it was merged as whether
// the base branch went red after it. What ran, and what it said, stays on
// GitHub; the names of the checks that failed go only when asked for
// (`ci-check-names`). Sessionly's own workflow runs are left out, by the
// workflow file they run from, and whatever `ci-ignore` names; with
// `ci-only`, nothing but what that names counts.
import { RATE_FLOOR } from "./outcomes.mjs";

/** A check run's conclusion that is a failure, and one that is fine; `skipped`, `cancelled` and `stale` say nothing either way. */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const PASSED = new Set(["success", "neutral"]);
/** A status's state. */
const STATUS_FAILED = new Set(["failure", "error"]);
/** The app whose check suites are workflow runs. */
const ACTIONS = "github-actions";

/** No more names of failed checks than this are sent, each cut to this many characters. */
export const MOST_NAMES = 20;
export const NAME_LENGTH = 100;
/** No more check runs, statuses, check suites or workflow runs than this are read for one commit: past it, its CI is not known. */
export const MOST_CHECKS = 1000;
/** The events whose run has its check runs on the head it reports: there, a CI job sharing this run's file can be seen. */
const ON_THE_HEAD = new Set(["pull_request", "pull_request_target", "pull_request_review"]);

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

/**
 * A workflow file as GitHub names one, `.github/workflows/ci.yml`, from
 * however it was written: with `./` or `/` in front, or the name alone.
 */
export function workflowPath(text) {
  const given = String(text ?? "").trim().replace(/^\.?\/+/, "");
  if (!given) return null;
  return (given.includes("/") ? given : `.github/workflows/${given}`).toLowerCase();
}

/** Workflow files, separated by commas or new lines, as `workflowPath` names them. */
const listed = (text) => String(text ?? "").split(/[\n,]/).map(workflowPath).filter(Boolean);

/**
 * The workflow file this run is from: `GITHUB_WORKFLOW_REF` is
 * `owner/name/.github/workflows/sessionly.yml@refs/heads/main`, the path
 * ending at the `.yml@` (a branch may have `@` in its name).
 */
export function workflowFile(env) {
  const ref = (env.GITHUB_WORKFLOW_REF ?? "").trim();
  const ends = /^(.*?\.ya?ml)@/i.exec(ref);
  if (!ends) return null;
  const path = ends[1];
  const repo = (env.GITHUB_REPOSITORY ?? "").trim();
  return workflowPath(repo && path.toLowerCase().startsWith(`${repo.toLowerCase()}/`) ? path.slice(repo.length + 1) : path.replace(/^[^/]+\/[^/]+\//, ""));
}

/**
 * What the inputs say of reading CI: what to leave out, what alone to
 * count, which check run and workflow run are this job's, which workflow
 * files are Sessionly's (`sessionly-workflows` where set, `none` for no
 * file, else this run's own, in which case a CI job sharing the file is
 * looked for on a pull request event, `guard`), and whether to name failed
 * checks.
 */
export function ciOptions(env) {
  const on = (value) => /^(true|yes|on|1)$/i.test((value ?? "").trim());
  const named = (env.SESSIONLY_WORKFLOWS ?? "").trim();
  const file = workflowFile(env);
  return {
    ignore: naming(env.SESSIONLY_CI_IGNORE),
    only: naming(env.SESSIONLY_CI_ONLY),
    own: { checkRunId: (env.SESSIONLY_CHECK_RUN_ID ?? "").trim(), runId: (env.GITHUB_RUN_ID ?? "").trim(), name: null },
    files: new Set(named === "" ? (file ? [file] : []) : /^none$/i.test(named) ? [] : listed(named)),
    guard: named === "" && file != null && ON_THE_HEAD.has((env.GITHUB_EVENT_NAME ?? "").trim()),
    names: on(env.SESSIONLY_CI_CHECK_NAMES),
  };
}

/**
 * Whether a check run is this job's: the one whose id the job was given
 * (`check-run-id`), or, given none, any whose page is under this workflow
 * run's (`/runs/<run id>/`). The report runs beside the pull request's
 * checks, and must not count itself as one.
 */
function isThisJob(run, own) {
  if (own?.checkRunId) return String(run?.id) === own.checkRunId;
  return isThisRun(run, own);
}

/** Whether a check run is a job of this workflow run: its page is under this run's. */
const isThisRun = (run, own) => Boolean(own?.runId) && String(run?.details_url ?? "").includes(`/runs/${own.runId}/`);

/**
 * What check runs, statuses and check suites on one commit come to:
 * `failure` when any failed (or timed out), else `pending` while any is
 * still running or waiting (`action_required` is waiting for someone, as a
 * first-time contributor's workflows do), else `success` when any came out
 * well (neutral is well), else `none`: nothing to go by. Skipped runs never
 * count, in no direction (a job's `if:` said no); cancelled runs say
 * nothing either way, and are counted apart (`cancelled`): a push cancels
 * the run before it, and a commit whose runs were all cancelled has none.
 *
 * Left out: this job's own check run; every check run and suite of a
 * workflow run from one of Sessionly's files (`excluded`, suites mapped
 * from the commit's workflow runs); in `nameOnly` suites (a file CI jobs
 * share with this job) the check runs named as this job (`own.name`); and
 * what `ignore` names, or `only` does not. With `pushSuites`, GitHub Actions check runs and suites count only
 * among them (the runs the push of a merge commit started on its branch);
 * other apps' check runs and statuses always.
 *
 * A check suite without check runs is a workflow run that never had jobs,
 * read by its workflow run (`runsBySuite`): waiting for approval or still
 * queued is pending, failed to start is red; one that says `failure` with no
 * jobs is a run GitHub failed when its pull request was closed unapproved,
 * and is left out as nothing. The names of the failed ones only with `names`.
 */
export function reduceCi(checkRuns, statuses, { ignore = null, only = null, own = null, names = false, suites = [], runsBySuite = new Map(), excluded = new Set(), nameOnly = new Set(), pushSuites = null } = {}) {
  const counted = (name) => (!only || only(name)) && !(ignore && ignore(name));
  const ours = (run) => isThisJob(run, own) || excluded.has(run.check_suite?.id) || (nameOnly.has(run.check_suite?.id) && own?.name != null && run.name === own.name);
  const actions = (app) => app == null || app === ACTIONS;
  let failed = 0;
  let total = 0;
  let cancelled = 0;
  let pending = 0;
  const red = [];
  const withRuns = new Set();
  for (const run of checkRuns ?? []) {
    if (!run) continue;
    const suite = run.check_suite?.id;
    if (suite != null) withRuns.add(suite);
    if (run.conclusion === "skipped" || ours(run) || !counted(run.name)) continue;
    if (pushSuites && actions(run.app?.slug) && !pushSuites.has(suite)) continue;
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
    if (!suite || suite.app?.slug !== ACTIONS || withRuns.has(suite.id) || suite.latest_check_runs_count > 0 || excluded.has(suite.id)) continue;
    if (pushSuites && !pushSuites.has(suite.id)) continue;
    const run = runsBySuite.get(suite.id);
    if (!run || !counted(run.name)) continue;
    if (run.status !== "completed" || run.conclusion == null || run.conclusion === "action_required") {
      total += 1;
      pending += 1;
    } else if (run.conclusion === "startup_failure") {
      total += 1;
      failed += 1;
      red.push(run.name);
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

/** Every page of a list GitHub serves under `key`; past `MOST_CHECKS` items the list is too long to read (`tooMany`). */
async function pages(api, path, key) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const found = await api.request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = Array.isArray(found?.[key]) ? found[key] : [];
    items.push(...batch);
    if (items.length > MOST_CHECKS) throw Object.assign(new Error(`more than ${MOST_CHECKS} ${key.replace(/_/g, " ")} on the commit`), { tooMany: true });
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
 * Which check runs are Sessionly's is told by workflow file: a commit's
 * workflow runs (`actions: read`) say which check suite each file's runs
 * made, and those of Sessionly's files (`files`: `sessionly-workflows`, or
 * this run's own file) are left out, on every event alike. Without
 * `actions: read`, only this job's own check run is, and that is said once.
 * On a pull request event this run's check runs are on the head it reads
 * (`guard`): a job of this run there that is not this job, nor skipped, is
 * a CI job sharing this run's file, and that file is then not left out
 * whole, only the check runs named as this job, which is said once.
 *
 * `of(sha, { merge: true, base })` reads a merge commit: of GitHub Actions,
 * only the runs the push of it started on the branch count; without
 * `actions: read`, the merge's CI is not known.
 *
 * A read that failed for another reason than those (GitHub answered 500,
 * say) is `failed`, for a run told to fail on an error.
 */
export function ciReading(api, repo, log, options = {}) {
  const known = new Map();
  const cache = new Map();
  const state = { stop: null, refused: false, refusedRuns: false, said: new Set(), shared: new Set(), failed: [] };
  const files = options.files ?? new Set();
  const own = options.own ?? { checkRunId: "", runId: "", name: null };
  const say = (key, text) => {
    if (state.said.has(key)) return;
    state.said.add(key);
    log(`::warning title=Sessionly::${text}`);
  };
  /** One of a commit's lists, read once. */
  const read = async (sha, what) => {
    const key = `${what}\n${sha}`;
    if (!cache.has(key)) {
      const base = `/repos/${repo}/commits/${sha}`;
      cache.set(
        key,
        what === "runs"
          ? await pages(api, `${base}/check-runs?filter=latest`, "check_runs")
          : what === "statuses"
            ? await pages(api, `${base}/status`, "statuses")
            : await pages(api, `${base}/check-suites`, "check_suites"),
      );
    }
    return cache.get(key);
  };
  /** The workflow runs on a commit, by check suite; null when GitHub would not say (said once). */
  const workflowRuns = async (sha) => {
    const key = `workflows\n${sha}`;
    if (cache.has(key)) return cache.get(key);
    if (state.refusedRuns) return null;
    let found = null;
    try {
      const runs = await pages(api, `/repos/${repo}/actions/runs?head_sha=${sha}`, "workflow_runs");
      found = new Map(runs.filter((run) => run?.check_suite_id != null).map((run) => [run.check_suite_id, run]));
    } catch (err) {
      if (!(err.status === 403 && !err.rateLimited)) throw err;
      state.refusedRuns = true;
      say("runs", "GitHub would not say which workflow runs a commit's checks are from, so only this job's own check run is left out of CI, and the CI of merge commits is not known. Give the job actions: read.");
    }
    cache.set(key, found);
    return found;
  };
  const of = async (sha, { merge = false, base = null } = {}) => {
    if (!isSha(sha)) return null;
    const key = `${merge ? "merge" : "head"}\n${sha}`;
    if (known.has(key)) return known.get(key);
    if (state.refused || state.stop) return null;
    if (api.remaining !== undefined && api.remaining < RATE_FLOOR) {
      state.stop = "GitHub allows this run few more requests";
      say("stop", `${state.stop}, so the CI of the commits left was not read. It is read at the next run.`);
      return null;
    }
    let found;
    try {
      const runs = await workflowRuns(sha);
      if (merge && !runs) return null;
      const checkRuns = await read(sha, "runs");
      const excluded = new Set();
      const nameOnly = new Set();
      let pushSuites = null;
      if (runs) {
        const fileOf = (suite) => {
          const path = runs.get(suite)?.path;
          return typeof path === "string" ? path.toLowerCase() : null;
        };
        if (options.guard) {
          // A job of this run on this commit that is not this job, nor skipped, is a CI job in this run's file.
          for (const run of checkRuns) {
            if (!run || !isThisRun(run, own)) continue;
            if (own.checkRunId && String(run.id) === own.checkRunId && run.name != null) own.name = run.name;
            const file = fileOf(run.check_suite?.id);
            if (own.checkRunId && String(run.id) !== own.checkRunId && run.conclusion !== "skipped" && file && files.has(file)) state.shared.add(file);
          }
          if (state.shared.size > 0) say("shared", "A Sessionly job shares its workflow file with CI jobs, so only the check runs named as this job are left out of that file's. Set sessionly-workflows to the files that hold only Sessionly jobs, or none.");
        }
        for (const [suite] of runs) {
          const file = fileOf(suite);
          if (!file || !files.has(file)) continue;
          if (state.shared.has(file)) nameOnly.add(suite);
          else excluded.add(suite);
        }
        if (merge) pushSuites = new Set([...runs].filter(([, run]) => run.event === "push" && (base == null || run.head_branch === base)).map(([suite]) => suite));
      }
      found = {
        sha,
        ...reduceCi(checkRuns, await read(sha, "statuses"), {
          ...options,
          own,
          suites: await read(sha, "suites"),
          runsBySuite: runs ?? new Map(),
          excluded,
          nameOnly,
          pushSuites,
        }),
      };
    } catch (err) {
      if (err.tooMany) {
        say(`many ${sha}`, `Commit ${sha.slice(0, 12)} has ${oneLine(err)}: more than are read, so its CI is not known.`);
      } else if (err.status === 403 && !err.rateLimited) {
        state.refused = true;
        say("refused", `GitHub would not say what CI made of the commits (${oneLine(err)}). Give the job checks: read and statuses: read, or set ci: false. Nothing else is affected.`);
      } else if (err.status === 404 || err.status === 422) {
        say(`missing ${sha}`, `GitHub does not know commit ${sha.slice(0, 12)}, or will not show it (${oneLine(err)}): its CI is not known.`);
      } else if (err.rateLimited || err.status === 429) {
        state.stop = `GitHub's rate limit stopped this run (${oneLine(err)})`;
        say("stop", `${state.stop}, so the CI of the commits left was not read. It is read at the next run.`);
      } else {
        state.failed.push(err);
        say(`failed ${sha}`, `The CI of commit ${sha.slice(0, 12)} could not be read (${oneLine(err)}). It is tried again at the next run.`);
      }
      return null;
    }
    known.set(key, found);
    return found;
  };
  return { of, state };
}

/** What a run told to fail on an error raises for reads that failed: the first of them, saying how many. */
const failureOf = (failed) =>
  failed.length === 0 ? null : Object.assign(new Error(`the CI of ${failed.length} ${failed.length === 1 ? "commit" : "commits"} could not be read: ${oneLine(failed[0])}`), { status: failed[0].status });

/** A commit's CI in a few words, for the log. */
export function sayCi(ci) {
  const checks = (n) => `${n} ${n === 1 ? "check" : "checks"}`;
  if (ci.state === "failure") return `red (${ci.failed} of ${checks(ci.total)} failed)`;
  if (ci.state === "success") return `green (${checks(ci.total)})`;
  if (ci.state === "pending") return `still running (${checks(ci.total)} so far)`;
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
 * merge commits it knows nothing of yet (with the branch each was merged
 * into), their CI is read, and what it came to goes back. A server from
 * before this is said and skipped.
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
  const reading = ciReading(api, repo, log, ciOptions(env));
  const read = async (list, merge) => {
    const out = [];
    for (const { number, sha, base_ref } of list) {
      const ci = await reading.of(sha, { merge, base: typeof base_ref === "string" ? base_ref : null });
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
  // Reads that failed were said; told to fail on an error, the run does, with what was read sent.
  const failed = failureOf(reading.state.failed);
  if (failed && /^(true|yes|on|1)$/i.test((env.SESSIONLY_FAIL_ON_ERROR ?? "").trim())) throw failed;
  return { heads, merges, stored };
}

/**
 * After a pull request was reported: the CI of its head, of the heads the
 * server says are still pending, and once merged of the commit it was
 * merged as, read now and sent. Whatever is not known yet is read on
 * `workflow_run` or at the next scheduled run.
 */
export async function reportCi(env, { api, server, repo, host, log }, report, answer) {
  const name = `${host}/${repo}`;
  const reading = ciReading(api, repo, log, ciOptions(env));
  const pending = Array.isArray(answer?.ci_pending) ? answer.ci_pending.filter((p) => p && isSha(p.sha)) : [];
  const shas = [...new Set([report.head_sha, ...pending.map((p) => p.sha)].filter(isSha))];
  const heads = [];
  for (const sha of shas) {
    const ci = await reading.of(sha);
    if (ci) heads.push({ number: report.number, ...ci });
  }
  const merges = [];
  if (report.state === "merged" && isSha(report.merge_commit_sha)) {
    const ci = await reading.of(report.merge_commit_sha, { merge: true, base: report.base_ref ?? null });
    if (ci) merges.push({ number: report.number, ...ci });
  }
  for (const head of heads) log(`CI at ${head.sha.slice(0, 12)} is ${sayCi(head)}.`);
  for (const merge of merges) log(`CI at the commit it was merged as, ${merge.sha.slice(0, 12)}, is ${sayCi(merge)}.`);
  return { heads, merges, stored: await sendCi(server, name, { heads, merges }, log), failed: failureOf(reading.state.failed) };
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
      if (pull.merged_at && pull.merge_commit_sha === sha) merged.push({ number: pull.number, base: typeof pull.base?.ref === "string" ? pull.base.ref : null });
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
  const reading = ciReading(api, repo, log, ciOptions(env));
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
    for (const { number, base } of merged.sort((a, b) => a.number - b.number)) {
      const ci = await reading.of(sha, { merge: true, base });
      if (ci) merges.push({ number, ...ci });
    }
    if (merges.length > 0) log(`CI at the commit merged as ${sha.slice(0, 12)} is ${sayCi(merges[0])}.`);
  }
  return { heads, merges, stored: await sendCi(server, name, { heads, merges }, log) };
}
