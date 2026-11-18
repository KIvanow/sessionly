import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullFeedback } from "@sessionly/schema";
import { byOf, countFeedback, feedbackLabel, nameSome, pullHref, web } from "../src/pull.ts";

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
