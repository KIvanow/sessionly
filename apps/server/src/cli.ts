// Token management from the command line, straight against the database:
//   node src/cli.ts token create --email ann@example.com [--name Ann] [--role admin]
//   node src/cli.ts token list
//   node src/cli.ts token revoke <id>
// Each takes --org <id> for an organisation other than a self-hosted
// install's own, "default".
// With the embedded database, stop the server first (one process at a time),
// or use the /api/v1/tokens endpoints with an admin token instead.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createToken, DEFAULT_ORG, listTokens, revokeToken, type Role } from "./auth.ts";
import { openDb } from "./db.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    org: { type: "string" },
  },
});
const [group, action, id] = positionals;

function usage(): never {
  console.error(
    "usage: token create --email <email> [--name <name>] [--role admin|member] | token list | token revoke <id>  (each with [--org <id>])",
  );
  process.exit(2);
}
if (group !== "token") usage();

const embedded = fileURLToPath(new URL("../data/pglite", import.meta.url));
const db = await openDb(process.env.DATABASE_URL ?? `file:${embedded}`);
const org = values.org ?? DEFAULT_ORG;
try {
  const [known] = await db.query(`SELECT id FROM orgs WHERE id = $1 AND deleted_at IS NULL`, [org]);
  if (!known) {
    console.error(`There is no organisation "${org}".`);
    process.exitCode = 1;
  } else if (action === "create") {
    const role = (values.role ?? "member") as Role;
    const email = values.email;
    if (!email || (role !== "admin" && role !== "member")) usage();
    const created = await db.asOrg(org, (scoped) => createToken(scoped, { email, name: values.name, role }));
    console.log(`Token for ${email} (${role}), shown only once:\n${created.token}`);
  } else if (action === "list") {
    for (const t of await db.asOrg(org, listTokens)) {
      const state = t.revoked_at ? "revoked" : "active";
      console.log(`${t.id}  ${t.role.padEnd(6)}  ${state.padEnd(7)}  ${t.email}${t.name ? ` (${t.name})` : ""}`);
    }
  } else if (action === "revoke" && id) {
    console.log((await db.asOrg(org, (scoped) => revokeToken(scoped, id))) ? "Revoked." : "No such active token.");
  } else {
    usage();
  }
} finally {
  await db.close();
}
