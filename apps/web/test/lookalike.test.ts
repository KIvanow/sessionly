import assert from "node:assert/strict";
import { test } from "node:test";
import { reads } from "../src/lookalike.ts";

test("names that read alike are the same name", () => {
  const acme = reads("Acme");
  // Case, spacing, and the form of a letter.
  assert.equal(reads("  ACME "), acme);
  assert.equal(reads("Ａｃｍｅ"), acme);
  // A Cyrillic А and с, a Greek Α and ο: drawn the same, other letters.
  assert.equal(reads("\u0410cme"), acme);
  assert.equal(reads("A\u0441me"), acme);
  assert.equal(reads("\u0391cme"), acme);
  assert.equal(reads("Acme C\u043e"), reads("Acme Co"));
  assert.equal(reads("Acme C\u03bf"), reads("Acme Co"));
  // I, l and 1; O and 0.
  assert.equal(reads("Acme lnc"), reads("Acme Inc"));
  assert.equal(reads("Acme 1nc"), reads("Acme Inc"));
  assert.equal(reads("Acme C0"), reads("Acme Co"));
  // Names that do not read alike stay apart.
  assert.notEqual(reads("Acme"), reads("Acne"));
  assert.notEqual(reads("Acme"), reads("Acme Labs"));
  assert.notEqual(reads("Компания"), reads("Kompania"));
});
