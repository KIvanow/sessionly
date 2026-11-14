// Request handlers reach data only through `OrgDb`, the database as one
// organisation sees it. The owner's view, `Db`, sees every organisation's
// rows, so only the few files that must run before an organisation is known
// may import it. This fails if any other file does.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = {
  "apps/server/src": ["db.ts", "auth.ts", "cli.ts", "run.ts", "app.ts", "lib.ts", "testing.ts"],
  "ee/src": ["migrate.ts"],
};
// `Db` or `openDb` as a name of its own in an import, from the server's database module.
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(?:\.\/db\.ts|@sessionly\/server)"/g;
const OWNER = /(?:^|[\s,])(?:type\s+)?(?:Db|openDb)(?:$|[\s,])/;

const found = [];
for (const [dir, allowed] of Object.entries(ALLOWED)) {
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry);
    if (!file.endsWith(".ts") || allowed.includes(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(IMPORT)) {
      if (OWNER.test(match[1])) found.push(`${dir}/${file}`);
    }
  }
}
if (found.length) {
  console.error("These files import the database as its owner sees it (every organisation's rows):");
  for (const file of new Set(found)) console.error(`  ${file}`);
  console.error("Use OrgDb, from the request (c.get(\"db\")), or add the file to scripts/check-unscoped.mjs with a reason.");
  process.exit(1);
}
console.log("Only the allowed files see the database unscoped.");
