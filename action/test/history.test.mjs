import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gitIn, parseBatch, parseDiff, unmoved, unquote } from "../src/history.mjs";
import { lineHash } from "../src/lines.mjs";
import { run } from "../src/main.mjs";
import { chunks, COMMITS_AT_ONCE, runOutcomes, scanBranch } from "../src/outcomes.mjs";

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const DAY = 86_400;
const START = Date.parse("2026-10-01T09:00:00Z") / 1000;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

/** A repository with commits at pinned times, its main branch also as origin's. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "sessionly-history-"));
  dirs.push(dir);
  const sh = (args, at = START) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_") && !/_(DATE|NAME|EMAIL)$/.test(name)) delete env[name];
    const done = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
    return done.stdout.trim();
  };
  sh(["init", "-q", "--initial-branch", "main"]);
  sh(["config", "commit.gpgsign", "false"]);
  const write = (path, lines) => writeFileSync(join(dir, path), lines.length ? `${lines.join("\n")}\n` : "");
  const commit = (message, at) => {
    sh(["add", "-A"], at);
    sh(["commit", "-q", "--allow-empty", "-m", message], at);
    return sh(["rev-parse", "HEAD"]);
  };
  const publish = () => sh(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return { dir, sh, write, commit, publish, remove: (path) => unlinkSync(join(dir, path)) };
}

const L = (n) => `line_${n}(${n});`;
const hashes = (...ns) => ns.map((n) => lineHash(L(n))).sort();

/** A repository where #1 was merged, and later commits did things to its lines. */
function history() {
  const r = repository();
  r.write("readme.md", ["hello there"]);
  const base = r.commit("Start", START - DAY);
  r.write("a.ts", [1, 2, 3, 4, 5, 6].map(L));
  r.write("b.ts", [10, 11, 12].map(L));
  const merge = r.commit("Add the parser (#1)", START);
  r.write("a.ts", [3, 4, 5, 6, 7].map(L));
  const fix = r.commit("fix: wrong argument to compute", START + DAY);
  // b.ts moved to c.ts whole
  r.remove("b.ts");
  r.write("c.ts", [10, 11, 12].map(L));
  const moved = r.commit("Move b into c", START + 2 * DAY);
  r.write("c.ts", [10].map(L));
  const rework = r.commit("Shorter c", START + 3 * DAY);
  r.sh(["revert", "--no-edit", rework], START + 4 * DAY);
  const revert = r.sh(["rev-parse", "HEAD"]);
  r.sh(["revert", "--no-edit", revert], START + 5 * DAY);
  const reapply = r.sh(["rev-parse", "HEAD"]);
  // Too large to read whole: not counted, though it takes two of #1's lines.
  r.write("a.ts", [5, 6, 7].map(L));
  r.write("vendor.js", Array.from({ length: 100_001 }, (_, i) => `v${i}();`));
  const huge = r.commit("Vendor it", START + 6 * DAY);
  r.publish();
  return { r, base, merge, fix, moved, rework, revert, reapply, huge };
}

const BRANCH = (merge) => ({
  base_ref: "main",
  since: iso(START),
  until: iso(START + 30 * DAY),
  pulls: [{ number: 1, merged_at: iso(START), merge_commit_sha: merge, since: iso(START), paths: ["a.ts", "b.ts"] }],
});

/** GitHub as far as a scan asks it: which pull request a commit came with, and the labels of what that closes. */
function github(pullsOf = {}, labels = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      const sha = /\/commits\/([0-9a-f]+)\/pulls/.exec(path)?.[1];
      return sha ? (pullsOf[sha] ?? []) : null;
    },
    graphql: async (query) => {
      calls.push("GRAPHQL");
      const repository = {};
      for (const [, key, n] of query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) {
        repository[key] = { closingIssuesReferences: { nodes: [{ labels: { nodes: (labels[n] ?? []).map((name) => ({ name })) } }] } };
      }
      return { repository };
    },
  };
}

