// Tokens and people from the command line, straight against the database:
//   node src/cli.ts token create --email ann@example.com [--name Ann] [--role admin]
//   node src/cli.ts token list
//   node src/cli.ts token revoke <id>
//   node src/cli.ts person list
//   node src/cli.ts person forget-account --email ann@example.com
// The person command lets a person sign in with another Google or GitHub account than
// the one they have here: for an owner whose account is gone, whom nobody
// in the organisation can let in. Token and person commands take --org <id>
// for an organisation other than a self-hosted install's own, "default".
// What a hosted service's operator does (org restore, org purge, demo import) is
// ee/src/cli.ts.
// With the embedded database, stop the server first (one process at a time),
// or use the /api/v1/tokens endpoints with an admin token instead.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createToken, DEFAULT_ORG, listTokens, revokeToken, type Role } from "./auth.ts";
import { openDb } from "./db.ts";
import { forgetAccount, listUsers, UserProblem } from "./users.ts";

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
    "usage: token create --email <email> [--name <name>] [--role admin|member] | token list | token revoke <id>\n" +
      "       person list | person forget-account --email <email>\n" +
      "       (each with [--org <id>])",
  );
  process.exit(2);
}
if (group !== "token" && group !== "person") usage();

const embedded = fileURLToPath(new URL("../data/pglite", import.meta.url));
const db = await openDb(process.env.DATABASE_URL ?? `file:${embedded}`);
const org = values.org ?? DEFAULT_ORG;
try {
  if (!(await db.query(`SELECT id FROM orgs WHERE id = $1 AND deleted_at IS NULL`, [org]))[0]) {
    console.error(`There is no organisation "${org}".`);
    process.exitCode = 1;
  } else if (group === "person" && action === "list") {
    for (const u of await db.asOrg(org, listUsers)) {
      const how = u.removed_at ? "removed" : u.signed_in_with ? `signs in with ${u.signed_in_with}` : "has not signed in";
      console.log(`${u.id}  ${u.role.padEnd(6)}  ${u.email}  (${how})`);
    }
  } else if (group === "person" && action === "forget-account") {
    const email = values.email;
    if (!email) usage();
    try {
      const user = await db.asOrg(org, (scoped) => forgetAccount(scoped, { email }, null));
      console.log(
        `${user.email} (${user.role}) of "${org}" can now sign in with any Google or GitHub account that has that address.\n` +
          "Whoever does so first is asked, and is then who that person is here. Their sessions were ended; the tokens of their machines were not.",
      );
    } catch (err) {
      if (!(err instanceof UserProblem)) throw err;
      console.error(`${err.message}.`);
      process.exitCode = 1;
    }
  } else if (group === "person") {
    usage();
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
