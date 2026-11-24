// Starts the server. Settings come from the environment:
//   PORT                   default 8080
//   HOST                   default 127.0.0.1 (use 0.0.0.0 in a container)
//   DATABASE_URL           postgres://… ; default: an embedded database in apps/server/data
//   SESSIONLY_DB_POOL      Postgres only: connections kept at most (default 10)
//   SESSIONLY_DB_QUERY_SECONDS  Postgres only: how long a statement may take (default 30, a day at most)
//   SESSIONLY_ADMIN_TOKEN  an admin token that always works (optional: for scripts and CI)
//   SESSIONLY_ADMIN_EMAIL  whose the dashboard is, which opens without signing in, and
//                          whose sessions uploads with that token belong to
//   SESSIONLY_TRUST_PROXY  "true" behind a proxy of your own, to count requests by its X-Forwarded-For
//   SESSIONLY_RATE_PER_MINUTE  requests a token may make a minute (default: not counted)
//   SESSIONLY_HASH_KEY     32 characters or more, kept secret and kept the same: what is stored of the
//                          addresses on a pull request's commits is hashed with it
//   SESSIONLY_TELEMETRY    "off" for the dashboard not to count which of its pages are opened
//                          (also off when DO_NOT_TRACK is set)
// A service many organisations share (SESSIONLY_HOSTED=true) is the ee server's:
// see ee/src/hosted.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, type Accounts, type Extension, type Hosting } from "./app.ts";
import { count, countHashedLines, DB_COUNTS, misset, openDb, runMigrations, type Db, type Migrations } from "./db.ts";
import { tidy } from "./limits.ts";
import { type SessionAt, UNWEIGHED, weighKeptSome } from "./pulls.ts";
import { telemetryFrom } from "./telemetry.ts";

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
  /**
   * A service many organisations share (ee/src/hosted). Signing in comes
   * before anyone is known, so it is handed the database as its owner sees it.
   */
  hosting?: (db: Db) => Hosting;
}

/** The least a key to hash with may be. */
const HASH_KEY_LENGTH = 32;

/** The key the committers kept of a pull request are hashed with, if one long enough is set. */
export function hashKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.SESSIONLY_HASH_KEY?.trim();
  return key && key.length >= HASH_KEY_LENGTH ? key : undefined;
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
export const COUNTS = ["SESSIONLY_RATE_PER_MINUTE", ...DB_COUNTS] as const;

/** A hosted service's own settings, which nothing else takes. */
const HOSTED_ONLY = ["SESSIONLY_SIGNUP", "SESSIONLY_SIGNUP_CODE", "SESSIONLY_SIGNUPS_PER_HOUR", "SESSIONLY_SIGNUPS_PER_NETWORK"];

/**
 * Why a server would wrongly start as one of your own, whose dashboard
 * opens to anyone without signing in: SESSIONLY_HOSTED written some other
 * way than "true", or left out where a hosted service's settings are.
 */
export function notHostedProblems(env: NodeJS.ProcessEnv): string[] {
  // As it is read everywhere else: " true" is not "true".
  const said = env.SESSIONLY_HOSTED ?? "";
  if (said !== "" && said !== "true" && said !== "false") {
    return [`SESSIONLY_HOSTED is "${said}": it is "true" for a hosted service, or "false" or unset for a server of your own.`];
  }
  if (said === "true") return [];
  const set = HOSTED_ONLY.filter((name) => env[name]?.trim());
  return set.length
    ? [
        `${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set, which only a hosted service takes, but SESSIONLY_HOSTED is not "true": this server would open its dashboard to anyone without signing in. Set SESSIONLY_HOSTED=true, or take ${set.length === 1 ? "it" : "them"} out.`,
      ]
    : [];
}

/** How people get in, as the environment sets it. */
export function accountsFrom(env: NodeJS.ProcessEnv): Accounts {
  return {
    admin: env.SESSIONLY_ADMIN_EMAIL?.trim() || undefined,
    trustProxy: env.SESSIONLY_TRUST_PROXY === "true",
    ratePerMinute: count(env.SESSIONLY_RATE_PER_MINUTE),
  };
}

/** Signing in with these is the hosted service's, each with the two settings it needs. */
const SIGN_IN_WITH = { Google: "SESSIONLY_GOOGLE_CLIENT", GitHub: "SESSIONLY_GITHUB_CLIENT" };

/**
 * Settings that do not do what whoever set them expects. Said at the start,
 * since the server otherwise runs as if they were not there.
 */
