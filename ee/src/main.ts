// The server with the Business and Enterprise features. Core-only installs run
// apps/server/src/index.ts instead. With no license installed this behaves exactly like the
// core server; the ee endpoints answer 403 license_required.
import { runServer } from "@sessionly/server";
import { eeApi } from "./api.ts";
import { loadEeEnv } from "./config.ts";
import { Entitlements } from "./entitlements.ts";
import { EE_MIGRATIONS } from "./migrate.ts";

const env = loadEeEnv();

await runServer({
  edition: "Business and Enterprise features",
  migrations: [EE_MIGRATIONS],
  extensions: () => [
    eeApi({ entitlements: new Entitlements(), org: env.org, hosted: process.env.SESSIONLY_HOSTED === "true" }),
  ],
});
