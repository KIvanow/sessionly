import assert from "node:assert/strict";
import { test } from "node:test";
import { query, samePullFilters } from "../src/api.ts";

const filters = query({ since: "2026-01-01T00:00:00Z", repo: "acme/web", state: "merged" });
const page = (offset: number) =>
  `/prs${query({ since: "2026-01-01T00:00:00Z", repo: "acme/web", state: "merged", limit: 50, offset })}`;

test("another page of the same pull request list is still that list", () => {
  assert.equal(samePullFilters(page(0), filters), true);
  assert.equal(samePullFilters(page(50), filters), true);
  assert.equal(samePullFilters(`/prs${filters}`, filters), true);
});

test("a pull request list for another filter is not this one", () => {
  const other = query({ repo: "acme/other", state: "merged" });
  assert.equal(samePullFilters(page(0), other), false);
  assert.equal(samePullFilters(null, filters), false);
  assert.equal(samePullFilters(`/prs/summary${filters}`, filters), false);
  assert.equal(samePullFilters(`/prs${query({ limit: 50, offset: 0 })}`, filters), false);
});
