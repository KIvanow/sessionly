// Entry point: read the pull request from GitHub, send the report to the
// Sessionly server, and show what it answers.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { branchFor, filesAt, github, listPulls, readPull, upsertComment } from "./github.mjs";
import { fileHashes, ignoring } from "./lines.mjs";
import { gitIn } from "./history.mjs";
import { runOutcomes } from "./outcomes.mjs";
import { buildReport, MARKER, render, renderAfterMerge, renderMany, renderOutcomes } from "./report.mjs";

const on = (value) => /^(true|yes|on|1)$/i.test((value ?? "").trim());

/** What prompted this run, in the words the server stores. */
export function eventName(name, action) {
  if (name === "pull_request" || name === "pull_request_target") return action ?? "unknown";
  if (name === "pull_request_review") return "review";
  if (name === "pull_request_review_comment") return "review_comment";
  return name === "workflow_dispatch" ? "manual" : (name ?? "unknown");
}

/**
 * No more pull requests than this are reported in one run. Each takes six
 * requests to GitHub, eight with `backfill`, and a workflow's token is
 * allowed a thousand an hour.
 */
export const MOST_AT_ONCE = 100;

/** How far back `pr-number: all` goes when `since` does not say. */
const SINCE_DAYS = 90;

/**
 * Which pull requests the `pr-number` input asks for: one (`7`), those
 * numbered from one to another (`20-60`), or the latest (`all`). Null if it
 * is none of these.
 */
export function wanted(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (text === "all") return { all: true };
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(text);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    // Beyond what a number holds exactly, one less is the same number again.
    return from >= 1 && from <= to && Number.isSafeInteger(to) ? { from, to } : null;
  }
  const number = Number(text);
  return text !== "" && Number.isSafeInteger(number) && number >= 1 ? { number } : null;
}

/**
 * What a pull request looked like when it was opened: its commits up to
 * then, and the files they changed. Null if nothing was pushed since, or if
 * the commits no longer say (a rebase gives them all a later date).
 */
export async function whenOpened(api, repo, { pull, commits }) {
  const opened = Date.parse(pull.created_at) + 60_000;
  const before = commits.filter((c) => Date.parse(c.commit?.committer?.date ?? "") <= opened);
  const last = before.at(-1);
  if (!last || !pull.base?.sha || last.sha === commits.at(-1)?.sha) return null;
  const compared = await api.request("GET", `/repos/${repo}/compare/${pull.base.sha}...${last.sha}`);
  return Array.isArray(compared?.files) ? { commits: before, files: compared.files } : null;
}

