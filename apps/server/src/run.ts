// Starts the server. Settings come from the environment:
//   PORT                   default 8080
//   HOST                   default 127.0.0.1 (use 0.0.0.0 in a container)
//   DATABASE_URL           postgres://… ; default: an embedded database in apps/server/data
//   SESSIONLY_DB_POOL      Postgres only: connections kept at most (default 10)
//   SESSIONLY_DB_QUERY_SECONDS  Postgres only: how long a statement may take (default 30, a day at most)
//   SESSIONLY_ADMIN_TOKEN  an admin token that always works (for first use)
//   SESSIONLY_ADMIN_EMAIL  whose sessions uploads with that token belong to
//   SESSIONLY_HOSTED       "true" for a service that many organisations share
// Signing in with Google or GitHub (and, hosted, signing up) needs the public
// address and the id and secret of at least one of the two:
//   SESSIONLY_PUBLIC_URL   where people reach the dashboard, e.g. https://app.example.com
//   SESSIONLY_GOOGLE_CLIENT_ID, SESSIONLY_GOOGLE_CLIENT_SECRET
//                          of an OAuth client (a "Web application") in Google Cloud, whose redirect
//                          URI is <public address>/api/v1/auth/google/callback
//   SESSIONLY_GITHUB_CLIENT_ID, SESSIONLY_GITHUB_CLIENT_SECRET
//                          of an OAuth app on GitHub, whose callback URL is
//                          <public address>/api/v1/auth/github/callback
//   SESSIONLY_SIGNUP       hosted only: "open" (the default) or "off"
//   SESSIONLY_SIGNUP_CODE  if set, signing up needs this code too
//   SESSIONLY_TRUST_PROXY  "true" behind a proxy of your own, to count requests by its X-Forwarded-For
//   SESSIONLY_RATE_PER_MINUTE  requests a token may make a minute (hosted default: 600)
//   SESSIONLY_SIGNUPS_PER_HOUR organisations created an hour, in all (default 100)
//   SESSIONLY_SIGNUPS_PER_NETWORK  organisations created an hour from one network (default 10)
//   SESSIONLY_HASH_KEY     32 characters or more, kept secret and kept the same: what is stored of the
//                          addresses on a pull request's commits is hashed with it (hosted: required)
//   SESSIONLY_TELEMETRY    "off" for the dashboard not to count which of its pages are opened
//                          (also off when DO_NOT_TRACK is set)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, type Extension } from "./app.ts";
import { count, DB_COUNTS, misset, openDb, runMigrations, type Migrations } from "./db.ts";
import { tidy } from "./limits.ts";
import {
  github,
  google,
  PROVIDER_LABELS as LABELS,
  PROVIDER_NAMES,
  type Client,
  type Provider,
  type ProviderName,
} from "./oauth.ts";
import { offers, type Accounts } from "./signup.ts";
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
}

/** A plain-HTTP address that leads nowhere but to this machine. */
const ON_THIS_MACHINE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/;

/**
 * What a service shared by many organisations must not be started with. A
 * self-hosted install has one organisation, "default", and none of this
 * applies to it.
 */
/** The least a key to hash with may be. */
const HASH_KEY_LENGTH = 32;

/** The key the committers kept of a pull request are hashed with, if one long enough is set. */
export function hashKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.SESSIONLY_HASH_KEY?.trim();
  return key && key.length >= HASH_KEY_LENGTH ? key : undefined;
}

