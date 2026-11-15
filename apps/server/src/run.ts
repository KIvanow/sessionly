// Starts the server. Settings come from the environment:
//   PORT                   default 8080
//   HOST                   default 127.0.0.1 (use 0.0.0.0 in a container)
//   DATABASE_URL           postgres://… ; default: an embedded database in apps/server/data
//   SESSIONLY_ADMIN_TOKEN  an admin token that always works (for first use)
//   SESSIONLY_ADMIN_EMAIL  whose sessions uploads with that token belong to
//   SESSIONLY_HOSTED       "true" for a service that many organisations share
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, type Extension } from "./app.ts";
import { openDb, runMigrations, type Migrations } from "./db.ts";

export interface RunOptions {
  /**
   * Tables of its own that an edition adds, each list recorded under its own
   * table name. They run after the core's migrations and before the server
   * listens. An edition names them and is never handed the database itself.
   */
  migrations?: Migrations[];
  /** Extra routes for the authenticated API. */
  extensions?: () => Extension[];
  /** Shown in the start-up line, e.g. "Business and Enterprise features". */
  edition?: string;
}

/**
 * What a service shared by many organisations must not be started with. A
 * self-hosted install has one organisation, "default", and none of this
 * applies to it.
 */
export function hostedProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (env.SESSIONLY_ADMIN_TOKEN) {
    problems.push("SESSIONLY_ADMIN_TOKEN is set: a hosted service has no admin of every organisation.");
  }
  if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL ?? "")) {
    problems.push("DATABASE_URL must be a postgres:// address: the embedded database is for one install.");
  }
  return problems;
}

/**
 * Why something failed, in words. A connection that was refused comes as
 * several errors under one with no message of its own (one per address
 * tried), so those are what is said.
 */
export function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const each = err instanceof AggregateError ? err.errors.map(reason).filter(Boolean) : [];
  const code = (err as { code?: unknown }).code;
  return err.message || [...new Set(each)].join("; ") || (typeof code === "string" ? code : err.name);
}

export async function runServer(options: RunOptions = {}): Promise<void> {
  const hosted = process.env.SESSIONLY_HOSTED === "true";
  if (hosted) {
    const problems = hostedProblems(process.env);
    if (problems.length) {
      for (const problem of problems) console.error(`SESSIONLY_HOSTED: ${problem}`);
      process.exit(1);
    }
  }
  // The embedded database lives next to the server's code, wherever it is started from.
  const embedded = fileURLToPath(new URL("../data/pglite", import.meta.url));
  const databaseUrl = process.env.DATABASE_URL ?? `file:${embedded}`;
  // A database that cannot be used is said in a few lines, with what to do
  // about it where that is known, and not as a stack of where it failed.
  const cannot = (what: string) => (err: unknown) => {
    console.error(`${what}\n${reason(err)}`);
    process.exit(1);
  };
  const db = await openDb(databaseUrl).catch(cannot("The database could not be opened."));
  for (const { table, list } of options.migrations ?? []) {
    await runMigrations(db, table, list).catch(cannot(`The database could not be brought up to date (${table}).`));
  }
  const adminToken = process.env.SESSIONLY_ADMIN_TOKEN;
  // The dashboard, if it has been built (pnpm build).
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const webRoot = existsSync(webDist) ? webDist : undefined;
  const app = createApp(db, {
    webRoot,
    extensions: options.extensions?.(),
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
    if (!adminToken && !hosted) {
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
