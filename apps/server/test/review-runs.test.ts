import assert from "node:assert/strict";
import { test } from "node:test";
import { belongs, type Reviewed } from "../src/review-runs.ts";

const at = (time: string) => Date.parse(`2026-11-10T${time}:00Z`);
const run = (more: Record<string, unknown> = {}) => ({ id: "t1", command: "code-review", status: "ok" as const, ...more });
const pull = (more: Partial<Reviewed> = {}): Reviewed => ({ number: 41, ended: null, after: null, matched: false, onBranch: false, ...more });

test("a run that names a pull request is that one's, and no other's", () => {
  assert.equal(belongs(pull(), run({ pull_number: 41 })), true);
  assert.equal(belongs(pull({ matched: true, onBranch: true }), run({ pull_number: 42 })), false);
  // whenever it ran: one that names it after the merge is still of it
  assert.equal(belongs(pull({ ended: at("12:00") }), run({ pull_number: 41, at: "2026-11-10T15:00:00Z" })), true);
});

test("a run refused before it began is no review", () => {
  for (const status of ["denied", "rejected"]) assert.equal(belongs(pull({ matched: true }), run({ pull_number: 41, status })), false);
  for (const status of ["failed", "interrupted", "no_result"]) assert.equal(belongs(pull(), run({ pull_number: 41, status })), true);
});

test("a run that names none is of the pull requests its session is matched to or on the branch of, while they are open", () => {
  assert.equal(belongs(pull(), run()), false);
  assert.equal(belongs(pull({ matched: true }), run()), true);
  assert.equal(belongs(pull({ onBranch: true }), run()), true);
  const merged = { ended: at("12:00") };
  for (const how of [{ matched: true }, { onBranch: true }]) {
    assert.equal(belongs(pull({ ...how, ...merged }), run({ at: "2026-11-10T11:00:00Z" })), true);
    assert.equal(belongs(pull({ ...how, ...merged }), run({ at: "2026-11-10T13:00:00Z" })), false);
  }
});

test("on a branch with one pull request after another, a run is not of one while the one before it was open", () => {
  const next = pull({ onBranch: true, after: at("12:00") });
  assert.equal(belongs(next, run({ at: "2026-11-10T11:00:00Z" })), false);
  assert.equal(belongs(next, run({ at: "2026-11-10T13:00:00Z" })), true);
  // with no time it cannot be told which: neither's
  assert.equal(belongs(next, run()), false);
  // a matched session's is not held to the branch's order
  assert.equal(belongs({ ...next, matched: true }, run({ at: "2026-11-10T11:00:00Z" })), true);
});