export function hostedProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (env.SESSIONLY_ADMIN_TOKEN) {
    problems.push("SESSIONLY_ADMIN_TOKEN is set: a hosted service has no admin of every organisation.");
  }
  if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL ?? "")) {
    problems.push("DATABASE_URL must be a postgres:// address: the embedded database is for one install.");
  }
  const publicUrl = env.SESSIONLY_PUBLIC_URL?.trim();
  if (!publicUrl) {
    problems.push("SESSIONLY_PUBLIC_URL is not set: nobody could sign in or sign up.");
  } else if (!publicUrl.startsWith("https://") && !ON_THIS_MACHINE.test(publicUrl)) {
    // Over plain HTTP the cookies that carry a sign-in are not kept to this
    // host or to an encrypted connection, and every token crosses in clear.
    // On this machine itself nothing crosses anything: that is how a hosted
    // service is tried before it has a name and a certificate.
    problems.push(
      "SESSIONLY_PUBLIC_URL must begin with https://: a hosted service is not reached over plain HTTP, except on the machine it runs on (http://localhost).",
    );
  }
  if (!hashKeyOf(env)) {
    problems.push(
      `SESSIONLY_HASH_KEY is not set, or is shorter than ${HASH_KEY_LENGTH} characters: what is kept of the addresses on a pull request's commits is hashed with it. Any long random text will do (openssl rand -hex 32); keep it, since pull requests kept with another have to be reported again before their lines can be matched again.`,
    );
  }
  if (!PROVIDER_NAMES.some((name) => clientOf(env, name))) {
    problems.push(
      `No way of signing in is set (${PROVIDER_NAMES.map((name) => settingsOf(name).join(" with ")).join(", or ")}): nobody could sign in or sign up.`,
    );
  }
  return problems;
}

/** The two settings a provider needs. */
function settingsOf(name: ProviderName): [id: string, secret: string] {
  const prefix = `SESSIONLY_${name.toUpperCase()}_CLIENT`;
  return [`${prefix}_ID`, `${prefix}_SECRET`];
}

/** What the environment has for a provider, if it has both halves. */
function clientOf(env: NodeJS.ProcessEnv, name: ProviderName): Client | undefined {
  const [id, secret] = settingsOf(name).map((setting) => env[setting]?.trim());
  return id && secret ? { id, secret } : undefined;
}

const MAKERS: Record<ProviderName, (client: Client) => Provider> = { google, github };

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
    providers: PROVIDER_NAMES.flatMap((name) => {
      const client = clientOf(env, name);
      return client ? [MAKERS[name](client)] : [];
    }),
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
  for (const name of PROVIDER_NAMES) {
    const [id, secret] = settingsOf(name);
    if (Boolean(env[id]?.trim()) !== Boolean(env[secret]?.trim())) {
      notes.push(`Only one of ${id} and ${secret} is set: signing in with ${LABELS[name]} needs both, and is off.`);
    } else if (clientOf(env, name) && !env.SESSIONLY_PUBLIC_URL?.trim()) {
      notes.push(`${id} is set, but SESSIONLY_PUBLIC_URL is not: signing in with ${LABELS[name]} is off, since it has nowhere to send people back to.`);
    }
  }
  const publicUrl = env.SESSIONLY_PUBLIC_URL?.trim() ?? "";
  if (publicUrl.startsWith("http://") && !ON_THIS_MACHINE.test(publicUrl) && PROVIDER_NAMES.some((name) => clientOf(env, name))) {
    notes.push(
      "SESSIONLY_PUBLIC_URL is plain HTTP on a host that is not this machine: sign-ins and tokens cross the network in clear. Put it behind HTTPS.",
    );
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
  const accounts = accountsFrom(process.env);
  const telemetry = telemetryFrom(process.env);
  // Old counters and sign-ins nobody finished are cleared away now and then.
  const tidying = setInterval(() => void tidy(db).catch((err) => console.error("tidying failed:", err)), 15 * 60_000);
  tidying.unref();
  const app = createApp(db, {
    hashKey: hashKeyOf(process.env),
    webRoot,
    accounts,
    telemetry,
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
    if (webRoot && telemetry && !hosted) {
      console.log(
        "The dashboard counts which of its pages are opened, with PostHog, and nothing of what they show. SESSIONLY_TELEMETRY=off turns that off.",
      );
    }
    const offered = offers(accounts);
    if (offered.providers.length) {
      const ways = offered.providers.map((name) => LABELS[name]).join(" and ");
      console.log(`Signing in with ${ways} is on${offered.signup ? ", and anyone may sign up" : ""}${offered.signup && offered.inviteCode ? " with the invitation code" : ""}.`);
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
        await db.close();
        process.exit(0);
      });
    });
  }
}
