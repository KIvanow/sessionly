import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullFeedback } from "@sessionly/schema";
import { byOf, countFeedback, feedbackLabel, matchAll, matchedLine, nameSome, pullHref, web } from "../src/pull.ts";

test("a pull request says how current its figures are", () => {
  const when = (iso: string | null) => `<${iso}>`;
  const reported = "2026-11-17T19:13:00.000Z";
  assert.equal(
    matchedLine({ updated_at: reported, matched_at: reported, matchable: true }, when),
    `Last reported by the Action <${reported}>. Sessions uploaded since then are not counted yet.`,
  );
  assert.equal(
    matchedLine({ updated_at: reported, matched_at: "2026-11-17T21:00:00.000Z", matchable: true }, when),
    `Last reported by the Action <${reported}>; its lines were matched to sessions again <2026-11-17T21:00:00.000Z>.`,
  );
  assert.match(matchedLine({ updated_at: reported, matched_at: reported, matchable: false }, when), /count with its next report\.$/);
});

test("the listed pull requests are matched again until none remain", async () => {
  const asked: Record<string, string | undefined>[] = [];
  const answers = [
    { matched: 100, failed: 0, remaining: 3, needs_report: 2, started: "t0" },
    { matched: 3, failed: 0, remaining: 0, needs_report: 2, started: "t0" },
  ];
  const heard: number[] = [];
  const done = await matchAll(async (body) => (asked.push(body), answers[asked.length - 1]!), { repo: "acme/web", state: "merged" }, (n) => heard.push(n));
  assert.deepEqual(done, { matched: 103, needs_report: 2, failed: 0 });
  assert.deepEqual(asked, [
    { repo: "acme/web", state: "merged", started: undefined },
    { repo: "acme/web", state: "merged", started: "t0" },
  ]);
  assert.deepEqual(heard, [100, 103]);
  // a server that gets no further with what remains is not asked forever
  let times = 0;
  const stuck = await matchAll(async () => ((times += 1), { matched: 0, failed: 5, remaining: 5, needs_report: 0, started: "t0" }), {});
  assert.deepEqual([times, stuck.failed], [2, 5]);
});

const one = (kind: PullFeedback["kind"], author: string, more: Partial<PullFeedback> = {}): PullFeedback => ({
  kind,
  url: null,
  author,
  bot: /\[bot\]$/.test(author),
  at: "2026-11-10T12:00:00.000Z",
  ...more,
});

test("a long list of names stops after five", () => {
  assert.equal(nameSome(["acme/web"]), "acme/web");
  assert.equal(nameSome(["a", "b"]), "a and b");
  assert.equal(nameSome(["a", "b", "c", "d", "e", "f", "g"]), "a, b, c, d, e and 2 more");
});

test("a pull request's page is addressed by its repository, in one part, and its number", () => {
  assert.equal(pullHref({ repo: "github.com/acme/web", number: 7 }), "#/pull/github.com%2Facme%2Fweb/7");
});

test("only a web address is followed", () => {
  assert.equal(web("https://github.com/acme/web/pull/7"), "https://github.com/acme/web/pull/7");
  for (const not of [null, undefined, "", "javascript:alert(1)", "data:text/html,x", "/pulls", " https://x"]) assert.equal(web(not), undefined);
});

test("a review or comment is described by what it was, never by what it said", () => {
  assert.equal(feedbackLabel(one("review", "bob", { state: "changes_requested" })), "Review: asked for changes");
  assert.equal(feedbackLabel(one("review", "bob", { state: "approved" })), "Review: approved");
  assert.equal(feedbackLabel(one("review", "bob", { state: null })), "Review: submitted");
  assert.equal(feedbackLabel(one("conversation", "bob")), "Comment in the conversation");
  assert.equal(feedbackLabel(one("inline", "bob", { path: "src/a.ts", line: 12 })), "Comment on src/a.ts:12");
  assert.equal(feedbackLabel(one("inline", "ann", { path: "src/a.ts", line: null, reply: true })), "Reply on src/a.ts");
  assert.equal(feedbackLabel(one("inline", "ann")), "Comment");
});

test("reviews and comments are counted apart for people, for bots and for the author", () => {
  const feedback = [
    one("conversation", "vercel[bot]"),
    one("review", "coderabbitai[bot]", { state: "commented" }),
    one("inline", "coderabbitai[bot]"),
    one("inline", "coderabbitai[bot]"),
    one("inline", "ann", { reply: true }),
    one("review", "bob", { state: "changes_requested" }),
    one("inline", "bob"),
    one("review", "cy", { state: "approved" }),
    // a bot is a bot by what GitHub says of it, whatever it is called
    one("inline", "ann", { bot: true }),
  ];
  assert.deepEqual(feedback.map((f) => byOf(f, "ann")), ["bots", "bots", "bots", "bots", "author", "people", "people", "people", "bots"]);
  assert.deepEqual(countFeedback(feedback, "ann"), [
    { by: "people", names: ["bob", "cy"], reviews: 2, changes_requested: 1, inline: 1, conversation: 0 },
    { by: "bots", names: ["coderabbitai[bot]", "ann", "vercel[bot]"], reviews: 1, changes_requested: 0, inline: 3, conversation: 1 },
    { by: "author", names: ["ann"], reviews: 0, changes_requested: 0, inline: 1, conversation: 0 },
  ]);
  assert.deepEqual(countFeedback([], "ann").map((row) => [row.by, row.names, row.reviews + row.inline + row.conversation]), [
    ["people", [], 0],
    ["bots", [], 0],
    ["author", [], 0],
  ]);
});