export function unheeded(env: NodeJS.ProcessEnv, hosted = false): string[] {
  const notes = misset(env, hosted ? [] : COUNTS);
  for (const [label, prefix] of Object.entries(SIGN_IN_WITH)) {
    const set = [`${prefix}_ID`, `${prefix}_SECRET`].filter((setting) => env[setting]?.trim());
    if (!hosted && set.length) {
      notes.push(
        `${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set, but signing in with ${label} is for the hosted service: this server's dashboard opens without signing in, and ${set.length === 1 ? "it is" : "they are"} not used.`,
      );
    }
  }
  if (env.SESSIONLY_HASH_KEY?.trim() && !hashKeyOf(env)) {
    notes.push(`SESSIONLY_HASH_KEY is shorter than ${HASH_KEY_LENGTH} characters, and is not used.`);
  }
  const mail = ["RESEND_API_KEY", "SESSIONLY_EMAIL_FROM", "SMTP_URL"].filter((name) => env[name]);
  if (mail.length) {
    notes.push(
      `${mail.join(" and ")} ${mail.length === 1 ? "is" : "are"} set, but no email is sent any more: people sign in with Google or GitHub.`,
    );
  }
  return notes;
}

export async function runServer(options: RunOptions = {}): Promise<void> {
  const hosted = options.hosting !== undefined;
  if (process.env.SESSIONLY_HOSTED === "true" && !hosted) {
    console.error("SESSIONLY_HOSTED is \"true\", but this is the core server: a hosted service is the ee server (ee/src/main.ts).");
    process.exit(1);
  }
  const misread = notHostedProblems(process.env);
  if (misread.length) {
    for (const problem of misread) console.error(problem);
    process.exit(1);
  }
  for (const note of unheeded(process.env, hosted)) console.warn(note);
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
  const accounts = accountsFrom(process.env);
  const telemetry = telemetryFrom(process.env);
  // Old counters and sign-ins nobody finished are cleared away now and then.
  const tidying = setInterval(() => void tidy(db).catch((err) => console.error("tidying failed:", err)), 15 * 60_000);
  tidying.unref();
  // What is still going on after an upload was answered: waited for before the server stops.
  const pending = new Set<Promise<void>>();
  const hosting = options.hosting?.(db);
  hosting?.start?.();
  const app = createApp(db, {
    background: (work) => {
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },
    hashKey: hashKeyOf(process.env),
    webRoot,
    accounts,
    hosting,
    telemetry,
    extensions: options.extensions?.(),
    bootstrap: adminToken
      ? // As written, as it always was: sessions it uploaded before are filed under it.
        { token: adminToken, email: process.env.SESSIONLY_ADMIN_EMAIL ?? "admin@localhost" }
      : undefined,
  });

  // Sessions from before their line hashes were counted: counted now, beside the requests.
  // What could not be counted (a statement that failed, the database gone for a moment) is tried again later.
  const counting = () =>
    void countHashedLines(db)
      .then(({ failed }) => failed > 0)
      .catch((err) => {
        console.error("counting sessions' line hashes failed:", err);
        return true;
      })
      .then((again) => {
        if (again) setTimeout(counting, 10 * 60_000).unref();
      });
  counting();

  // Pull requests' sessions kept before what their opening lines still there
  // count as was, or before what each contributed and is charged was: weighed
  // and charged now, beside the requests, so that no figure stays measured
  // the old way. What failed is tried again later.
  const weighing = () =>
    void (async () => {
      const orgs = await db.query<{ org_id: string }>(
        `SELECT DISTINCT s.org_id FROM pull_sessions s JOIN pull_requests r USING (org_id, repo, number) WHERE ${UNWEIGHED}`,
      );
      // One organisation's that fails holds up no other's: the rest are gone through, and it is tried again later.
      let failed = false;
      for (const { org_id } of orgs) {
        try {
          let after: SessionAt | null = null;
          do after = await db.asOrg(org_id, (tx) => weighKeptSome(tx, after));
          while (after);
        } catch (err) {
          failed = true;
          console.error(`weighing the pull requests' surviving lines of ${org_id} failed:`, err);
        }
      }
      if (failed) setTimeout(weighing, 10 * 60_000).unref();
    })().catch((err) => {
      console.error("weighing pull requests' surviving lines failed:", err);
      setTimeout(weighing, 10 * 60_000).unref();
    });
  weighing();

  const port = Number(process.env.PORT ?? 8080);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const where = /^postgres/.test(databaseUrl)
      ? "Postgres"
      : `embedded database in ${databaseUrl.replace(/^file:/, "")}`;
    const edition = options.edition ? `, ${options.edition}` : "";
    console.log(`sessionly server on http://${hostname}:${info.port} (${where}${edition})`);
    if (!webRoot) console.log("The dashboard is not built; run `pnpm build` to serve it here.");
    if (webRoot && telemetry && !hosted) {
      console.log(
        "The dashboard counts which of its pages are opened, with PostHog, and nothing of what they show. SESSIONLY_TELEMETRY=off turns that off.",
      );
    }
    for (const line of hosting?.said ?? []) console.log(line);
    if (!hosting) {
      console.log(
        `The dashboard opens without signing in, as ${accounts.admin ?? "admin@localhost"}: anyone who can reach this server is its admin. Machines connect with a token from its Connect page.`,
      );
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(async () => {
        // What goes on after an upload was answered (its pull requests charged and matched
        // again) is waited for: nothing would do it later for one left undone.
        await Promise.allSettled([...pending]);
        await db.close();
        process.exit(0);
      });
    });
  }
}
