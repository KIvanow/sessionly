// Starts the server. Settings come from the environment:
//   PORT                   default 8080
//   HOST                   default 127.0.0.1 (use 0.0.0.0 in a container)
//   DATABASE_URL           postgres://… ; default: an embedded database in apps/server/data
//   SESSIONLY_DB_POOL      Postgres only: connections kept at most (default 10)
//   SESSIONLY_DB_QUERY_SECONDS  Postgres only: how long a statement may take (default 30, a day at most)
//   SESSIONLY_ADMIN_TOKEN  an admin token that always works (for first use)
//   SESSIONLY_ADMIN_EMAIL  whose sessions uploads with that token belong to
//   SESSIONLY_HOSTED       "true" for a service that many organisations share
// Signing in by email (and, hosted, signing up) needs these two and the next:
//   RESEND_API_KEY         a key of resend.com with sending access: the links are sent through it
//   SESSIONLY_EMAIL_FROM   the address the links come from, e.g. "Sessionly <sign-in@example.com>",
//                          on a domain verified in Resend
//   SESSIONLY_PUBLIC_URL   where people reach the dashboard, e.g. https://app.example.com
//   SESSIONLY_SIGNUP       hosted only: "open" (the default) or "off"
//   SESSIONLY_SIGNUP_CODE  if set, signing up needs this code too
//   SESSIONLY_TRUST_PROXY  "true" behind a proxy of your own, to count requests by its X-Forwarded-For
//   SESSIONLY_RATE_PER_MINUTE  requests a token may make a minute (hosted default: 600)
//   SESSIONLY_SIGNUPS_PER_HOUR links to finish signing up sent an hour, in all (default 100)
//   SESSIONLY_SIGNUPS_PER_NETWORK  sign-ups asked for an hour from one network (default 10)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, type Extension } from "./app.ts";
import { count, DB_COUNTS, misset, openDb, runMigrations, type Migrations } from "./db.ts";
import { tidy } from "./limits.ts";
import { resendMailer, SEND_MS } from "./mail.ts";
import { offers, type Accounts } from "./signup.ts";

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
  for (const name of ["RESEND_API_KEY", "SESSIONLY_EMAIL_FROM", "SESSIONLY_PUBLIC_URL"]) {
    if (!env[name]) problems.push(`${name} is not set: nobody could sign in or sign up.`);
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

/** The settings that are a count of something: `count` in db.ts says what one is. */
const COUNTS = [
  "SESSIONLY_RATE_PER_MINUTE",
  "SESSIONLY_SIGNUPS_PER_HOUR",
  "SESSIONLY_SIGNUPS_PER_NETWORK",
  ...DB_COUNTS,
] as const;

/** How people get in, as the environment sets it. */
export function accountsFrom(env: NodeJS.ProcessEnv): Accounts {
  const hosted = env.SESSIONLY_HOSTED === "true";
  const publicUrl = env.SESSIONLY_PUBLIC_URL?.trim() || undefined;
  if (publicUrl && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
    throw new Error("SESSIONLY_PUBLIC_URL must be an address like https://app.example.com, with no path");
  }
  return {
    hosted,
    mailer:
      env.RESEND_API_KEY && env.SESSIONLY_EMAIL_FROM
        ? resendMailer(env.RESEND_API_KEY.trim(), env.SESSIONLY_EMAIL_FROM)
        : undefined,
    publicUrl,
    signup: env.SESSIONLY_SIGNUP === "off" ? "off" : "open",
    signupCode: env.SESSIONLY_SIGNUP_CODE?.trim() || undefined,
    trustProxy: env.SESSIONLY_TRUST_PROXY === "true",
    // A hosted service always has this limit; an install of one team has it if it is set.
    ratePerMinute: count(env.SESSIONLY_RATE_PER_MINUTE) ?? (hosted ? 600 : undefined),
    signupsPerHour: count(env.SESSIONLY_SIGNUPS_PER_HOUR),
    signupsPerNetwork: count(env.SESSIONLY_SIGNUPS_PER_NETWORK),
  };
}

/**
 * Settings that do not do what whoever set them expects. Said at the start,
 * since the server otherwise runs as if they were not there.
 */
export function unheeded(env: NodeJS.ProcessEnv): string[] {
  const notes = misset(env, COUNTS);
  if (env.SMTP_URL && !env.RESEND_API_KEY) {
    notes.push(
      "SMTP_URL is set, but email is sent through Resend now and not over SMTP: signing in by email is off until RESEND_API_KEY is set.",
    );
  }
  return notes;
}

/**
 * Work that an answer does not wait for (sending a message), kept track of
 * so that stopping the server can wait for it.
 */
export function background() {
  const running = new Set<Promise<void>>();
  return {
    defer(work: () => Promise<void>): void {
      const done: Promise<void> = work()
        .catch((err: unknown) => console.error(`work after an answer failed: ${reason(err)}`))
        .finally(() => running.delete(done));
      running.add(done);
    },
    /** Resolves once nothing is running, or after `ms` whatever still is. */
    async idle(ms: number): Promise<void> {
      const until = Date.now() + ms;
      while (running.size && Date.now() < until) {
        await Promise.race([Promise.all(running), new Promise((resolve) => setTimeout(resolve, until - Date.now()))]);
      }
    },
  };
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
  for (const note of unheeded(process.env)) console.warn(note);
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
  const after = background();
  const accounts = { ...accountsFrom(process.env), defer: after.defer };
  // Old counters and links that ran out are cleared away now and then.
  const tidying = setInterval(() => void tidy(db).catch((err) => console.error("tidying failed:", err)), 15 * 60_000);
  tidying.unref();
  const app = createApp(db, {
    webRoot,
    accounts,
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
    const offered = offers(accounts);
    if (offered.emailSignIn) {
      console.log(`Signing in by email is on${offered.signup ? ", and anyone may sign up" : ""}${offered.inviteCode ? " with the invitation code" : ""}.`);
    }
    if (!adminToken && !hosted) {
      console.log(
        "No SESSIONLY_ADMIN_TOKEN set: create tokens with `pnpm token create --email you@example.com --role admin`",
      );
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(async () => {
        // A message that is on its way out is let go first: as long as one
        // can take to be sent or given up on, so that none is left as a
        // link nobody got that still holds back the next.
        await after.idle(SEND_MS);
        await db.close();
        process.exit(0);
      });
    });
  }
}
