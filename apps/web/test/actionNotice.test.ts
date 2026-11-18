import assert from "node:assert/strict";
import { test } from "node:test";
import { actionNoticeText, rerunNoticeText } from "../src/actionNotice.ts";

const move = "If .github/workflows/sessionly.yml pins the Action to a commit or tag, move it to a newer one.";
const main = "With @main, re-run the job: it fetches the Action again.";
const again = (pull: "this" | "the") =>
  `For a pinned commit or tag, a re-run keeps the old version: push a commit for an open pull request, or start the workflow by hand with ${pull} pull request's number if it has been merged.`;

test("a re-run keeps a pinned Action, and @main fetches it again", () => {
  assert.equal(actionNoticeText("this", true), `${move} ${again("this")} ${main}`);
  assert.equal(actionNoticeText("the", true), `${move} ${again("the")} ${main}`);
  // Left out when this pull request was already reported by the current Action.
  assert.equal(actionNoticeText("this", false), `${move} ${main}`);
  assert.equal(actionNoticeText("the", false), `${move} ${main}`);
  // A pull request whose repository is already current does not ask to move the pin.
  assert.equal(rerunNoticeText("this"), `${again("this")} ${main}`);
  assert.equal(rerunNoticeText("the"), `${again("the")} ${main}`);
});