test("git's patches are read for removed and added lines, moved ones taken out", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1 @@",
    "-gone();",
    "---x;",
    "+kept();",
    'diff --git "a/sp ace\\303\\251.ts" "b/sp ace\\303\\251.ts"',
    "--- /dev/null",
    '+++ "b/sp ace\\303\\251.ts"',
    "@@ -0,0 +1 @@",
    "+gone();",
  ].join("\n");
  const files = parseDiff(diff);
  assert.deepEqual([...files.keys()], ["x.ts", "sp aceé.ts"]);
  assert.deepEqual([...files.get("x.ts").removed.keys()], [lineHash("gone();"), lineHash("--x;")]);
  const { files: left, removedTotal, moves } = unmoved(files);
  // gone() moved to the other file
  assert.deepEqual(moves, [["x.ts", "sp aceé.ts", lineHash("gone();"), 1]]);
  assert.equal(removedTotal, 1);
  assert.equal(left.get("sp aceé.ts").added.size, 0);
  assert.equal(unquote('a\\"b\\\\c\\td'), 'a"b\\c\td');
});

test("messages are read by their size, whatever they hold", () => {
  const sha = "a".repeat(40);
  const message = `tree x\nencoding latin1\n\nCaf\xe9\n${"b".repeat(40)} commit 5\n`;
  const object = Buffer.from(message, "latin1");
  const out = Buffer.concat([Buffer.from(`${sha} commit ${object.length}\n`), object, Buffer.from(`\n${"c".repeat(40)} missing\n`)]);
  assert.deepEqual([...parseBatch(out)], [[sha, `Café\n${"b".repeat(40)} commit 5`]]);
});

test("a base branch's later commits are read with git, and only what they did to the files asked for goes out", async () => {
  const h = history();
  const git = gitIn(h.r.dir, spawnSync);
  const landed = iso(START + DAY + 3600);
  const api = github(
    {
      [h.fix]: [{ number: 5, merged_at: landed, base: { ref: "main" }, title: "Fix the argument", head: { ref: "fix/arg" }, body: "Closes #9" }],
      // what the revert names landed with #6
      [h.rework]: [{ number: 6, merged_at: iso(START + 3 * DAY), base: { ref: "main" }, title: "Shorter", head: { ref: "ann/c" }, body: "" }],
    },
    { 5: ["Bug"] },
  );
  const scan = await scanBranch({ git, api, repo: "acme/web", host: "github.com", branch: BRANCH(h.merge), now: (START + 7 * DAY) * 1000 });
  assert.equal(scan.stopped, false);
  assert.equal(scan.tip, h.huge);
  assert.deepEqual(scan.pulls, [{ number: 1, merge_commit_sha: h.merge, found: true }]);
  // the merge itself and the commit before it are not later; the one too large to read whole is not counted
  assert.deepEqual(scan.commits.map((c) => c.sha), [h.fix, h.moved, h.rework, h.revert, h.reapply]);
  const [fix, moved, rework, revert, reapply] = scan.commits;
  assert.deepEqual(fix.files, [{ path: "a.ts", removed: hashes(1, 2), added: hashes(7) }]);
  assert.equal(fix.landed_at, landed);
  assert.deepEqual(fix.pulls, [5]);
  assert.deepEqual(fix.after, [1]);
  assert.deepEqual(fix.signals.sort(), ["bug_issue", "fix_branch", "fix_conventional", "fix_message", "fix_pr_title"]);
  assert.equal(fix.removed_total, 2);
  // moved whole: no line of it removed, and followed to c.ts
  assert.deepEqual(moved.files, []);
  assert.deepEqual(moved.moves, [{ from: "b.ts", to: "c.ts", hashes: hashes(10, 11, 12) }]);
  assert.deepEqual(rework.files, [{ path: "c.ts", removed: hashes(11, 12), added: [] }]);
  // the revert only adds lines back: it removes none, so GitHub is not asked of it
  assert.deepEqual([revert.signals, revert.reverts, revert.reapply], [["revert_subject"], { shas: [h.rework], pulls: [] }, undefined]);
  assert.deepEqual(revert.files, [{ path: "c.ts", removed: [], added: hashes(11, 12) }]);
  // git titles the revert of a revert `Reapply "…"`: it puts lines back, and reverts nothing
  assert.deepEqual([reapply.reapply, reapply.reverts], [true, { shas: [h.revert], pulls: [] }]);
  assert.deepEqual(reapply.files, [{ path: "c.ts", removed: hashes(11, 12), added: [] }]);
  // no text of a message, title or body goes out
  const out = JSON.stringify(scan);
  for (const text of ["wrong argument", "Fix the argument", "Closes", "Shorter", "fix/arg", "Bug"]) assert.ok(!out.includes(text), text);
  assert.ok(api.calls.includes(`GET /repos/acme/web/commits/${h.fix}/pulls?per_page=100`));
});

