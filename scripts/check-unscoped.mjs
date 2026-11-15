// Request handlers reach data only through `OrgDb`, the database as one
// organisation sees it. The owner's view, `Db`, sees every organisation's
// rows, so only the few files that must run before an organisation is known
// may import it. This fails if any other file does, however it spells the
// import (comments between its words, a `?query`, a %-escape), if `app.ts`
// uses the owner's database anywhere but where it finds a request's
// organisation, and if starting the server hands the owner's database to
// anything an edition supplies.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = {
  "apps/server/src": ["db.ts", "auth.ts", "cli.ts", "run.ts", "app.ts", "lib.ts", "testing.ts"],
  "ee/src": ["migrate.ts"],
};
// `import … from` and `export … from`: named, `* as`, `*`, or default.
const FROM =
  /\b(?:import|export)\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\w+|\{[^}]*\})(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?\s+from\s+["']([^"']+)["']/g;
// `import("…")`: awaited for the module, or written as a type.
const CALLED = /(?<![.\w])import\s*\(\s*(?:["'`]([^"'`]*)["'`]\s*\))?/g;
// The database module, and the two that pass its names on: the package's
// own front door (also what `@sessionly/server` is) and the tests' helpers.
const DATABASE = /(?:^|\/)(?:db|lib|testing)(?:\.(?:ts|js|mts|mjs))?$|^@sessionly\/server$/;
// Another way to load a module, which nothing here needs.
const REQUIRE = /\bcreateRequire\b|(?<![.\w])require\s*\(\s*["'`]/;
// The names that are, or hand out, the owner's view.
const OWNER = /(?:^|[\s,{])(?:type\s+)?(?:Db|openDb|testDb)(?:$|[\s,}])/;
// Where app.ts may use the owner's database: these and nothing else. The
// organisation of a transaction is the one of the request's token.
const IN_APP = [
  /^export function createApp\(ownerDb: Db\b/,
  /\bauthenticate\(ownerDb,/,
  /\bownerDb\.asOrg\(c\.get\("principal"\)\.orgId,/,
];
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

/**
 * The text without its comments, which can sit between any two words of an
 * import. Strings are kept as they are. This reads no grammar, so a file is
 * checked both ways, as written and like this: it can add to what is found
 * and never hide it.
 */
function uncommented(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && (ch === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * A module as the loader will find it: `./db.ts?again`, `./db.ts#x` and
 * `./d%62.ts` are all `./db.ts`. Null for one written with `\` escapes,
 * which are not read here.
 */
function moduleOf(from) {
  if (from.includes("\\")) return null;
  const file = from.replace(/(?!^)[?#].*$/s, "");
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

/** What is wrong with a file that is not one of the allowed ones. */
function imports(text) {
  return [...new Set([text, uncommented(text)].flatMap(importsAsWritten))];
}

function importsAsWritten(text) {
  const found = [];
  const unread = (whole) => `${whole.replace(/\s+/g, " ")}: a module's name is written plainly, without \\ escapes`;
  for (const [whole, names, from] of text.matchAll(FROM)) {
    const module = moduleOf(from);
    if (module === null) found.push(unread(whole));
    if (module === null || !DATABASE.test(module)) continue;
    // A whole module is everything in it, the owner's view included.
    if (!names.startsWith("{") || OWNER.test(whole)) found.push(whole.replace(/\s+/g, " "));
  }
  for (const [whole, from] of text.matchAll(CALLED)) {
    const module = from === undefined ? undefined : moduleOf(from);
    // One whose module cannot be read here could be the database's.
    if (module === undefined) found.push(`${whole.trim()}…): only import("a literal") can be checked`);
    else if (module === null) found.push(unread(whole));
    else if (DATABASE.test(module)) found.push(whole);
  }
  if (REQUIRE.test(text)) found.push("require(): modules are imported, where this check can read what from");
  return found;
}

/** What is wrong with how app.ts uses the owner's database. */
function inApp(text, allowed = IN_APP) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!/\bownerDb\b/.test(line) || COMMENT.test(line)) return;
    // Once on a line: a second use could ride along with an allowed one.
    if (!allowed.some((ok) => ok.test(line)) || line.match(/\bownerDb\b/g).length > 1) {
      found.push(`:${i + 1}: ${line.trim()}`);
    }
  });
  // The parameter keeps that name, so a use of it cannot hide as `db`.
  if (!/export function createApp\(ownerDb: Db\b/.test(text)) found.push(`: createApp must name its database "ownerDb"`);
  // An entry nothing uses any more would allow the next thing that looks like it.
  for (const ok of allowed) {
    if (!lines.some((line) => ok.test(line))) found.push(`: ${ok} in scripts/check-unscoped.mjs allows nothing; remove it`);
  }
  return found;
}

/** What is wrong with how run.ts starts the server. */
function inRun(text) {
  const found = [];
  // An edition adds tables by naming its migrations, and routes that get a
  // request's `OrgDb`. A callback given the database could keep it.
  if (/\boptions\.\w+\??\.?\(\s*[^)]*\bdb\b/.test(text)) found.push(`: an option is called with the owner's database`);
  const options = /export interface RunOptions \{[\s\S]*?\n\}/.exec(text)?.[0] ?? "";
  if (!options || /\bDb\b/.test(options)) found.push(`: RunOptions must not mention Db`);
  return found;
}

// The check checks itself first: every spelling that must be caught is.
const APP = [
  `export function createApp(ownerDb: Db, options: Options = {}): Hono<Env> {`,
  `  const principal = await authenticate(ownerDb, header);`,
  `  await ownerDb.asOrg(c.get("principal").orgId, async (orgDb) => {});`,
].join("\n");
const RUN = `export interface RunOptions {\n  migrations?: Migrations[];\n}\nfor (const m of options.migrations ?? []) {}`;
const MUST_FAIL = [
  ["imports", `import { openDb } from "./db.ts";`],
  ["imports", `import type { Db } from "../db.js";`],
  ["imports", `import { type Db as Database } from "@sessionly/server";`],
  ["imports", `import * as server from "@sessionly/server";`],
  ["imports", `import server from "./db";`],
  ["imports", `import server, { toApp } from "./db.ts";`],
  ["imports", `import { testDb } from "@sessionly/server";`],
  ["imports", `export { type Db as X } from "@sessionly/server";`],
  ["imports", `export * from "./db.ts";`],
  ["imports", `export * as database from "./db.ts";`],
  ["imports", `const { openDb } = await import("./db.ts");`],
  ["imports", `let kept: import("@sessionly/server").Db;`],
  ["imports", `const m = await import(where);`],
  ["imports", `import { openDb } from "./lib.ts";`],
  ["imports", `import { testDb } from "./testing.ts";`],
  ["imports", `import type { Db } from "../lib.js";`],
  ["imports", `import { createRequire } from "node:module";\nconst { openDb } = createRequire(import.meta.url)("./db.ts");`],
  ["imports", `const db = require("./db.ts");`],
  ["imports", `import { openDb } /* the owner's */ from "./db.ts";`],
  ["imports", `import { openDb } from /* the owner's */ "./db.ts";`],
  ["imports", `import { openDb/**/ } from "./db.ts";`],
  ["imports", `import { openDb } // the owner's\n  from "./db.ts";`],
  ["imports", `const { openDb } = await import(/* the owner's */ "./db.ts");`],
  ["imports", `import { openDb } from "./db.ts?again";`],
  ["imports", `import type { Db } from "./db.ts#x";`],
  ["imports", `const { openDb } = await import("./d%62.ts");`],
  ["imports", `import { testDb } from "./%74esting.ts?a#b";`],
  ["imports", `import { openDb } from "./d\\u0062.ts";`],
  ["imports", `const { openDb } = await import("./d\\x62.ts");`],
  ["inApp", `${APP}\n  api.get("/all", async (c) => c.json(await ownerDb.query("SELECT * FROM sessions")));`],
  ["inApp", `${APP}\n  await ownerDb.asOrg(c.req.query("org"), async (orgDb) => {});`],
  ["inApp", `${APP}\n  const db = ownerDb;`],
  ["inApp", `${APP}\n  const p = await authenticate(ownerDb, header), all = await ownerDb.query("SELECT * FROM tokens");`],
  ["inApp", APP.replace("ownerDb: Db", "db: Db")],
  ["inApp", APP.split("\n").slice(0, 2).join("\n")],
  ["inRun", `${RUN}\nawait options.prepare?.(db);`],
  ["inRun", RUN.replace("migrations?: Migrations[];", "prepare?: (db: Db) => Promise<void>;")],
];
const MUST_PASS = [
  ["imports", `import { rowLevelSecurity, toApp, type OrgDb } from "@sessionly/server";`],
  ["imports", `import type { OrgDb, Queryable } from "./db.ts";\nexport { toApp } from "./db.ts";`],
  ["imports", `const fs = await import("node:fs");`],
  ["imports", `import { toApp } from "./lib.ts";\nawait ent.require(db, "content_policy", "read");\nclass E {\n  async require(db, feature) {}\n}`],
  ["imports", `// More at https://example.com/db.ts\nimport { toApp } /* not the owner's */ from "./db.ts?again";`],
  ["imports", `const docs = "https://example.com//db.ts";\nimport { helper } from "./other.ts?from=db.ts";`],
  ["inApp", APP],
  ["inRun", RUN],
];
const checks = { imports, inApp, inRun };
const wrong = [
  ...MUST_FAIL.filter(([check, text]) => checks[check](text).length === 0).map(([, text]) => `not caught:\n${text}`),
  ...MUST_PASS.filter(([check, text]) => checks[check](text).length > 0).map(([, text]) => `wrongly caught:\n${text}`),
];
if (wrong.length) {
  console.error("scripts/check-unscoped.mjs does not check what it says it does:");
  for (const each of wrong) console.error(`  ${each.replace(/\n/g, "\n    ")}`);
  process.exit(1);
}

const found = [];
for (const [dir, allowed] of Object.entries(ALLOWED)) {
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry);
    if (!/\.(ts|mts)$/.test(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const at = `${dir}/${file}`;
    if (!allowed.includes(file)) found.push(...imports(text).map((what) => `${at}: ${what}`));
    if (at === "apps/server/src/app.ts") found.push(...inApp(text).map((what) => `${at}${what}`));
    if (at === "apps/server/src/run.ts") found.push(...inRun(text).map((what) => `${at}${what}`));
  }
}
if (found.length) {
  console.error("The database as its owner sees it (every organisation's rows) is used where it must not be:");
  for (const line of new Set(found)) console.error(`  ${line}`);
  console.error('Use OrgDb, from the request (c.get("db")), or add the place to scripts/check-unscoped.mjs with a reason.');
  process.exit(1);
}
console.log("Only the allowed places see the database unscoped.");
