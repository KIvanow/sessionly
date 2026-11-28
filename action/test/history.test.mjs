import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gitIn, MOST_SHOWN, parseBatch, parseDiff, unmoved, unquote } from "../src/history.mjs";
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

test("a line removed and added again in one file stays there, and only what is left of it moves to another", () => {
  const bag = (entries) => new Map(entries.map((h) => [lineHash(L(h)), 1]));
  const of = (removed, added) => ({ removed: bag(removed), added: bag(added) });
  // z.ts moves line 1 within itself; b.ts gets a copy of it, and line 2 moves from z.ts to b.ts
  const files = new Map([["z.ts", of([1, 2], [1])], ["b.ts", of([], [1, 2])]]);
  const { files: left, removedTotal, moves } = unmoved(files);
  assert.deepEqual(moves, [["z.ts", "b.ts", lineHash(L(2)), 1]]);
  assert.equal(removedTotal, 0);
  assert.deepEqual([...left.get("z.ts").added.keys()], []);
  assert.deepEqual([...left.get("b.ts").added.keys()], [lineHash(L(1))]);
});

test("a directory moved whole is read in a moment", () => {
  const files = new Map();
  for (let f = 0; f < 2000; f += 1) {
    const [old, moved] = [{ removed: new Map(), added: new Map() }, { removed: new Map(), added: new Map() }];
    for (let k = 0; k < 50; k += 1) {
      const hash = (f * 1000 + k).toString(16).padStart(16, "0");
      old.removed.set(hash, 1);
      moved.added.set(hash, 1);
    }
    files.set(`src/module_${f}/file.js`, old);
    files.set(`packages/app/src/module_${f}/file.js`, moved);
  }
  const started = performance.now();
  const { files: left, removedTotal, moves } = unmoved(files);
  assert.ok(performance.now() - started < 5000, `took ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual([moves.length, removedTotal], [100_000, 0]);
  assert.ok([...left.values()].every((d) => d.added.size === 0 && d.removed.size === 0));
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
  const read = await scanBranch({ git, api, repo: "acme/web", host: "github.com", branch: BRANCH(h.merge), now: (START + 7 * DAY) * 1000 });
  // never read before: from the commit it was merged as
  assert.equal(read.scans.length, 1);
  const [scan] = read.scans;
  assert.equal(scan.stopped, null);
  assert.equal(scan.tip, h.huge);
  assert.deepEqual(scan.pulls, [{ number: 1, merge_commit_sha: h.merge, found: true }]);
  // the merge itself and the commit before it are not later; the one too large to read whole is not counted
  assert.deepEqual(scan.commits.map((c) => c.sha), [h.fix, h.moved, h.rework, h.revert, h.reapply]);
  const [fix, moved, rework, revert, reapply] = scan.commits;
  assert.deepEqual(fix.files, [{ path: "a.ts", removed: hashes(1, 2), added: hashes(7) }]);
  // landed when the branch's own commit that brought it was made
  assert.equal(fix.landed_at, iso(START + DAY));
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
  // read up to the tip, for the next run to go on from
  assert.deepEqual([...scan.tipsAt("end")], [[1, [h.huge]]]);
  // up to a few minutes before now: the server's clock may be behind the runner's
  assert.equal(scan.scanned_until, iso(START + 7 * DAY - 300));
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
  const { scans: [scan] } = await scanBranch({ git, api, repo: "acme/web", host: "github.com", branch, now: (START + 3 * DAY) * 1000 });
  assert.deepEqual(scan.pulls, [{ number: 1, merge_commit_sha: merge, found: true }]);
  // the side branch was merged after #1, but its commit came from before it: its lines were not there;
  // nor are they before the merge
  assert.deepEqual(scan.commits.map((c) => c.sha).filter((sha) => sha === side || sha === before), []);
  // read by time (a server that keeps no tips, and #1 read before), they are sent, after none
  const read = { ...branch, pulls: [{ ...branch.pulls[0], since: iso(START + DAY / 2) }] };
  const { scans: [byTime] } = await scanBranch({ git, api, repo: "acme/web", host: "github.com", branch: read, now: (START + 3 * DAY) * 1000 });
  const one = byTime.commits.find((c) => c.sha === side);
  assert.deepEqual([one.files[0].removed, one.after, byTime.pulls[0].found], [hashes(1, 2), [], true]);
});

test("a run with few GitHub requests left stops before the commit it cannot look up", async () => {
  const h = history();
  const api = { ...github(), remaining: 50 };
  const { scans: [scan] } = await scanBranch({ git: gitIn(h.r.dir, spawnSync), api, repo: "acme/web", host: "github.com", branch: BRANCH(h.merge), now: (START + 7 * DAY) * 1000 });
  assert.match(scan.stopped, /few more requests/);
  assert.deepEqual(scan.commits, []);
  assert.equal(scan.scanned_until, new Date((START + DAY) * 1000 - 1).toISOString());
  // nothing read yet: from the merge commit again
  assert.deepEqual([...scan.tipsAt(scan.through)], [[1, [h.merge]]]);
});

test("a scan goes to the server in parts cut between landings, each read up to the next", () => {
  const commit = (n, landed) => ({ sha: String(n), landed_at: iso(START + landed), files: [] });
  const many = Array.from({ length: COMMITS_AT_ONCE + 2 }, (_, i) => commit(i, i < COMMITS_AT_ONCE + 1 ? 10 : 20));
  const scan = { scanned_until: iso(START + 100), commits: many, through: "end", before: (c) => `before ${c.sha}`, apart: () => true };
  const parts = chunks(scan);
  // the 501st landed with the 500 before it: they go together
  assert.deepEqual(parts.map((p) => p.commits.length), [COMMITS_AT_ONCE + 1, 1]);
  assert.deepEqual(parts.map((p) => p.scanned_until), [new Date((START + 20) * 1000 - 1).toISOString(), iso(START + 100)]);
  // each read up to the branch's own commit before the next one's first
  assert.deepEqual(parts.map((p) => p.through), [`before ${COMMITS_AT_ONCE + 1}`, "end"]);
  assert.deepEqual(chunks({ ...scan, commits: [] }), [{ commits: [], scanned_until: iso(START + 100), through: "end" }]);
  // nor more files in all than the server takes at once (100,000), nor more JSON (8 MB)
  const wide = (n) => ({ sha: String(n), landed_at: iso(START + n), files: Array.from({ length: 5000 }, () => ({ path: "a.ts", removed: [], added: [] })) });
  assert.deepEqual(chunks({ ...scan, commits: Array.from({ length: 21 }, (_, n) => wide(n)) }).map((p) => p.commits.length), [20, 1]);
  const heavy = (n) => ({ sha: String(n), landed_at: iso(START + n), files: [{ path: "a.ts", removed: Array(150_000).fill("0".repeat(16)), added: [] }] });
  assert.deepEqual(chunks({ ...scan, commits: [0, 1, 2, 3].map(heavy) }).map((p) => p.commits.length), [2, 2]);
  // where it can, at the end of what one of the branch's own commits brought: 0 to 9 came with one, 10 to 20 with the next
  const grouped = { ...scan, apart: (a, b) => Number(a.sha) < 10 !== Number(b.sha) < 10, commits: Array.from({ length: 21 }, (_, n) => wide(n)) };
  assert.deepEqual(chunks(grouped).map((p) => p.commits.length), [10, 11]);
  // and where the rest would still be too much, just before the one that does not fit
  const late = { ...grouped, apart: (a, b) => Number(a.sha) < 1 !== Number(b.sha) < 1 };
  late.commits = [...grouped.commits.slice(0, 20), { ...wide(20), files: [...wide(20).files, wide(20).files[0]] }];
  assert.deepEqual(chunks(late).map((p) => p.commits.length), [20, 1]);
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
  // one that does not say how long is waited a minute: its limit is per minute
  tries = 0;
  const unsaid = async (method, path, body) => {
    if (method === "GET") return { branches: [BRANCH(r.merge)] };
    tries += 1;
    if (tries === 1) throw Object.assign(new Error("429"), { status: 429, retryAfter: null });
    return { stored: [], scanned_until: body.scanned_until };
  };
  await runOutcomes({}, { api: github(), server: unsaid, repo: "acme/web", host: "github.com", log() {}, git: gitIn(r.r.dir, spawnSync), wait: async (ms) => waited.push(ms) });
  assert.deepEqual(waited, [2000, 60_000]);
});

test("when counting after merge and reading later commits both fail, the first is the run's and the second is said", async () => {
  const down = async (method, path) => {
    throw Object.assign(new Error(`the Sessionly server answered 503: ${path.startsWith("/prs/due") ? "counts" : "commits"}`), { status: 503 });
  };
  const env = { SESSIONLY_URL: "https://sessionly.example.com", SESSIONLY_TOKEN: "t", SESSIONLY_GITHUB_TOKEN: "gh", GITHUB_REPOSITORY: "acme/web", GITHUB_EVENT_NAME: "schedule" };
  const logged = [];
  await assert.rejects(run(env, { api: github(), server: down, git: () => assert.fail("no git"), log: (line) => logged.push(line) }), /503: counts/);
  assert.ok(logged.some((line) => line === "::warning title=Sessionly::later commits were not read: the Sessionly server answered 503: commits"), logged.join("\n"));
});

/** A branch with one due pull request, #1, merged as `merge` at START and read up to `since` (and its tips, when the server keeps them). */
const due = (merge, { since = START, tips, paths = ["a.ts"] } = {}) => ({
  base_ref: "main",
  since: iso(since),
  until: iso(START + 30 * DAY),
  pulls: [{ number: 1, merged_at: iso(START), merge_commit_sha: merge, since: iso(since), paths, ...(tips === undefined ? {} : { tips }) }],
});

/** #1 merged at START with four lines of a.ts. */
function merged() {
  const r = repository();
  r.write("a.ts", [0].map(L));
  r.commit("Start", START - DAY);
  r.write("a.ts", [1, 2, 3, 4].map(L));
  const merge = r.commit("Agent PR one (#1)", START);
  r.publish();
  return { r, merge, git: gitIn(r.dir, spawnSync) };
}

const scan = async (git, branch, day, api = github()) => (await scanBranch({ git, api, repo: "o/r", host: "github.com", branch, now: (START + day * DAY) * 1000 })).scans;

test("a due pull request's merge commit is a later commit of the ones merged before it", async () => {
  const { r, merge, git } = merged();
  // #2, also due, rewrites #1's lines
  r.write("a.ts", [10, 11, 12, 13].map(L));
  const second = r.commit("Agent PR two rewrites it (#2)", START + DAY);
  r.publish();
  const branch = due(merge);
  branch.pulls.push({ number: 2, merged_at: iso(START + DAY), merge_commit_sha: second, since: iso(START + DAY), paths: ["a.ts"] });
  const [read] = await scan(git, branch, 2);
  const sent = read.commits.find((c) => c.sha === second);
  // a later commit of #1, and #2's own (the server knows it by its SHA)
  assert.deepEqual([sent.after, sent.files[0].removed], [[1], hashes(1, 2, 3, 4)]);
});

test("commits merged in later are read whatever their dates, from the tips the server keeps", async () => {
  const { r, merge, git } = merged();
  r.sh(["checkout", "-q", "-b", "feature"]);
  r.write("a.ts", [1, 20, 30, 4].map(L));
  const rework = r.commit("Rework the agent's lines", START + DAY);
  r.sh(["checkout", "-q", "main"]);
  r.write("other.ts", ["x"].map(L));
  const other = r.commit("unrelated", START + 2 * DAY);
  r.publish();
  // read on day 4, before the branch is merged
  const [first] = await scan(git, due(merge, { tips: null }), 4);
  assert.deepEqual(first.commits, []);
  const tips = first.tipsAt(first.through).get(1);
  assert.deepEqual(tips, [other]);
  // merged with a merge commit on day 5: its commit is from day 1, before #1 was read up to
  r.sh(["merge", "-q", "--no-ff", "--no-edit", "feature"], START + 5 * DAY);
  r.publish();
  const [second] = await scan(git, due(merge, { since: Date.parse(first.scanned_until) / 1000, tips }), 6);
  const sent = second.commits.find((c) => c.sha === rework);
  // landed with the merge commit, after #1 was read up to
  assert.deepEqual([sent.after, sent.files[0].removed, sent.landed_at], [[1], hashes(2, 3), iso(START + 5 * DAY)]);
  assert.deepEqual(second.pulls, [{ number: 1, merge_commit_sha: merge, found: true }]);
  // and read up to the merge from then on
  assert.deepEqual(second.tipsAt(second.through).get(1), [r.sh(["rev-parse", "main"])]);
});

test("commits made since the reading began each land a moment after the one before, so a scan can be cut between any two", async () => {
  const { r, merge, git } = merged();
  // made in the minute before the run, after the five minutes the history is read up to
  const made = [1, 2, 3].map((n) => {
    r.write("a.ts", [1, 2, 3, 4].slice(n).map(L));
    return r.commit(`Rework ${n}`, START + 3 * DAY - 60 + n);
  });
  r.publish();
  const [read] = await scan(git, due(merge, { tips: null }), 3);
  assert.deepEqual(read.commits.map((c) => c.sha), made);
  const landed = read.commits.map((c) => Date.parse(c.landed_at));
  assert.deepEqual(landed, [...new Set(landed)].sort((a, b) => a - b));
  assert.ok(Date.parse(read.scanned_until) >= landed.at(-1));
});

test("commits pushed days after they were made land after the branch was last read", async () => {
  const { r, merge, git } = merged();
  const [first] = await scan(git, due(merge, { tips: null }), 4);
  const since = Date.parse(first.scanned_until) / 1000;
  // made on day 1, pushed after the read on day 4
  r.write("a.ts", [1, 9].map(L));
  const old = r.commit("fix: an old local change", START + DAY);
  r.publish();
  const [second] = await scan(git, due(merge, { since, tips: first.tipsAt(first.through).get(1) }), 6);
  const sent = second.commits.find((c) => c.sha === old);
  assert.ok(sent, "sent");
  assert.deepEqual(sent.after, [1]);
  assert.ok(Date.parse(sent.landed_at) > since * 1000, sent.landed_at);
  // read by time (no tips kept), it is not: the dates say it was read already
  const [byTime] = await scan(git, due(merge, { since }), 6);
  assert.ok(!byTime.commits.some((c) => c.sha === old));
});

test("a run that stops goes on from the branch's own commit before it, whatever the dates of those after", async () => {
  const { r, merge, git } = merged();
  // on main, on day 2: removes two of #1's lines
  r.sh(["checkout", "-q", "-b", "feature"]);
  r.write("b.ts", ["b"].map(L));
  r.commit("Unrelated start", START + DAY / 2);
  r.write("a.ts", [1, 2, 30, 40].map(L));
  const early = r.commit("Rework, made early", START + DAY);
  r.sh(["checkout", "-q", "main"]);
  r.write("a.ts", [10, 20, 3, 4].map(L));
  const late = r.commit("Rework on main", START + 2 * DAY);
  // the branch, made before it, merged after it
  r.sh(["merge", "-q", "--no-ff", "--no-edit", "-X", "theirs", "feature"], START + 3 * DAY);
  r.publish();
  // GitHub answers once, then allows no more
  const api = github();
  const ask = api.request;
  let asked = 0;
  api.request = async (...args) => {
    asked += 1;
    if (asked > 1) throw Object.assign(new Error("GitHub answered 403 to GET: API rate limit exceeded"), { status: 403, rateLimited: true });
    return ask(...args);
  };
  const [first] = await scan(git, due(merge, { tips: null }), 4, api);
  assert.match(first.stopped, /rate limit/);
  assert.deepEqual(first.commits.map((c) => c.sha), [late]);
  const tips = first.tipsAt(first.through).get(1);
  assert.deepEqual(tips, [late]);
  // the next run reads the merged branch's commit, though it was made before the one sent
  const [second] = await scan(git, due(merge, { since: Date.parse(first.scanned_until) / 1000, tips }), 4);
  assert.deepEqual(second.commits.map((c) => c.sha), [early]);
  assert.ok(Date.parse(second.commits[0].landed_at) > Date.parse(first.scanned_until));
});

test("a commit that landed after a pull request's 30 days is not read for it", async () => {
  const { r, merge, git } = merged();
  r.write("a.ts", [1, 9].map(L));
  const within = r.commit("Rework", START + 29 * DAY);
  r.write("a.ts", [9].map(L));
  r.commit("Later rework", START + 40 * DAY);
  r.publish();
  const [read] = await scan(git, due(merge), 45);
  assert.deepEqual([read.commits.map((c) => c.sha), read.stopped, read.tipsAt(read.through).get(1)], [[within], null, [r.sh(["rev-parse", "main"])]]);
});

test("a revert of a reapply reverts again", async () => {
  const { r, merge, git } = merged();
  r.sh(["revert", "--no-edit", merge], START + DAY);
  const revert = r.sh(["rev-parse", "HEAD"]);
  r.sh(["revert", "--no-edit", revert], START + 2 * DAY);
  const reapply = r.sh(["rev-parse", "HEAD"]);
  r.sh(["revert", "--no-edit", reapply], START + 3 * DAY);
  const again = r.sh(["rev-parse", "HEAD"]);
  r.publish();
  const [read] = await scan(git, due(merge), 4);
  const of = (sha) => read.commits.find((c) => c.sha === sha);
  // depths 1, 2 and 3 of a chain of reverts: only the even one puts lines back
  assert.deepEqual([of(revert).reapply, of(reapply).reapply, of(again).reapply], [undefined, true, undefined]);
  assert.deepEqual(of(again).files[0].removed, hashes(1, 2, 3, 4));
});

test("a squash commit whose body lists a revert is no revert, and GitHub's revert of it is one", async () => {
  const r = repository();
  r.write("a.ts", [0].map(L));
  r.commit("Start", START - DAY);
  r.write("a.ts", [1, 2, 3, 4].map(L));
  // GitHub's squash message lists the branch's commits, a revert among them
  const merge = r.commit('Agent PR one (#1)\n\n* wip\n\n* Revert "wip"\n\nThis reverts commit 1234567890abcdef1234567890abcdef12345678.\n\n* done', START);
  r.sh(["revert", "--no-edit", merge], START + DAY);
  const revert = r.sh(["rev-parse", "HEAD"]);
  r.publish();
  const api = github({ [revert]: [{ number: 2, merged_at: iso(START + DAY), base: { ref: "main" }, title: 'Revert "Agent PR one"', head: { ref: "revert-1-x" }, body: "Reverts o/r#1" }] });
  const [read] = await scan(gitIn(r.dir, spawnSync), due(merge), 2, api);
  const sent = read.commits.find((c) => c.sha === revert);
  assert.equal(sent.reapply, undefined);
  assert.deepEqual(sent.reverts, { shas: [merge], pulls: [1] });
  assert.deepEqual(sent.signals, ["revert_subject", "revert_pr_title"]);
});

test("a token that may not read pull requests is said once, and later commits are read without them", async () => {
  const { r, merge, git } = merged();
  r.write("a.ts", [1, 9].map(L));
  const rework = r.commit("Rework", START + DAY);
  r.write("a.ts", [9].map(L));
  const more = r.commit("More rework", START + 2 * DAY);
  r.publish();
  const refused = { request: async () => { throw Object.assign(new Error("GitHub answered 403 to GET: Resource not accessible by integration"), { status: 403 }); }, graphql: async () => ({}) };
  const logged = [];
  const { scans: [read] } = await scanBranch({ git, api: refused, repo: "o/r", host: "github.com", branch: due(merge), log: (l) => logged.push(l), now: (START + 3 * DAY) * 1000 });
  assert.equal(read.stopped, null);
  assert.deepEqual(read.commits.map((c) => [c.sha, c.pulls]), [[rework, []], [more, []]]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /pull-requests: read/);
});

test("odd paths are read back as the server names them", async () => {
  const r = repository();
  const names = ["sp ace.ts", 'qu"ote.ts', "new\nline.ts", "tab\there.ts", "café.ts", "-dash.ts", "a/b.ts", "back\\slash.ts", ":(glob)*.ts", "cr\r.ts"];
  mkdirSync(join(r.dir, "a"));
  for (const n of names) r.write(n, [1, 2, 3].map(L));
  const merge = r.commit("Start (#1)", START);
  for (const n of names) r.write(n, [3].map(L));
  const change = r.commit("Change all", START + DAY);
  r.publish();
  const [read] = await scan(gitIn(r.dir, spawnSync), due(merge, { paths: names }), 2);
  const sent = read.commits.find((c) => c.sha === change);
  assert.deepEqual(sent.files.map((f) => f.path).sort(), [...names].sort());
  for (const f of sent.files) assert.deepEqual(f.removed, hashes(1, 2), f.path);
});

test("paths of any number and length are read, and a commit git prints too much of is read on its own", async () => {
  const r = repository();
  // more than a command line holds: 12,000 paths of 180 characters
  const paths = Array.from({ length: 12_000 }, (_, i) => `${String(i).padStart(5, "0")}-${"x".repeat(174)}.ts`);
  const last = paths.at(-1);
  r.write("a.ts", [1, 2].map(L));
  r.write(last, [7, 8].map(L));
  const merge = r.commit("Start (#1)", START);
  r.write("a.ts", [9].map(L));
  const change = r.commit("Change", START + DAY);
  for (const p of paths.slice(0, 2)) r.write(p, [5].map(L));
  r.write(last, []);
  r.write("big.ts", Array.from({ length: 8000 }, (_, i) => `big_${i}();`));
  const big = r.commit("Large", START + 2 * DAY);
  r.publish();
  const branch = due(merge, { paths: ["a.ts", ...paths] });
  const files = (c) => c.files.map((f) => [f.path, f.removed.length, f.added.length]);
  const [read] = await scan(gitIn(r.dir, spawnSync), branch, 3);
  assert.deepEqual(read.commits.map((c) => c.sha), [change, big]);
  assert.deepEqual(files(read.commits[1]), [[paths[0], 0, 1], [paths[1], 0, 1], [last, 2, 0]]);
  // with less than both print read whole at once: in halves, and the large one, too large on its own, is not counted
  const [cut] = await scan(gitIn(r.dir, spawnSync, 64 * 1024), branch, 3);
  assert.deepEqual(cut.commits.map((c) => c.sha), [change, big]);
  assert.deepEqual(files(cut.commits[0]), [["a.ts", 2, 1]]);
  assert.deepEqual(files(cut.commits[1]), [[paths[0], 0, 1], [paths[1], 0, 1]]);
});

test("a branch that is gone is told the server, one not checked out is said, and one that fails leaves the others", async () => {
  const { r, merge, git } = merged();
  r.write("a.ts", [1, 9].map(L));
  r.commit("Rework", START + DAY);
  r.publish();
  const branches = [
    { ...due(merge), base_ref: "stack/base" },
    { ...due(merge), base_ref: "release" },
    due(merge),
    { ...due(merge), base_ref: "main" },
  ];
  branches[3].pulls = [{ ...branches[3].pulls[0], number: 4 }];
  const api = github();
  const request = api.request;
  api.request = async (method, path) => {
    if (path.endsWith("/branches/stack/base")) throw Object.assign(new Error("GitHub answered 404"), { status: 404 });
    if (path.endsWith("/branches/release")) return { commit: { sha: "a".repeat(40) } };
    return request(method, path);
  };
  const sent = [];
  const server = async (method, path, body) => {
    if (method === "GET") return { branches };
    sent.push(body);
    if (body.pulls[0]?.number === 1) throw Object.assign(new Error("the Sessionly server answered 422: no"), { status: 422 });
    return { stored: [] };
  };
  const logged = [];
  await assert.rejects(runOutcomes({}, { api, server, repo: "o/r", host: "github.com", log: (l) => logged.push(l), git, now: () => (START + 2 * DAY) * 1000 }), /later commits of main could not be read/);
  // the gone one is told, with none of its pull requests read
  assert.deepEqual(sent[0], { repo: "github.com/o/r", base_ref: "stack/base", tip: null, scanned_until: iso(START + 2 * DAY), pulls: [], commits: [], gone: [1] });
  assert.match(logged.join("\n"), /stack\/base is not on GitHub any more/);
  // the one GitHub has, but the checkout not, is only said
  assert.match(logged.join("\n"), /origin\/release is not in the checkout/);
  // the one refused is said, and the branch after it still read
  assert.deepEqual(sent.slice(1).map((b) => b.pulls[0].number), [1, 4]);
  assert.match(logged.join("\n"), /Later commits of main could not be read \(the Sessionly server answered 422: no\)/);
});

test("the server's tips go back with what was read, and the refused question of a ci token is said for what it is", async () => {
  const { r, merge, git } = merged();
  r.write("a.ts", [1, 9].map(L));
  const rework = r.commit("Rework", START + DAY);
  r.publish();
  const sent = [];
  const server = async (method, path, body) => {
    if (method === "GET") return { branches: [due(merge, { tips: null })] };
    sent.push(body);
    return { stored: [] };
  };
  await runOutcomes({}, { api: github(), server, repo: "o/r", host: "github.com", log() {}, git, now: () => (START + 2 * DAY) * 1000 });
  // and the files each was read in, so that a server that matched it with another meanwhile leaves it as it is
  assert.deepEqual(sent[0].pulls, [{ number: 1, merge_commit_sha: merge, found: true, paths: ["a.ts"], from: null, tips: [rework] }]);
  // a token that is no ci token is not an older server
  const refused = async () => {
    throw Object.assign(new Error("the Sessionly server answered 403: reporting pull requests needs a ci or admin token"), { status: 403 });
  };
  await assert.rejects(runOutcomes({}, { api: github(), server: refused, repo: "o/r", host: "github.com", log() {}, git }), /token needs the ci or admin role/);
  // no checkout at all is a notice, not a failure
  const logged = [];
  const none = () => {
    throw new Error("git rev-parse failed: fatal: not a git repository");
  };
  const out = await runOutcomes({}, { api: github(), server, repo: "o/r", host: "github.com", log: (l) => logged.push(l), git: none });
  assert.equal(out.skipped, true);
  assert.match(logged[0], /^::notice title=Sessionly::Later commits .* not checked out here/);
});

test("no more commits are read whole in a run than the binary reads at once, and the next run goes on from there", async () => {
  const { r, merge, git } = merged();
  // MOST_SHOWN + 1 commits that each change a line of #1's file, made at once
  const n = MOST_SHOWN + 1;
  const stream = [];
  for (let k = 1; k <= n; k += 1) {
    const text = `${[k + 100, k + 101, 3, 4].map(L).join("\n")}\n`;
    const at = START + DAY + k * 60;
    stream.push(`commit refs/heads/main`, `committer t <t@example.com> ${at} +0000`, `data 2`, `c${k % 10}`, k === 1 ? `from ${merge}` : "", `M 100644 inline a.ts`, `data ${Buffer.byteLength(text)}`, text);
  }
  const done = spawnSync("git", ["fast-import", "--quiet", "--force"], { cwd: r.dir, input: `${stream.filter((line, i) => line !== "" || stream[i - 1]?.startsWith("data")).join("\n")}\n` });
  assert.equal(done.status, 0, String(done.stderr));
  r.publish();
  const [first] = await scan(git, due(merge, { tips: null }), 30);
  assert.match(first.stopped, /more than 2000/);
  assert.equal(first.commits.length, MOST_SHOWN);
  const tips = first.tipsAt(first.through).get(1);
  assert.deepEqual(tips, [first.commits.at(-1).sha]);
  const [second] = await scan(git, due(merge, { since: Date.parse(first.scanned_until) / 1000, tips }), 30);
  assert.deepEqual([second.stopped, second.commits.length], [null, 1]);
});