/** Send a report; returns the server's attribution. */
export async function send(url, token, report) {
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/v1/prs`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "sessionly-action" },
    body: JSON.stringify(report),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(`the Sessionly server answered ${response.status}: ${body.error ?? "no reason given"}`), { status: response.status });
  }
  return body.attribution;
}

/** Ask the server something, or tell it; what it answers. A refusal is an error with its status. */
export async function ask(url, token, method, path, body) {
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "sessionly-action" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(`the Sessionly server answered ${response.status}: ${answer.error ?? "no reason given"}`), {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
    });
  }
  return answer;
}

/**
 * No more files than this are read from GitHub in one run of counting after
 * merging. They are asked for fifty at a time, so this is four hundred
 * requests of the thousand a workflow's token is allowed in an hour, and one
 * pull request, of five thousand files at most, is a hundred. The pull
 * requests left over are still due at the next run.
 */
export const MOST_FILES = 20_000;

/**
 * Count merged pull requests' agent lines again on the branch they were
 * merged into, 7 and 30 days after: the server says which are due and which
 * files to read, the files are read as they are on that branch now, and
 * their lines go back as hashes. A scheduled run does this, and so does the
 * `after-merge` input. Nothing is written on any pull request.
 */
async function runAfterMerge(env, { api, server, repo, host, log, url }) {
  const name = `${host}/${repo}`;
  let due;
  try {
    due = (await server("GET", `/prs/due?repo=${encodeURIComponent(name)}`)).due;
  } catch (err) {
    // A server from before this has no such address, and tells a ci token so.
    if (err.status === 403 || err.status === 404) {
      throw new Error(`the Sessionly server does not count pull requests after merging (${err.message}): it is from before that, and needs updating`);
    }
    throw err;
  }
  if (!Array.isArray(due)) throw new Error("the Sessionly server did not say which pull requests are due");
  const counted = [];
  const failed = [];
  let left = MOST_FILES;
  let later = 0;
  // The same branch, at the same commit, for many of them.
  const branches = new Map();
  for (const pull of due) {
    // The first is read however many files it has: otherwise it would never be.
    if (pull.paths.length > left && left < MOST_FILES) {
      later += 1;
      continue;
    }
    left -= pull.paths.length;
    try {
      const asked = pull.base_ref ?? "";
      if (!branches.has(asked)) branches.set(asked, await branchFor(api, repo, pull.base_ref));
      // Every file at the one commit the branch was at when it was first looked at.
      const { branch, sha } = branches.get(asked);
      const texts = await filesAt(api, repo, sha, pull.paths);
      const files = pull.paths.map((path) => ({ path, hashes: texts.get(path) == null ? [] : fileHashes(texts.get(path)) }));
      // Which ages these were read for: one reached since is asked for at the next run.
      const { stored } = await server("PUT", "/prs/after-merge", { repo: name, number: pull.number, checkpoints: pull.checkpoints, files });
      for (const row of stored ?? []) {
        counted.push({ number: pull.number, branch, ...row });
        const days = row.checkpoint === "7d" ? 7 : 30;
        log(`#${pull.number}: ${row.surviving} of ${row.agent_lines} agent lines are still on ${branch}, ${days} days after it was merged.`);
      }
    } catch (err) {
      const why = String(err.message ?? err).replace(/\r?\n/g, " ");
      // What the server says of one count is about that one. Anything else, from it or from GitHub, the next would meet too.
      const aboutThisOne = err.status === 422 || err.status === 404 || err.status === 400 || err.status === 413;
      if (!aboutThisOne) throw new Error(`${why}: #${pull.number} and the ones after it were not counted`);
      failed.push(pull.number);
      log(`::warning title=Sessionly::#${pull.number} could not be counted (${why}). It is tried again at the next run.`);
    }
  }
  if (later > 0) {
    log(`::warning title=Sessionly::${later} more pull ${later === 1 ? "request is" : "requests are"} due and left for the next run: at most ${MOST_FILES} files are read at once.`);
  }
  const pulls = new Set(counted.map((row) => row.number)).size;
  log(`Counted ${pulls === 0 ? "no" : pulls} merged pull ${pulls === 1 ? "request" : "requests"} of ${repo} again.`);
  if (on(env.SESSIONLY_SUMMARY ?? "true") && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderAfterMerge(counted, url, failed)}\n`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} merged pull requests could not be counted: ${failed.map((n) => `#${n}`).join(", ")}`);
  }
  return { counted, later };
}

/**
 * One run. `env` is the process environment; `api`, `deliver` and `server`
 * can be replaced, which is how the tests run it without a network.
 */
