// Hashing the lines a pull request adds, exactly as the sessionly binary
// hashes the lines an agent adds: the two are compared on the server.
// test/line-hashes.json holds cases both must agree on.
import { createHash } from "node:crypto";

// What Rust's `str::trim` removes (Unicode White_Space). JavaScript's own
// trim differs: it also removes a byte order mark and leaves U+0085.
const SPACE = "\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const ENDS = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");
// What Rust's `char::is_alphanumeric` accepts.
const LETTER_OR_DIGIT = /[\p{Alphabetic}\p{N}]/u;

/**
 * Hash of a line worth tracking: the first 8 bytes of the SHA-256 of the line
 * without the whitespace at its ends, in hex. Null for a line that is blank
 * or has no letter or digit (`}`, `);`): those would match almost anything.
 */
export function lineHash(line) {
  const text = line.replace(ENDS, "");
  if (!LETTER_OR_DIGIT.test(text)) return null;
  return createHash("sha256").update(text, "utf8").digest().subarray(0, 8).toString("hex");
}

/** Hashes of the tracked lines a patch adds. `patch` is a file's diff as GitHub's API gives it. */
export function addedHashes(patch) {
  const hashes = [];
  for (const line of patch.split("\n")) {
    // Hunks start with @@; the file headers (+++) are not part of the patch.
    if (!line.startsWith("+")) continue;
    const hash = lineHash(line.slice(1));
    if (hash) hashes.push(hash);
  }
  return hashes;
}

/** Hashes of every tracked line of a file, as the sessionly binary reads one to see what is still there. */
export function fileHashes(text) {
  const hashes = [];
  for (const line of text.split("\n")) {
    const hash = lineHash(line);
    if (hash) hashes.push(hash);
  }
  return hashes;
}

/** Turn the `ignore` input into a test for paths. */
export function ignoring(patterns) {
  const tests = patterns
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pattern) => {
      const body = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      // A pattern without a slash is a file name; with one, a path from the root.
      return new RegExp(pattern.includes("/") ? `^${body}$` : `(^|/)${body}$`);
    });
  return (path) => tests.some((test) => test.test(path));
}
