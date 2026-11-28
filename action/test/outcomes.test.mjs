import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addedHashes, lineHash, removedHashes } from "../src/lines.mjs";
import { parseBatch, splitTree } from "../src/history.mjs";
import { BUG_LABELS, FIX_TYPES, FIX_WORDS, pullSignals, putsBack, revertDepth, reverts, signals, subjectDepth, waitOf, wordsOf } from "../src/outcomes.mjs";
import { buildReport, render } from "../src/report.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./outcome-signals.json", import.meta.url), "utf8"));

test("the word lists are the binary's", () => {
  assert.deepEqual(FIX_WORDS, FIXTURE.fix_words);
  assert.deepEqual(FIX_TYPES, FIXTURE.fix_types);
  assert.deepEqual(BUG_LABELS, FIXTURE.bug_labels);
});

test("a commit message is read as the binary reads it", () => {
  assert.ok(FIXTURE.cases.length > 20);
  for (const { message, signals: expected, reverts: named, depth } of FIXTURE.cases) {
    assert.deepEqual(signals(message), expected, JSON.stringify(message));
    if (named !== undefined) assert.deepEqual(reverts(message), named, JSON.stringify(message));
    if (depth !== undefined) assert.equal(subjectDepth(message), depth, JSON.stringify(message));
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
  // only as git and GitHub write one: GitHub's squash message lists the branch's commits, a revert among them
  assert.ok(!putsBack('Add the parser (#1)\n\n* wip\n\n* Revert "wip"\n\nThis reverts commit abcdef1.'));
  assert.ok(!putsBack("Add the parser\n\nAs before. This reverts commit abcdef1."));
  // a body that begins as git's does is read on through its first paragraph, as the binary reads it
  assert.ok(putsBack("Undo\n\nThis reverts commit abc12, and this reverts commit abcdef1."));
});

test("a chain of reverts is followed through the commits each names, and only an even depth puts lines back", () => {
  const commits = {
    aaaaaaa: { message: "Add the parser (#1)" },
    bbbbbbb: { message: 'Revert "Add the parser (#1)"\n\nThis reverts commit aaaaaaa.' },
    ccccccc: { message: 'Reapply "Add the parser (#1)"\n\nThis reverts commit bbbbbbb.' },
    ddddddd: { message: 'Revert "Reapply "Add the parser (#1)""\n\nThis reverts commit ccccccc.' },
    eeeeeee: { message: 'Squash (#3)\n\n* Revert "x"\n\nThis reverts commit bbbbbbb.' },
  };
  const find = (sha) => commits[sha] ?? null;
  assert.deepEqual(["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd", "eeeeeee"].map((sha) => revertDepth(commits[sha].message, find)), [0, 1, 2, 3, 0]);
  // one that names no commit here is as deep as its subject says
  assert.equal(revertDepth('Revert "Revert "x""\n\nThis reverts commit 1234567.', find), 2);
  assert.equal(revertDepth('Reapply "x"', find), 2);
});

test("a pull request numbered 0 is none", () => {
  assert.deepEqual(pullSignals({ title: "x", head_ref: "y", body: "Reverts o/r#0 and Reverts o/r#5" }, "o/r").reverts, [5]);
});

test("a message is trimmed as the binary trims it, and its encoding read with any space around it", () => {
  const sha = "a".repeat(40);
  const batch = (text, encoding = "latin1") => {
    const object = Buffer.from(text, encoding);
    return parseBatch(Buffer.concat([Buffer.from(`${sha} commit ${object.length}\n`), object, Buffer.from("\n")])).get(sha);
  };
  // a byte order mark stays (Rust's trim keeps it), so `\ufefffix:` is no conventional type
  const bom = batch("tree x\n\n\ufefffix: the parser\n", "utf8");
  assert.equal(bom.charCodeAt(0), 0xfeff);
  assert.deepEqual(signals(bom), ["fix_message"]);
  // U+0085 goes, as Rust's trim takes it
  assert.deepEqual(signals(batch("tree x\n\n\u0085\nfix: the parser\n", "utf8")), ["fix_message", "fix_conventional"]);
  assert.equal(batch("tree x\nencoding  Latin1 \n\nCaf\xe9\n"), "Caf\xe9");
});

test("git leaving a commit out of diff-tree fails the reading, rather than giving one's changes to another", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(40));
  assert.deepEqual([...splitTree(`${a}\nAAA\n${b}\n${c}\nCCC\n`, [a, b, c])], [[a, "AAA\n"], [b, ""], [c, "CCC\n"]]);
  assert.throws(() => splitTree(`${a}\nAAA\n${c}\nCCC\n`, [a, b, c]), /left out a commit/);
  assert.throws(() => splitTree(`${a}\nAAA\n`, [a, b]), /left out 1 of 2/);
});

test("the server asked too often is waited out as long as it says, and a minute when it does not", () => {
  assert.deepEqual([waitOf("2"), waitOf(null), waitOf(""), waitOf("soon")], [2000, 60_000, 60_000, 60_000]);
  const now = Date.parse("2026-11-10T10:00:00Z");
  assert.equal(waitOf("Tue, 10 Nov 2026 10:00:30 GMT", now), 30_000);
  assert.equal(waitOf("86400"), 300_000);
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
