// The server with the Business and Enterprise features. Core-only installs run
// apps/server/src/index.ts instead. With no license installed this behaves exactly like the
// core server; the ee endpoints answer 403 license_required. With SESSIONLY_HOSTED=true it is
// a service many organisations share (hosted/), which takes no licenses.
import { runServer } from "@sessionly/server";
import { eeApi } from "./api.ts";
import { loadEeEnv } from "./config.ts";
import { Entitlements } from "./entitlements.ts";
import { accountsFrom, hostedNotes, hostedProblems } from "./hosted/config.ts";
import { reportsShownIn } from "./hosted/demo.ts";
import { hosting } from "./hosted/index.ts";
import { EE_MIGRATIONS } from "./migrate.ts";

const env = loadEeEnv();
const hosted = process.env.SESSIONLY_HOSTED === "true";

if (hosted) {
  const problems = hostedProblems(process.env);
  if (problems.length) {
    for (const problem of problems) console.error(`SESSIONLY_HOSTED: ${problem}`);
    process.exit(1);
  }
  for (const note of hostedNotes(process.env)) console.warn(note);
}

await runServer({
  edition: "Business and Enterprise features",
  migrations: [EE_MIGRATIONS],
  extensions: () => [eeApi({ entitlements: new Entitlements(), org: env.org, hosted })],
  hosting: hosted
    ? (db) =>
        hosting(db, {
          accounts: accountsFrom(process.env),
          // Whatever else is wrong with the settings of a demo: reports there are never kept whole.
          demo: reportsShownIn(process.env),
        })
    : undefined,
});