export async function run(env, { api, deliver = send, server, log = console.log, git } = {}) {
  const need = (name, what) => {
    if (!env[name]) throw new Error(`${what} is missing`);
    return env[name];
  };
  const url = need("SESSIONLY_URL", "the url input");
  const token = need("SESSIONLY_TOKEN", "the token input");
  const repo = need("GITHUB_REPOSITORY", "GITHUB_REPOSITORY");
  // A run started by a schedule that names no pull request has none to report: it is for the
  // merged ones that are due. One that names some (`pr-number: all`, each night) reports those, as before.
  const numbered = (env.SESSIONLY_PR_NUMBER ?? "").trim() !== "";
  if (on(env.SESSIONLY_AFTER_MERGE) && numbered) {
    throw new Error("the after-merge and pr-number inputs are both set: a run reports pull requests or counts merged ones again, not both. Use two steps.");
  }
  if (on(env.SESSIONLY_AFTER_MERGE) || (env.GITHUB_EVENT_NAME === "schedule" && !numbered)) {
    api ??= github(need("SESSIONLY_GITHUB_TOKEN", "the github-token input"), env.GITHUB_API_URL || undefined, env.GITHUB_GRAPHQL_URL || undefined);
    server ??= (method, path, body) => ask(url, token, method, path, body);
    const host = new URL(env.GITHUB_SERVER_URL || "https://github.com").host;
    // Both, each whatever the other does: a count that fails does not keep
    // later commits from being read, nor the other way round. The first
    // failure is the run's.
    let counts = { counted: [], later: 0 };
    let failure;
    try {
      counts = await runAfterMerge(env, { api, server, repo, host, log, url });
    } catch (err) {
      failure = err;
    }
    let outcomes;
    if (on(env.SESSIONLY_OUTCOMES ?? "true")) {
      try {
        git ??= gitIn(env.GITHUB_WORKSPACE || process.cwd(), spawnSync);
        outcomes = await runOutcomes(env, { api, server, repo, host, log, git });
        if (on(env.SESSIONLY_SUMMARY ?? "true") && env.GITHUB_STEP_SUMMARY && outcomes.stored.length > 0) {
          appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderOutcomes(outcomes.stored, url)}\n`);
        }
      } catch (err) {
        failure ??= Object.assign(new Error(`later commits were not read: ${err.message ?? err}`), { status: err.status });
      }
    }
    if (failure) throw failure;
    return { ...counts, outcomes };
  }
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const which = wanted(env.SESSIONLY_PR_NUMBER || payload.pull_request?.number || payload.number);
  if (!which) {
    throw new Error(
      "this run is not about a pull request; set the pr-number input to report one (7), several (20-60) or the latest (all)",
    );
  }
  api ??= github(need("SESSIONLY_GITHUB_TOKEN", "the github-token input"), env.GITHUB_API_URL || undefined);

  const host = new URL(env.GITHUB_SERVER_URL || "https://github.com").host;
  const ignored = ignoring(env.SESSIONLY_IGNORE ?? "");
  const otherNames = (env.SESSIONLY_OTHER_NAMES ?? "").split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
  const named = (report) => {
    if (otherNames.length > 0) report.aliases = otherNames.map((name) => `${host}/${name}`);
    return report;
  };
  /** Send a report. A failure is marked as the server's, which a run of several goes by. */
  const sendTo = async (report) => {
    try {
      return await deliver(url, token, report);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { sending: true });
    }
  };
  /** Read one pull request and report it; what was read comes back with what the server answered. */
  const reportOne = async (number, event) => {
    const data = await readPull(api, repo, number);
    if (on(env.SESSIONLY_BACKFILL)) {
      const then = await whenOpened(api, repo, data);
      if (then) {
        // As it was before any review: the server keeps the lines of the first
        // report it gets, and takes the rest from the latest, which is the one
        // that follows. It says nothing of reviews and comments, so that those
        // the server has stay; nor whose feedback its rounds followed, so that
        // none are taken to be known if the report that follows fails.
        const { feedback, feedback_total, review_round_authors, ...opened } = buildReport({ ...data, ...then, reviews: [], comments: [], conversation: [], event: "opened", host, ignored });
        await sendTo(named({ ...opened, state: "open", merged_at: null, closed_at: null }));
      }
    }
    const report = named(buildReport({ ...data, event, host, ignored }));
    const attribution = await sendTo(report);
    log(`Reported ${report.repo}#${number}: ${attribution.now.agent_lines} of ${attribution.now.lines} added lines matched to a coding agent.`);
    return { data, report, attribution };
  };

  if (which.number === undefined) return runMany(env, which, { api, repo, reportOne, log, url });

  const number = which.number;
  const { data, report, attribution } = await reportOne(number, eventName(env.GITHUB_EVENT_NAME, payload.action));
  const text = render(report, attribution, url);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `lines=${attribution.now.lines}\nagent-lines=${attribution.now.agent_lines}\n`);
  }
  if (on(env.SESSIONLY_SUMMARY ?? "true") && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  // On unless switched off. The report has been sent by now: a comment that
  // cannot be written (the job was not given pull-requests: write) is said,
  // and takes nothing back.
  if (on(env.SESSIONLY_COMMENT ?? "true")) {
    try {
      await upsertComment(api, repo, number, MARKER, text, data.conversation);
    } catch (err) {
      const why = String(err.message ?? err).replace(/\r?\n/g, " ");
      log(
        `::warning title=Sessionly::The figures could not be posted as a comment (${why}). ` +
          "Give the job `pull-requests: write`, or set `comment: false`. They are on the run's summary page.",
      );
    }
  }
  return { report, attribution, text };
}

/**
 * Report several pull requests in one run: the latest ones, or those
 * numbered from one to another. For bringing a repository's earlier pull
 * requests up to date, so nothing is written on them: no comment is posted
 * or changed, whatever the `comment` input says. One that cannot be reported
 * is said and the rest go on; the run fails at the end if any did.
 */
async function runMany(env, which, { api, repo, reportOne, log, url }) {
  let numbers;
  let more = 0;
  // Where the ones left for another run begin.
  let from = which.from;
  if (which.all) {
    const since = env.SESSIONLY_SINCE ? Date.parse(env.SESSIONLY_SINCE) : Date.now() - SINCE_DAYS * 86_400_000;
    if (Number.isNaN(since)) throw new Error(`the since input is not a date: ${env.SESSIONLY_SINCE}`);
    const found = await listPulls(api, repo, since, MOST_AT_ONCE);
    numbers = found.numbers;
    more = found.more;
    // Numbers go by when a pull request was created: none before this one is
    // from `since` on, so the range to go on with keeps to it.
    from = found.lowest;
  } else {
    // The latest first, as `all` has them. A number in between may be an
    // issue's: those are passed over below.
    numbers = [];
    for (let n = which.to; n >= which.from && numbers.length < MOST_AT_ONCE; n -= 1) numbers.push(n);
    more = which.to - which.from + 1 - numbers.length;
  }

  const reported = [];
  const failed = [];
  // Numbers in a range that turned out not to be pull requests.
  let passed = 0;
  // The first one not reported, when GitHub or the server would take no more.
  let stopped;
  let serverSaid;
  for (const number of numbers) {
    try {
      const { report, attribution } = await reportOne(number, "manual");
      reported.push({ report, attribution });
    } catch (err) {
      const why = String(err.message ?? err).replace(/\r?\n/g, " ");
      // Issues and pull requests are numbered together.
      if (!which.all && new RegExp(`answered 404 to GET /repos/[^ ]+/pulls/${number}:`).test(why)) {
        passed += 1;
        continue;
      }
      // The server's refusal is about this report only when it says the report
      // is wrong or too large. Anything else (the token, too many requests, no
      // answer at all) the next would meet too, after six more requests to GitHub.
      if (err.sending && ![400, 413, 422].includes(err.status)) {
        stopped = number;
        serverSaid = why;
        log(`::warning title=Sessionly::#${number} could not be sent (${why}), and neither could the ones after it: the run stops here.`);
        break;
      }
      // The ones after it would get the same answer: they are left for a later run.
      if (/GitHub answered (403|429) to .*rate limit/i.test(why)) {
        stopped = number;
        log(
          `::warning title=Sessionly::GitHub allows this run no more requests for now (${why}). ` +
            `Run again later with pr-number ${from ?? numbers.at(-1)}-${number} for #${number} and the ones before it.`,
        );
        break;
      }
      failed.push(number);
      log(`::warning title=Sessionly::#${number} could not be reported (${why}).`);
    }
  }
  const oldest = numbers.at(-1);
  if (more !== 0 && stopped === undefined) {
    // How many, and where they begin, is not known when GitHub's search would not say.
    const left = more === null ? "More were" : `${more} more ${more === 1 ? "was" : "were"}`;
    const within = from === undefined ? " (a range takes no notice of since: narrow it to stay within that)" : "";
    log(
      `::warning title=Sessionly::${left} left for another run: at most ${MOST_AT_ONCE} are reported at once. ` +
        `Run again with pr-number ${from ?? 1}-${oldest - 1} for the ones before these${within}.`,
    );
  }
  log(`Reported ${reported.length} pull ${reported.length === 1 ? "request" : "requests"} of ${repo}.`);
  if (on(env.SESSIONLY_SUMMARY ?? "true") && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderMany(reported, url, failed)}\n`);
  }
  if (serverSaid !== undefined) {
    throw new Error(`${serverSaid}: #${stopped} and the ones before it were not reported`);
  }
  if (stopped !== undefined) {
    throw new Error(`GitHub allowed no more requests: #${stopped} and the ones before it were not reported`);
  }
  // Every number an issue's is unlikely: a token that cannot see the repository is answered the same.
  if (numbers.length > 0 && passed === numbers.length) {
    throw new Error(
      `none of #${which.from} to #${which.to} is a pull request the github-token can read: GitHub answered 404 to each. ` +
        "In a private repository that is also what a token without access to it is told.",
    );
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${numbers.length} pull requests could not be reported: ${failed.map((n) => `#${n}`).join(", ")}`);
  }
  return { reported, more };
}

// Run when started by the Action, not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.env).catch((err) => {
    // A problem with the report should not block anyone's pull request.
    const fail = on(process.env.SESSIONLY_FAIL_ON_ERROR);
    console.log(`::${fail ? "error" : "warning"} title=Sessionly::${String(err.message ?? err).replace(/\r?\n/g, " ")}`);
    process.exitCode = fail ? 1 : 0;
  });
}