test("a commit not after the merge commit did not see its lines; an unknown merge commit is asked GitHub for", async () => {
  const r = repository();
  r.write("a.ts", [1, 2, 3].map(L));
  const before = r.commit("Before", START - DAY);
  r.sh(["checkout", "-q", "-b", "side"]);
  r.write("a.ts", [3].map(L));
  const side = r.commit("Side change", START + DAY);
  r.sh(["checkout", "-q", "main"]);
  r.write("b.ts", [5].map(L));
  const merge = r.commit("Add b (#1)", START);
  r.sh(["merge", "-q", "--no-edit", "side"], START + 2 * DAY);
  r.publish();
  const git = gitIn(r.dir, spawnSync);
  const api = github();
  api.request = async (method, path) => (path === "/repos/acme/web/pulls/1" ? { merge_commit_sha: merge } : []);
  const branch = { ...BRANCH(null), pulls: [{ ...BRANCH(null).pulls[0], merge_commit_sha: null, paths: ["a.ts"] }] };
  const scan = await scanBranch({ git, api, repo: "acme/web", host: "github.com", branch, now: (START + 3 * DAY) * 1000 });
  assert.deepEqual(scan.pulls, [{ number: 1, merge_commit_sha: merge, found: true }]);
  // the side branch was merged after #1, but its commit came from before it: its lines were not there
  const one = scan.commits.find((c) => c.sha === side);
  assert.deepEqual([one.files[0].removed, one.after], [hashes(1, 2), []]);
  // and the commit before is sent as it is: the server knows it is from before the merge
  assert.deepEqual(scan.commits.find((c) => c.sha === before).after, []);
});

test("a run with few GitHub requests left stops before the commit it cannot look up", async () => {
  const h = history();
  const api = { ...github(), remaining: 50 };
  const scan = await scanBranch({ git: gitIn(h.r.dir, spawnSync), api, repo: "acme/web", host: "github.com", branch: BRANCH(h.merge), now: (START + 7 * DAY) * 1000 });
  assert.equal(scan.stopped, true);
  assert.deepEqual(scan.commits, []);
  assert.equal(scan.scanned_until, iso(START + DAY - 1));
});

test("a scan goes to the server in parts cut between landings, each read up to the next", () => {
  const commit = (n, landed) => ({ sha: String(n), landed_at: iso(START + landed), files: [] });
  const many = Array.from({ length: COMMITS_AT_ONCE + 2 }, (_, i) => commit(i, i < COMMITS_AT_ONCE + 1 ? 10 : 20));
  const parts = chunks({ scanned_until: iso(START + 100), commits: many });
  // the 501st landed with the 500 before it: they go together
  assert.deepEqual(parts.map((p) => p.commits.length), [COMMITS_AT_ONCE + 1, 1]);
  assert.deepEqual(parts.map((p) => p.scanned_until), [new Date((START + 20) * 1000 - 1).toISOString(), iso(START + 100)]);
  assert.deepEqual(chunks({ scanned_until: iso(START), commits: [] }), [{ commits: [], scanned_until: iso(START) }]);
});

