// The settings of a service many organisations share (SESSIONLY_HOSTED=true),
// on top of the core server's (apps/server/src/run.ts):
//   SESSIONLY_PUBLIC_URL   where people reach the dashboard, e.g. https://app.example.com
//   SESSIONLY_GOOGLE_CLIENT_ID, SESSIONLY_GOOGLE_CLIENT_SECRET
//                          of an OAuth client (a "Web application") in Google Cloud, whose redirect
//                          URI is <public address>/api/v1/auth/google/callback
//   SESSIONLY_GITHUB_CLIENT_ID, SESSIONLY_GITHUB_CLIENT_SECRET
//                          of an OAuth app on GitHub, whose callback URL is
//                          <public address>/api/v1/auth/github/callback
//   SESSIONLY_SIGNUP       "open" (the default) or "off"
//   SESSIONLY_SIGNUP_CODE  if set, signing up needs this code too
//   SESSIONLY_RATE_PER_MINUTE  requests a token may make a minute (default: 600)
//   SESSIONLY_SIGNUPS_PER_HOUR organisations created an hour, in all (default 100)
//   SESSIONLY_SIGNUPS_PER_NETWORK  organisations created an hour from one network (default 10)
//   SESSIONLY_HASH_KEY     required
//   SESSIONLY_DEMO_FROM, SESSIONLY_DEMO_REPO, SESSIONLY_DEMO_ORG
//                          one repository's sessions, uploaded to the first organisation, are shown
//                          in the second without anything that was typed or run, as
//                          `node src/cli.ts demo import` copies them (see demo.ts); reports to the
//                          second are kept without SESSIONLY_DEMO_HIDE: what of it not to show
import { count, HASH_KEY_LENGTH, hashKeyOf, misset, providerSettings as settingsOf } from "@sessionly/server";
import { demoFrom, reportsShownIn } from "./demo.ts";
import { github, google, PROVIDER_LABELS as LABELS, PROVIDER_NAMES, type Client, type Provider, type ProviderName } from "./oauth.ts";
import type { Accounts } from "./signup.ts";

/** A plain-HTTP address that leads nowhere but to this machine. */
const ON_THIS_MACHINE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/;

/** The settings that are a count of something, beyond the core's (which it checks itself). */
const HOSTED_COUNTS = ["SESSIONLY_SIGNUPS_PER_HOUR", "SESSIONLY_SIGNUPS_PER_NETWORK"] as const;

/** What the environment has for a provider, if it has both halves. */
function clientOf(env: NodeJS.ProcessEnv, name: ProviderName): Client | undefined {
  const [id, secret] = settingsOf(name).map((setting) => env[setting]?.trim());
  return id && secret ? { id, secret } : undefined;
}

const MAKERS: Record<ProviderName, (client: Client) => Provider> = { google, github };

/** What a service shared by many organisations must not be started with. */
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

/** How people get in, as the environment sets it. */
export function accountsFrom(env: NodeJS.ProcessEnv): Accounts {
  const publicUrl = env.SESSIONLY_PUBLIC_URL?.trim() || undefined;
  if (publicUrl && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
    throw new Error("SESSIONLY_PUBLIC_URL must be an address like https://app.example.com, with no path");
  }
  return {
    providers: PROVIDER_NAMES.flatMap((name) => {
      const client = clientOf(env, name);
      return client ? [MAKERS[name](client)] : [];
    }),
    publicUrl,
    signup: env.SESSIONLY_SIGNUP === "off" ? "off" : "open",
    signupCode: env.SESSIONLY_SIGNUP_CODE?.trim() || undefined,
    trustProxy: env.SESSIONLY_TRUST_PROXY === "true",
    ratePerMinute: count(env.SESSIONLY_RATE_PER_MINUTE) ?? 600,
    signupsPerHour: count(env.SESSIONLY_SIGNUPS_PER_HOUR),
    signupsPerNetwork: count(env.SESSIONLY_SIGNUPS_PER_NETWORK),
  };
}

/**
 * Settings that do not do what whoever set them expects, beyond what the
 * core says of its own. Said at the start, since the server otherwise runs
 * as if they were not there.
 */
export function hostedNotes(env: NodeJS.ProcessEnv): string[] {
  const notes = misset(env, HOSTED_COUNTS);
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
  const demo = demoFrom(env);
  if (demo && "problem" in demo) notes.push(demo.problem);
  // What is wrong with the paths not to show is said even when something else is: reports are refused for it.
  const reports = reportsShownIn(env);
  if (reports && "problem" in reports && !notes.includes(reports.problem)) notes.push(reports.problem);
  return notes;
}
