// Entry point: read the pull request from GitHub, send the report to the
// Sessionly server, and show what it answers.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { github, readPull, upsertComment } from "./github.mjs";
import { ignoring } from "./lines.mjs";
import { buildReport, MARKER, render } from "./report.mjs";

const on = (value) => /^(true|yes|on|1)$/i.test((value ?? "").trim());

/** What prompted this run, in the words the server stores. */
export function eventName(name, action) {
  if (name === "pull_request" || name === "pull_request_target") return action ?? "unknown";
  if (name === "pull_request_review") return "review";
  if (name === "pull_request_review_comment") return "review_comment";
  return name === "workflow_dispatch" ? "manual" : (name ?? "unknown");
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
    throw new Error(`the Sessionly server answered ${response.status}: ${body.error ?? "no reason given"}`);
  }
  return body.attribution;
}

/**
 * One run. `env` is the process environment; `api` and `deliver` can be
 * replaced, which is how the tests run it without a network.
 */
export async function run(env, { api, deliver = send, log = console.log } = {}) {
  const need = (name, what) => {
    if (!env[name]) throw new Error(`${what} is missing`);
    return env[name];
  };
  const url = need("SESSIONLY_URL", "the url input");
  const token = need("SESSIONLY_TOKEN", "the token input");
  const repo = need("GITHUB_REPOSITORY", "GITHUB_REPOSITORY");
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const number = Number(env.SESSIONLY_PR_NUMBER || payload.pull_request?.number || payload.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("this run is not about a pull request; set the pr-number input to report one");
  }
  api ??= github(need("SESSIONLY_GITHUB_TOKEN", "the github-token input"), env.GITHUB_API_URL || undefined);

  const host = new URL(env.GITHUB_SERVER_URL || "https://github.com").host;
  const ignored = ignoring(env.SESSIONLY_IGNORE ?? "");
  const otherNames = (env.SESSIONLY_OTHER_NAMES ?? "").split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
  const named = (report) => {
    if (otherNames.length > 0) report.aliases = otherNames.map((name) => `${host}/${name}`);
    return report;
  };
  const data = await readPull(api, repo, number);
  if (on(env.SESSIONLY_BACKFILL)) {
    const then = await whenOpened(api, repo, data);
    if (then) {
      // As it was before any review: the server keeps the first report it gets.
      const opened = buildReport({ ...data, ...then, reviews: [], comments: [], event: "opened", host, ignored });
      await deliver(url, token, named({ ...opened, state: "open", merged_at: null, closed_at: null }));
    }
  }
  const report = named(
    buildReport({ ...data, event: eventName(env.GITHUB_EVENT_NAME, payload.action), host, ignored }),
  );
  const attribution = await deliver(url, token, report);
  const text = render(report, attribution);

  log(`Reported ${report.repo}#${number}: ${attribution.now.agent_lines} of ${attribution.now.lines} added lines matched to a coding agent.`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `lines=${attribution.now.lines}\nagent-lines=${attribution.now.agent_lines}\n`);
  }
  if (on(env.SESSIONLY_SUMMARY ?? "true") && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  if (on(env.SESSIONLY_COMMENT)) await upsertComment(api, repo, number, MARKER, text);
  return { report, attribution, text };
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