test("a scheduled run reads later commits after counting, and tells the server", async () => {
  const h = history();
  const sent = [];
  const server = async (method, path, body) => {
    if (path.startsWith("/prs/due")) return { due: [] };
    if (path.startsWith("/prs/outcomes/due")) {
      assert.match(path, /repo=github\.com%2Facme%2Fweb&since=2026-09-01T00%3A00%3A00\.000Z$/);
      return { branches: [BRANCH(h.merge)] };
    }
    sent.push(body);
    return { stored: [{ number: 1, sha: h.fix, kind: "fix" }], scanned_until: body.scanned_until };
  };
  const dir = mkdtempSync(join(tmpdir(), "sessionly-run-"));
  dirs.push(dir);
  const env = {
    SESSIONLY_URL: "https://sessionly.example.com",
    SESSIONLY_TOKEN: "t",
    SESSIONLY_GITHUB_TOKEN: "gh",
    GITHUB_REPOSITORY: "acme/web",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    SESSIONLY_OUTCOMES_SINCE: "2026-09-01",
  };
  writeFileSync(env.GITHUB_STEP_SUMMARY, "");
  const logged = [];
  const result = await run(env, { api: github(), server, git: gitIn(h.r.dir, spawnSync), log: (line) => logged.push(line) });
  assert.deepEqual(result.counted, []);
  assert.deepEqual(result.outcomes.stored, [{ number: 1, sha: h.fix, kind: "fix" }]);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].repo, sent[0].base_ref, sent[0].tip], ["github.com/acme/web", "main", h.huge]);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), new RegExp(`\\| #1 \\| \`${h.fix.slice(0, 12)}\` \\| Fix`));
  assert.ok(logged.some((line) => line.startsWith("Read later commits for 1 merged pull requests")));

  // switched off, nothing is read
  const quiet = await run({ ...env, SESSIONLY_OUTCOMES: "false" }, { api: github(), server, git: () => assert.fail("no git"), log() {} });
  assert.equal(quiet.outcomes, undefined);
});

test("an older server, and a checkout without history, are said", async () => {
  const logged = [];
  const old = async () => {
    throw Object.assign(new Error("the Sessionly server answered 404: not found"), { status: 404 });
  };
  const skipped = await runOutcomes({}, { api: github(), server: old, repo: "acme/web", host: "github.com", log: (l) => logged.push(l), git: () => assert.fail("no git") });
  assert.equal(skipped.skipped, true);
  assert.match(logged[0], /from before that/);
  const due = async () => ({ branches: [BRANCH("a".repeat(40))] });
  const shallow = () => Buffer.from("true\n");
  await assert.rejects(runOutcomes({}, { api: github(), server: due, repo: "acme/web", host: "github.com", log() {}, git: shallow }), /fetch-depth: 0/);
  await assert.rejects(runOutcomes({ SESSIONLY_OUTCOMES_SINCE: "soon" }, { api: github(), server: due, repo: "acme/web", host: "github.com", log() {}, git: shallow }), /not a date/);
  // the server asked too often waits, and tries again
  const r = history();
  let tries = 0;
  const busy = async (method, path, body) => {
    if (method === "GET") return { branches: [BRANCH(r.merge)] };
    tries += 1;
    if (tries === 1) throw Object.assign(new Error("429"), { status: 429, retryAfter: "2" });
    return { stored: [], scanned_until: body.scanned_until };
  };
  const waited = [];
  await runOutcomes({}, { api: github(), server: busy, repo: "acme/web", host: "github.com", log() {}, git: gitIn(r.r.dir, spawnSync), wait: async (ms) => waited.push(ms) });
  assert.deepEqual([tries, waited], [2, [2000]]);
});
