import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addedHashes, lineHash, removedHashes } from "../src/lines.mjs";
import { BUG_LABELS, FIX_TYPES, FIX_WORDS, pullSignals, putsBack, reverts, signals, wordsOf } from "../src/outcomes.mjs";
import { buildReport, render } from "../src/report.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./outcome-signals.json", import.meta.url), "utf8"));

test("the word lists are the binary's", () => {
  assert.deepEqual(FIX_WORDS, FIXTURE.fix_words);
  assert.deepEqual(FIX_TYPES, FIXTURE.fix_types);
  assert.deepEqual(BUG_LABELS, FIXTURE.bug_labels);
});

test("a commit message is read as the binary reads it", () => {
  assert.ok(FIXTURE.cases.length > 20);
  for (const { message, signals: expected, reverts: named } of FIXTURE.cases) {
    assert.deepEqual(signals(message), expected, JSON.stringify(message));
    if (named !== undefined) assert.deepEqual(reverts(message), named, JSON.stringify(message));
  }
});

test("a pull request a commit was merged with is read for fixes and reverts", () => {
  assert.ok(FIXTURE.pull_cases.length > 5);
  for (const { pull, signals: expected, reverts: named } of FIXTURE.pull_cases) {
    assert.deepEqual(pullSignals(pull, "owner/name"), { signals: expected, reverts: named }, JSON.stringify(pull));
  }
});

test("fix words and bug labels can be other ones, and only words count", () => {
  const of = wordsOf("oops, patch-up, ,Repair", "p0");
  assert.deepEqual(signals("Oops in the parser", of), ["fix_message"]);
  // the list replaces the defaults; a `fix:` type is still one
  assert.deepEqual(signals("Fix the parser", of), []);
  assert.deepEqual(signals("fix: the parser", of), ["fix_conventional"]);
  assert.deepEqual(signals("repair the parser", of), ["fix_message"]);
  assert.deepEqual(pullSignals({ title: "x", head_ref: "y", labels: ["P0"] }, "o/n", of).signals, ["bug_issue"]);
  // nothing that is one word: the defaults
  assert.deepEqual(signals("Fix the parser", wordsOf("patch-up")), ["fix_message"]);
});

test("a revert or a reapply puts lines back", () => {
  assert.ok(putsBack('Revert "x"'));
  assert.ok(putsBack('Reapply "x"\n\nThis reverts commit abcdef1.'));
  assert.ok(putsBack("Undo\n\nThis reverts commit abcdef1."));
  assert.ok(!putsBack("Add the parser"));
});

test("the lines a patch removes are hashed as the ones it adds", () => {
  const patch = "@@ -1,3 +1,1 @@\n-gone();\n---x;\n-}\n+kept();";
  assert.deepEqual(removedHashes(patch), [lineHash("gone();"), lineHash("--x;")]);
  assert.deepEqual(addedHashes(patch), [lineHash("kept();")]);
});

const at = (minute) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`;
const PULL = {
  number: 7,
  title: "Add the parser",
  user: { login: "ann" },
  state: "open",
  merged: false,
  created_at: at(0),
  head: { ref: "parser", sha: "a".repeat(40), repo: { full_name: "acme/web" } },
  base: { ref: "main", repo: { full_name: "acme/web" } },
  merge_commit_sha: "b".repeat(40),
};
const build = (pull) =>
  buildReport({ pull, files: [], reviews: [], comments: [], commits: [], event: "closed", host: "github.com", ignored: () => false });

test("a report names its head, and once merged the commit it was merged as", () => {
  const open = build(PULL);
  assert.equal(open.head_sha, "a".repeat(40));
  // GitHub names a test merge commit of an open pull request: not one on the branch
  assert.equal(open.merge_commit_sha, undefined);
  const merged = build({ ...PULL, state: "closed", merged: true, merged_at: at(9) });
  assert.equal(merged.merge_commit_sha, "b".repeat(40));
  assert.equal(build({ ...PULL, head: { ...PULL.head, sha: "nope" } }).head_sha, undefined);
});

test("OpenCode is named as such in the comment", () => {
  const report = build(PULL);
  const attribution = {
    first: { lines: 10, agent_lines: 5 },
    now: { lines: 10, agent_lines: 5, by: [{ tool: "opencode", model: "x", lines: 5 }] },
    by: [],
    cloud: null,
  };
  const text = render(report, attribution, "https://sessionly.example.com");
  assert.ok(text.includes("| OpenCode |"), text);
});
