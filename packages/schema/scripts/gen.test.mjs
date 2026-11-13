import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { generate, outPath } from "./gen.mjs";

test("the checked-in TypeScript types match the JSON Schema", async () => {
  assert.equal(
    await readFile(outPath, "utf8"),
    await generate(),
    "packages/schema/src/upload.ts is stale; run: pnpm gen",
  );
});
