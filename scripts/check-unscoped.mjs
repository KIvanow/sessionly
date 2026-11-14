// Request handlers reach data only through `OrgDb`, the database as one
// organisation sees it. The owner's view, `Db`, sees every organisation's
// rows, so only the few files that must run before an organisation is known
// may import it. This fails if any other file does, however it spells the
// import, and if `app.ts` uses the owner's database anywhere but where it
// finds a request's organisation.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = {
  "apps/server/src": ["db.ts", "auth.ts", "cli.ts", "run.ts", "app.ts", "lib.ts", "testing.ts"],
  "ee/src": ["migrate.ts"],
};
// Any import from the database module or from the server package: named,
// `* as`, or default; `./db.ts`, `../db.ts`, `.js`, with either quote.
const IMPORT = /import\s+(?:type\s+)?(\*\s+as\s+\w+|\w+|\{[^}]*\})(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/g;
const DATABASE = /(?:^|\/)db(?:\.(?:ts|js|mts|mjs))?$|^@sessionly\/server$/;
const OWNER = /(?:^|[\s,{])(?:type\s+)?(?:Db|openDb)(?:$|[\s,}])/;
// Where app.ts may use the owner's database: these and nothing else.
const IN_APP = [
  /^export function createApp\(ownerDb: Db\b/,
  /\bauthenticate\(ownerDb,/,
  /\bownerDb\.asOrg\(/,
  /\ballowed\(ownerDb,/,
  /\bopenRoutes\(ownerDb,/,
  /\bownerDb\.query\(`SELECT 1`\)/,
  /^\s*(\/\/|\*)/,
];

const found = [];
for (const [dir, allowed] of Object.entries(ALLOWED)) {
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry);
    if (!/\.(ts|mts)$/.test(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    if (!allowed.includes(file)) {
      for (const [whole, names, from] of text.matchAll(IMPORT)) {
        if (!DATABASE.test(from)) continue;
        // A whole module is everything in it, the owner's view included.
        if (!names.startsWith("{") || OWNER.test(whole)) found.push(`${dir}/${file}: ${whole.replace(/\s+/g, " ")}`);
      }
    }
    if (dir === "apps/server/src" && file === "app.ts") {
      text.split("\n").forEach((line, i) => {
        if (/\bownerDb\b/.test(line) && !IN_APP.some((ok) => ok.test(line))) {
          found.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
        }
      });
      // The parameter keeps that name, so a use of it cannot hide as `db`.
      if (!/export function createApp\(ownerDb: Db\b/.test(text)) {
        found.push(`${dir}/${file}: createApp must name its database "ownerDb"`);
      }
    }
  }
}
if (found.length) {
  console.error("The database as its owner sees it (every organisation's rows) is used where it must not be:");
  for (const line of new Set(found)) console.error(`  ${line}`);
  console.error('Use OrgDb, from the request (c.get("db")), or add the place to scripts/check-unscoped.mjs with a reason.');
  process.exit(1);
}
console.log("Only the allowed places see the database unscoped.");
