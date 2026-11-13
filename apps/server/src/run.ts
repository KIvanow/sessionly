// Starts the server. Settings come from the environment:
//   PORT                   default 8080
//   HOST                   default 127.0.0.1 (use 0.0.0.0 in a container)
//   DATABASE_URL           postgres://… ; default: an embedded database in apps/server/data
//   SESSIONLY_ADMIN_TOKEN  an admin token that always works (for first use)
//   SESSIONLY_ADMIN_EMAIL  whose sessions uploads with that token belong to
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, type Extension } from "./app.ts";
import { openDb, type Db } from "./db.ts";

export interface RunOptions {
  /** Runs after the core's migrations and before the server listens. */
  prepare?: (db: Db) => Promise<void>;
  /** Extra routes for the authenticated API. */
  extensions?: (db: Db) => Extension[];
  /** Shown in the start-up line, e.g. "Business and Enterprise features". */
  edition?: string;
}

export async function runServer(options: RunOptions = {}): Promise<void> {
  // The embedded database lives next to the server's code, wherever it is started from.
  const embedded = fileURLToPath(new URL("../data/pglite", import.meta.url));
  const databaseUrl = process.env.DATABASE_URL ?? `file:${embedded}`;
  const db = await openDb(databaseUrl);
  await options.prepare?.(db);
  const adminToken = process.env.SESSIONLY_ADMIN_TOKEN;
  // The dashboard, if it has been built (pnpm build).
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const webRoot = existsSync(webDist) ? webDist : undefined;
  const app = createApp(db, {
    webRoot,
    extensions: options.extensions?.(db),
    bootstrap: adminToken
      ? { token: adminToken, email: process.env.SESSIONLY_ADMIN_EMAIL ?? "admin@localhost" }
      : undefined,
  });

  const port = Number(process.env.PORT ?? 8080);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const where = /^postgres/.test(databaseUrl)
      ? "Postgres"
      : `embedded database in ${databaseUrl.replace(/^file:/, "")}`;
    const edition = options.edition ? `, ${options.edition}` : "";
    console.log(`sessionly server on http://${hostname}:${info.port} (${where}${edition})`);
    if (!webRoot) console.log("The dashboard is not built; run `pnpm build` to serve it here.");
    if (!adminToken) {
      console.log(
        "No SESSIONLY_ADMIN_TOKEN set: create tokens with `pnpm token create --email you@example.com --role admin`",
      );
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(async () => {
        await db.close();
        process.exit(0);
      });
    });
  }
}
