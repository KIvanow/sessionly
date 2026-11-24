// Signing up, signing in with Google or GitHub, and the people of an organisation, on the hosted service.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env, type Options } from "../../../apps/server/src/app.ts";
import { APP_ROLE, migrationAt, openDb, type Db } from "../../../apps/server/src/db.ts";
import { giveBack, network, take, tidy, widerNetwork } from "../../../apps/server/src/limits.ts";
import { emailFrom, forgetAccount } from "../../../apps/server/src/users.ts";
import { storeUpload } from "../../../apps/server/src/sessions.ts";
import { clearOfTheClock, newOrg, testDb, testDbUrl, tokenFor } from "../../../apps/server/test/helpers.ts";
import { accountsFrom, hostedNotes, hostedProblems } from "../../src/hosted/config.ts";
import { hosting, thisMachine, type HostingSettings } from "../../src/hosted/index.ts";
import { challengeOf, ProviderProblem, type Provider, type ProviderName } from "../../src/hosted/oauth.ts";
import { INVITATIONS_SHOWN, offers, orgIdFor, orgNameFrom, type Accounts } from "../../src/hosted/signup.ts";

let db: Db;
let app: Hono<Env>;

// Stand-ins for Google and GitHub. A test says which addresses go with the
// code a browser comes back with, or that the provider fails; what the
// server asked of the provider is kept to look at. The account is the same
// one for the same main address, unless a test names another.
const vouched = new Map<string, { emails: string[]; account?: string } | Error>();
const asked: { name: ProviderName; code: string; redirectUri: string; verifier: string }[] = [];
function provider(name: ProviderName): Provider {
  return {
    name,
    authorizeUrl: ({ redirectUri, state, challenge }) =>
      `https://${name}.test/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state, challenge })}`,
    async who(answer) {
      asked.push({ name, ...answer });
      const said = vouched.get(answer.code);
      if (!said) throw new ProviderProblem("no such code");
      if (said instanceof Error) throw said;
      return { account: said.account ?? `${name}-account-of-${said.emails[0]?.toLowerCase()}`, emails: said.emails };
    },
  };
}
const hosted: Accounts = {
  providers: [provider("google"), provider("github")],
  publicUrl: "https://app.test",
  trustProxy: true,
};

/** A server that is a hosted service, as the ee server starts one: its accounts are the hosting's. */
function hostedApp(at: Db, accounts: Accounts, options: Omit<Options, "accounts" | "hosting"> = {}, demo?: HostingSettings["demo"]): Hono<Env> {
  return createApp(at, { ...options, hosting: hosting(at, { accounts, demo }) });
}

before(async () => {
  db = await testDb();
  app = hostedApp(db, hosted);
});
after(() => db.close());

// Each call comes from an address of its own unless a test says otherwise,
// so that the limits per address only count where a test means them to.
let caller = 0;
const nextCaller = () => `10.${Math.floor(++caller / 250)}.${caller % 250}.1`;
async function call(
  server: Hono<Env>,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; from?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": options.from ?? nextCaller(),
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  // The sign-in a browser came back with is in its cookie, and nothing it
  // sends says which: `code` in what a test sends is that browser's cookie
  // (as `arrive` returns it), or what a made-up one would hold.
  let body = options.body;
  if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string") {
    const { code, ...rest } = body as { code: string };
    headers.cookie = code.includes("=") ? code : `${ARRIVED}=${code}`;
    body = rest;
  }
  const response = await server.request(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const post = (path: string, body: unknown, token?: string) => call(app, "POST", path, { body, token });
const get = (path: string, token: string) => call(app, "GET", path, { token });

/** The cookie that holds the sign-in of a browser that has come back, and the ones of sign-ins under way. */
const ARRIVED = "__Host-sessionly-arrived";
const LEAVING = "__Host-sessionly-signin-";
/** The cookies a response sets, each as `name=value`, without the ones it takes away. */
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((each) => !/Max-Age=0/i.test(each))
    .map((each) => each.split(";")[0] ?? "");

interface Trip {
  provider?: ProviderName;
  /** They came to create an organisation. */
  create?: boolean;
  /** They came to view the demo (the website's Demo button). */
  demo?: boolean;
  server?: Hono<Env>;
  from?: string;
}

/** Leave for a provider, as a browser would: where it is sent, and the cookie it is given. */
async function leave(trip: Trip = {}) {
  const response = await (trip.server ?? app).request(`/api/v1/auth/${trip.provider ?? "google"}${trip.create ? "?create" : trip.demo ? "?demo" : ""}`, {
    headers: { "x-forwarded-for": trip.from ?? nextCaller() },
  });
  assert.equal(response.status, 302);
  const to = new URL(response.headers.get("location") ?? "");
  return { response, to, state: to.searchParams.get("state") ?? "", cookie: cookiesOf(response).find((each) => each.startsWith(LEAVING)) ?? "" };
}

let codes = 0;
/** Come back from a provider that vouches for `emails` (or fails). Returns where the server sends the browser. */
async function comeBack(
  emails: string[] | Error,
  left: { state: string; cookie: string },
  trip: Trip & { query?: Record<string, string>; account?: string } = {},
) {
  const code = `code-${++codes}`;
  vouched.set(code, emails instanceof Error ? emails : { emails, account: trip.account });
  const query = new URLSearchParams(trip.query ?? { code, state: left.state });
  const response = await (trip.server ?? app).request(`/api/v1/auth/${trip.provider ?? "google"}/callback?${query}`, {
    headers: { cookie: left.cookie, "x-forwarded-for": trip.from ?? nextCaller() },
  });
  assert.equal(response.status, 302);
  return { response, code, to: new URL(response.headers.get("location") ?? "") };
}

/**
 * There and back. Returns what the browser now holds: the cookie with its
 * sign-in. The address it is sent to says only that it has one.
 */
async function arrive(emails: string[], trip: Trip & { account?: string } = {}): Promise<string> {
  const { to, response } = await comeBack(emails, await leave(trip), trip);
  assert.equal(to.href, "https://app.test/#signed-in", `not signed in: ${to.hash}`);
  const cookie = cookiesOf(response).find((each) => each.startsWith(`${ARRIVED}=`));
  assert.ok(cookie, "no sign-in was given to the browser");
  assert.match(cookie, new RegExp(`^${ARRIVED}=[\\w-]{43}\\.${trip.create ? "new" : trip.demo ? "demo" : "in"}$`));
  return cookie;
}

type Session = { token: string; org: { id: string; name: string }; email: string; role: string; expires_at: string; created: boolean };

/** Sign up and return the owner's session. */
async function signUp(email: string, orgName: string, trip: Trip = {}) {
  const code = await arrive([email], { ...trip, create: true });
  const made = await call(trip.server ?? app, "POST", "/auth/verify", { body: { code, org_name: orgName }, from: trip.from });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body as Session;
}

/** Sign in, to the organisation with this id if one is named, or the first that is offered. */
async function signIn(email: string | string[], orgId?: string, trip: Trip = {}) {
  const code = await arrive([email].flat(), trip);
  const offered = (await post("/auth/check", { code })).body.orgs as { user_id: string; org_id: string }[];
  const chosen = offered.find((org) => !orgId || org.org_id === orgId);
  assert.ok(chosen, `${email} cannot sign in to ${orgId ?? "anything"}`);
  const signed = await post("/auth/verify", { code, user_id: chosen.user_id });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  return signed.body as Session;
}

/** Run `fn` with what it logs as errors collected and not shown. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ out: T; errors: string[] }> {
  const errors: string[] = [];
  const error = console.error;
  console.error = (...line: unknown[]) => void errors.push(line.join(" "));
  try {
    return { out: await fn(), errors };
  } finally {
    console.error = error;
  }
}

test("what the server offers depends on how it is set up", async () => {
  assert.deepEqual((await call(app, "GET", "/auth/options")).body, {
    hosted: true,
    noSignIn: false,
    providers: ["google", "github"],
    signup: true,
    inviteCode: false,
    publicUrl: "https://app.test",
  });
  // Without a provider, or without an address for one to send people back to, there are only tokens.
  assert.deepEqual(offers({}), { hosted: true, noSignIn: false, providers: [], signup: false, inviteCode: false, publicUrl: null });
  assert.equal(offers({ publicUrl: "https://app.test" }).publicUrl, null);
  assert.deepEqual(offers({ providers: hosted.providers }).providers, []);
  assert.equal(offers({ ...hosted, signup: "off" }).signup, false);
  const plain = hostedApp(db, {});
  for (const path of ["/auth/google", "/auth/github/callback?code=x&state=y"]) {
    const answer = await plain.request(`/api/v1${path}`);
    assert.deepEqual([answer.status, ((await answer.json()) as any).code], [404, "no_sign_in"], path);
  }
  assert.equal((await call(plain, "POST", "/auth/verify", { body: { code: "x", org_name: "Xy" } })).body.code, "signup_closed");
  // Only what is set up is a way in, and nothing else is one.
  const one = hostedApp(db, { ...hosted, providers: [provider("github")] });
  assert.equal((await one.request("/api/v1/auth/google")).status, 404);
  assert.equal((await leave({ server: one, provider: "github" })).to.host, "github.test");
  // Any other name is no route of these: it is the API's to refuse, as anything without a token.
  assert.equal((await app.request("/api/v1/auth/gitlab")).status, 401);
});

test("a hosted service opens no dashboard without signing in, and takes no such session", async () => {
  const refused = await call(app, "POST", "/auth/open", { body: {} });
  assert.deepEqual([refused.status, refused.body.code], [404, "sign_in"]);
  const opened = await call(createApp(db, {}), "POST", "/auth/open", { body: {} });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal((await call(app, "GET", "/me", { token: opened.body.token })).status, 401);
});

test("the browser that comes back from a provider must be the one that left", async () => {
  const left = await leave();
  // Off to the provider, which is told where to send the browser back and
  // given the hash of a secret, not the secret.
  assert.equal(left.to.origin + left.to.pathname, "https://google.test/authorize");
  assert.equal(left.to.searchParams.get("redirect_uri"), "https://app.test/api/v1/auth/google/callback");
  assert.ok(left.state.length >= 32);
  const [set = "", ...others] = left.response.headers.getSetCookie();
  assert.equal(others.length, 0);
  // The cookie is this sign-in's own, this host's alone, is not shown to scripts, and does not last.
  assert.match(set, /^__Host-sessionly-signin-[0-9a-f]{16}=/);
  for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) assert.ok(set.includes(part), `${part} in ${set}`);
  assert.doesNotMatch(set, /Domain=/i);
  assert.equal(left.response.headers.get("cache-control"), "no-store");

  const back = await comeBack(["kit@loop.example"], left);
  // The address the browser is sent to says that it signed in, and nothing
  // of the sign-in: that is in a cookie like the first.
  assert.equal(back.to.href, "https://app.test/#signed-in");
  const given = back.response.headers.getSetCookie().find((each) => each.startsWith(`${ARRIVED}=`)) ?? "";
  for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) assert.ok(given.includes(part), `${part} in ${given}`);
  assert.doesNotMatch(given, /Domain=/i);
  const secret = /=([\w-]+)\./.exec(given)?.[1] ?? "no secret";
  assert.ok(!back.response.headers.get("location")?.includes(secret));
  // The provider was shown the secret whose hash it was given, and the same address to come back to.
  const question = asked.at(-1);
  assert.deepEqual([question?.name, question?.code, question?.redirectUri], ["google", back.code, "https://app.test/api/v1/auth/google/callback"]);
  assert.equal(challengeOf(question?.verifier ?? ""), left.to.searchParams.get("challenge"));
  // The browser forgets the first cookie on the way back.
  const name = left.cookie.split("=")[0];
  assert.ok(back.response.headers.getSetCookie().some((each) => each.startsWith(`${name}=;`) && /Max-Age=0/.test(each)));
  // And the same way back works once, even for a browser that kept the cookie.
  const questions = asked.length;
  assert.equal((await comeBack(["kit@loop.example"], left)).to.hash, "#problem=not_started");

  // A browser that never left (someone was sent a link to the way back,
  // with a code of the sender's own) is not signed in, and the provider is
  // not asked anything.
  const mine = await leave();
  const strangers = [
    await comeBack(["eve@loop.example"], { state: mine.state, cookie: "" }),
    // Another browser's state.
    await comeBack(["eve@loop.example"], { state: mine.state, cookie: (await leave()).cookie }),
    await comeBack(["eve@loop.example"], { state: "", cookie: mine.cookie }),
    await comeBack(["eve@loop.example"], { state: "made-up", cookie: mine.cookie }),
    // Left for one provider, back from the other.
    await comeBack(["eve@loop.example"], mine, { provider: "github" }),
  ];
  assert.deepEqual(strangers.map((each) => each.to.hash), Array(5).fill("#problem=not_started"));
  assert.equal(asked.length, questions);
  // None of them took anything from the browser: any site can make a
  // browser ask for the way back, and that does not end a sign-in that is
  // under way.
  assert.deepEqual(strangers.flatMap((each) => each.response.headers.getSetCookie()), []);
  assert.equal((await comeBack(["kit@loop.example"], mine)).to.hash, "#signed-in");

  // Two sign-ins begun in one browser, in two tabs, both come back.
  const [one, two] = [await leave(), await leave({ provider: "github" })];
  const both = `${one.cookie}; ${two.cookie}`;
  assert.notEqual(one.cookie.split("=")[0], two.cookie.split("=")[0]);
  assert.equal((await comeBack(["kit@loop.example"], { state: two.state, cookie: both }, { provider: "github" })).to.hash, "#signed-in");
  assert.equal((await comeBack(["kit@loop.example"], { state: one.state, cookie: both })).to.hash, "#signed-in");
  // A browser sent off again and again does not gather cookies without end: past five, the earlier ones go.
  const many: string[] = [];
  for (let i = 0; i < 5; i++) many.push((await leave()).cookie);
  const sixth = await app.request("/api/v1/auth/google", { headers: { cookie: many.join("; "), "x-forwarded-for": nextCaller() } });
  const cleared = sixth.headers.getSetCookie().filter((each) => /Max-Age=0/.test(each)).map((each) => each.split("=")[0]);
  assert.deepEqual(cleared.sort(), many.map((each) => each.split("=")[0]).sort());
  assert.equal(cookiesOf(sixth).length, 1);

  // They said no there.
  const again = await leave();
  const before = asked.length;
  const refused = await comeBack([], again, { query: { error: "access_denied", state: again.state } });
  assert.equal(refused.to.hash, "#problem=refused");
  assert.equal(asked.length, before);
  // The provider sends them back with another error. In its own word it is
  // written for whoever runs the server, and no more of what came with it.
  // A word that means the server is set up wrongly is said as that to the
  // person too: trying again would not help them.
  const sentBack = async (error: string, provider: ProviderName = "github") => {
    const going = await leave({ provider });
    return quietly(() => comeBack([], going, { provider, query: { error, state: going.state, error_description: "secret-looking text" } }));
  };
  const mismatch = await sentBack("redirect_uri_mismatch");
  assert.equal(mismatch.out.to.hash, "#problem=setup");
  assert.deepEqual(mismatch.errors, ['signing in with GitHub: it sent someone back with "redirect_uri_mismatch"']);
  const policy = await sentBack("admin_policy_enforced", "google");
  assert.equal(policy.out.to.hash, "#problem=setup");
  assert.deepEqual(policy.errors, ['signing in with Google: it sent someone back with "admin_policy_enforced"']);
  const down = await sentBack("temporarily_unavailable", "google");
  assert.equal(down.out.to.hash, "#problem=provider");
  assert.deepEqual(down.errors, ['signing in with Google: it sent someone back with "temporarily_unavailable"']);
  const odd = await sentBack("<script>alert(1)</script> client_secret=abc");
  assert.equal(odd.out.to.hash, "#problem=provider");
  assert.deepEqual(odd.errors, ["signing in with GitHub: it sent someone back with an error it did not name plainly"]);
  assert.equal(asked.length, before);
  // The provider fails when asked who this is: said to whoever runs the
  // server, and to the person only that it did not work, or that it is not
  // set up right.
  const failing = await leave({ provider: "github" });
  const { out: failed, errors } = await quietly(() =>
    comeBack(new ProviderProblem("GitHub's token endpoint answered 503"), failing, { provider: "github" }),
  );
  assert.equal(failed.to.hash, "#problem=provider");
  assert.deepEqual(errors, ["signing in with GitHub failed: GitHub's token endpoint answered 503"]);
  const wrong = await leave();
  const unknown = await quietly(() =>
    comeBack(new ProviderProblem("Google's token endpoint answered 401 (invalid_client)", "invalid_client"), wrong),
  );
  assert.equal(unknown.out.to.hash, "#problem=setup");
  assert.deepEqual(unknown.errors, ["signing in with Google failed: Google's token endpoint answered 401 (invalid_client)"]);
  const empty = await leave();
  assert.equal((await comeBack([], empty, { query: { state: empty.state } })).to.hash, "#problem=provider");
  // It vouches for no address, or for nothing that is one.
  assert.equal((await comeBack([], await leave())).to.hash, "#problem=no_address");
  assert.equal((await comeBack(["not an address", "x@localhost"], await leave())).to.hash, "#problem=no_address");
  // Nothing was kept for any of them.
  assert.equal((await db.query(`SELECT 1 FROM sign_in_codes WHERE emails @> ARRAY['eve@loop.example']`)).length, 0);

  // Addresses are kept in their one plain form, each once, the main one first.
  const code = await arrive(["Kit@Loop.Example", "kit@loop.example", "nonsense", "kit@other.example"]);
  assert.deepEqual((await post("/auth/check", { code })).body.emails, ["kit@loop.example", "kit@other.example"]);

  // Without HTTPS (a server tried on one's own machine) the cookies cannot have the name browsers guard.
  const local = hostedApp(db, { ...hosted, publicUrl: "http://localhost:8080" });
  const plainly = await local.request("/api/v1/auth/google", { headers: { "x-forwarded-for": nextCaller() } });
  const [crumb = ""] = plainly.headers.getSetCookie();
  assert.match(crumb, /^sessionly-signin-[0-9a-f]{16}=/);
  assert.doesNotMatch(crumb, /Secure/);
  const to = new URL(plainly.headers.get("location") ?? "");
  assert.equal(to.searchParams.get("redirect_uri"), "http://localhost:8080/api/v1/auth/google/callback");
  const home = await comeBack(["kit@loop.example"], { state: to.searchParams.get("state") ?? "", cookie: crumb.split(";")[0] ?? "" }, { server: local });
  assert.equal(home.to.href, "http://localhost:8080/#signed-in");
  assert.ok(home.response.headers.getSetCookie().some((each) => /^sessionly-arrived=[\w-]+\.in; /.test(each) && !/Secure/.test(each)));
});

test("a sign-in is only the browser's that came back: one from anywhere else is nobody's", async () => {
  const eve = await signUp("eve@attack.example", "Attack");
  const victim = await signUp("vic@target.example", "Target");
  // Eve signs in and stops at the page that asks where to. Whatever of that
  // she can pass on (the address she is at, or the secret itself, had she a
  // way to read it) does nothing in anyone else's browser.
  const hers = await arrive(["eve@attack.example"]);
  const secret = /=([\w-]+)\./.exec(hers)?.[1] ?? "";
  const mine = (await post("/auth/check", { code: hers })).body.orgs[0].user_id;
  const raw = async (path: string, body: unknown, cookie?: string) => {
    const response = await app.request(`/api/v1/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": nextCaller(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any, set: response.headers.getSetCookie() };
  };
  // A browser with no sign-in of its own, sent the secret every way a request can carry one.
  for (const body of [{ code: secret }, { code: `${secret}.in` }, { code: hers }, { code: secret, user_id: mine }, {}]) {
    assert.deepEqual([(await raw("check", body)).body.code, (await raw("verify", { ...body, user_id: mine })).body.code], ["invalid_code", "invalid_code"]);
  }
  assert.equal((await raw("verify", { code: secret, org_name: "Planted" })).body.code, "invalid_code");
  // A browser with a sign-in of its own is asked about its own, whatever it sends.
  const theirs = await arrive(["vic@target.example"]);
  const seen = await raw("check", { code: secret }, theirs);
  assert.deepEqual([seen.body.emails, seen.body.orgs.map((org: any) => org.org_id)], [["vic@target.example"], [victim.org.id]]);
  assert.equal((await raw("verify", { code: secret, user_id: mine }, theirs)).body.code, "invalid_code");
  // Nobody was signed in to Eve's organisation by any of it, and her own sign-in is as it was.
  const sessions = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM tokens WHERE org_id = $1 AND sign_in IS NOT NULL`, [eve.org.id]);
  assert.equal(Number(sessions[0]?.n), 1);
  assert.equal((await raw("check", {}, hers)).status, 200);

  // "Not now" ends it: on the server, and in the browser.
  const stopped = await raw("cancel", {}, hers);
  assert.deepEqual([stopped.status, stopped.body], [200, { ok: true }]);
  assert.ok(stopped.set.some((each) => each.startsWith(`${ARRIVED}=;`) && /Max-Age=0/.test(each)));
  assert.equal((await raw("check", {}, hers)).body.code, "invalid_code");
  assert.equal((await db.query(`SELECT 1 FROM sign_in_codes WHERE emails @> ARRAY['eve@attack.example']`)).length, 0);
  // Asking for a place that is not theirs used the other browser's sign-in up.
  assert.equal((await raw("check", {}, theirs)).body.code, "invalid_code");
  // With nothing to end, "Not now" ends nothing: a sign-in named in what is sent is not this browser's.
  const anew = await arrive(["vic@target.example"]);
  assert.equal((await raw("cancel", {})).status, 200);
  assert.equal((await raw("cancel", { code: /=([\w-]+)\./.exec(anew)?.[1] })).status, 200);
  assert.equal((await raw("check", {}, anew)).status, 200);

  // Signing in uses it, once, and it is then gone from the browser too.
  const used = await raw("verify", { user_id: seen.body.orgs[0].user_id }, anew);
  assert.equal(used.status, 200);
  assert.ok(used.set.some((each) => each.startsWith(`${ARRIVED}=;`) && /Max-Age=0/.test(each)));
  // A browser that comes back a second time without having gone on leaves nothing of the first.
  const first = await arrive(["vic@target.example"]);
  const going = await leave();
  await comeBack(["vic@target.example"], { state: going.state, cookie: `${going.cookie}; ${first}` });
  assert.equal((await raw("check", {}, first)).body.code, "invalid_code");
  assert.equal((await db.query(`SELECT 1 FROM sign_in_codes WHERE emails @> ARRAY['vic@target.example']`)).length, 1);
});

test("an organisation is signed in to with the account that signed in to it first", async () => {
  const owner = await signUp("olga@firm.example", "Firm");
  await post("/users", { email: "alice@firm.example", role: "admin" }, owner.token);
  // Alice signs in with her Google account, which is from then on who alice@firm.example is here.
  const alice = await arrive(["alice@firm.example"], { account: "google-alice" });
  const [place] = (await post("/auth/check", { code: alice })).body.orgs;
  assert.deepEqual([place.first_time, place.other_account], [true, null]);
  assert.equal((await post("/auth/verify", { code: alice, user_id: place.user_id })).status, 200);
  assert.deepEqual(
    await db.query(`SELECT sign_in_provider, sign_in_account FROM users WHERE id = $1`, [place.user_id]),
    [{ sign_in_provider: "google", sign_in_account: "google-alice" }],
  );
  // The same account again: as before, and it would go straight in.
  const again = await arrive(["alice@firm.example"], { account: "google-alice" });
  assert.deepEqual((await post("/auth/check", { code: again })).body.orgs.map((org: any) => [org.first_time, org.other_account]), [[false, null]]);
  assert.equal((await post("/auth/verify", { code: again, user_id: place.user_id })).status, 200);

  // Alice leaves the firm and the mailbox goes to someone else, who makes a
  // Google account with it; or she keeps the address on a GitHub account of
  // her own. Either provider still vouches for the address. Neither account
  // is the one that signed in here, and neither gets in.
  for (const [provider, account] of [["google", "google-newcomer"], ["github", "github-alice"]] as const) {
    const other = await arrive(["alice@firm.example"], { provider, account });
    const shown = (await post("/auth/check", { code: other })).body.orgs;
    assert.deepEqual(shown.map((org: any) => [org.org_id, org.first_time, org.other_account]), [[owner.org.id, false, "google"]]);
    const refused = await post("/auth/verify", { code: other, user_id: place.user_id });
    assert.deepEqual([refused.status, refused.body.code], [403, "other_account"]);
    assert.match(refused.body.error, /another Google account/);
    // The refusal did not use the sign-in up: it can still go somewhere else.
    assert.equal((await post("/auth/check", { code: other })).status, 200);
  }
  // Two accounts at the same moment, for someone who has not signed in yet: one is who they are.
  await post("/users", { email: "race@firm.example" }, owner.token);
  const [a, b] = [await arrive(["race@firm.example"], { account: "one" }), await arrive(["race@firm.example"], { account: "two" })];
  const racer = (await post("/auth/check", { code: a })).body.orgs[0].user_id;
  const two = await Promise.all([post("/auth/verify", { code: a, user_id: racer }), post("/auth/verify", { code: b, user_id: racer })]);
  assert.deepEqual(two.map((each) => each.status).sort(), [200, 403]);

  // An admin lets her in with another account by removing her and adding
  // her again: she is asked as someone new, and that account is then hers.
  assert.equal((await call(app, "DELETE", `/users/${place.user_id}`, { token: owner.token })).status, 200);
  await post("/users", { email: "alice@firm.example" }, owner.token);
  const back = await arrive(["alice@firm.example"], { provider: "github", account: "github-alice" });
  assert.deepEqual((await post("/auth/check", { code: back })).body.orgs.map((org: any) => [org.first_time, org.other_account]), [[true, null]]);
  assert.equal((await post("/auth/verify", { code: back, user_id: place.user_id })).status, 200);
  const old = await arrive(["alice@firm.example"], { account: "google-alice" });
  assert.equal((await post("/auth/verify", { code: old, user_id: place.user_id })).body.code, "other_account");
  // The owner is known by the account they made the organisation with.
  const [made] = await db.query<{ sign_in_account: string }>(`SELECT sign_in_account FROM users WHERE org_id = $1 AND role = 'owner'`, [owner.org.id]);
  assert.equal(made?.sign_in_account, "google-account-of-olga@firm.example");
  const impostor = await arrive(["olga@firm.example"], { account: "not-olga" });
  const ownerRow = (await post("/auth/check", { code: impostor })).body.orgs[0];
  assert.equal((await post("/auth/verify", { code: impostor, user_id: ownerRow.user_id })).body.code, "other_account");
});

test("one person owns only so many organisations, by address and by account", async () => {
  await clearOfTheClock(db);
  // Nineteen already, made over time: as many as the hourly counts would let through in a day.
  const seed = async (email: string, account: string, n: number, tag: string) => {
    for (let i = 0; i < n; i++) {
      await db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'Pile')`, [`pile-${tag}-${i}`]);
      await db.query(
        `INSERT INTO users (id, org_id, email, role, confirmed_at, sign_in_provider, sign_in_account)
         VALUES ($1, $2, $3, 'owner', now(), 'google', $4)`,
        [`usr_pile${tag}${i}`, `pile-${tag}-${i}`, email, account],
      );
    }
  };
  await seed("hoard@pile.example", "hoarder", 19, "a");
  const create = async (email: string, account: string, name: string) => {
    const code = await arrive([email], { create: true, account });
    return { code, made: await post("/auth/verify", { code, org_name: name }) };
  };
  assert.equal((await create("hoard@pile.example", "hoarder", "Twentieth")).made.status, 200);
  const over = await create("hoard@pile.example", "hoarder", "One too many");
  assert.deepEqual([over.made.status, over.made.body.code], [409, "too_many_orgs"]);
  // Nothing was made, what was counted for it was given back, and the sign-in can still be used.
  assert.equal((await db.query(`SELECT 1 FROM orgs WHERE name = 'One too many'`)).length, 0);
  const [counted] = await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = 'signup:hoard@pile.example'`);
  assert.equal(counted?.n, 1);
  assert.equal((await post("/auth/check", { code: over.code })).body.orgs.length, 20);
  // The same account under another of its addresses, and the same address under another account.
  assert.equal((await create("second@pile.example", "hoarder", "By account")).made.body.code, "too_many_orgs");
  assert.equal((await create("hoard@pile.example", "someone-else", "By address")).made.body.code, "too_many_orgs");
  // An organisation that is being deleted is not one of them.
  await db.query(`UPDATE orgs SET deleted_at = now() WHERE id = 'pile-a-0'`);
  assert.equal((await create("second@pile.example", "hoarder", "Room again")).made.status, 200);
});

test("signing up creates an organisation once it is named, and not before", async () => {
  const orgs = async () => Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`))[0]?.n);
  const before = await orgs();
  const code = await arrive(["Kay@Acme.example"], { create: true });
  assert.equal(await orgs(), before);
  // Who the provider said this is can be asked without using the code.
  assert.deepEqual((await post("/auth/check", { code })).body, {
    provider: "google",
    emails: ["kay@acme.example"],
    create: true,
    orgs: [],
    more: 0,
  });
  // A name is letters, digits and a little punctuation: nothing that could
  // be a link or an address where it is shown. A name that will not do
  // does not use the code up.
  for (const name of ["", "x", "x".repeat(81), "visit evil.tld", "a/b", "see http://x", "me@there", "<b>bold</b>"]) {
    const refused = await post("/auth/verify", { code, org_name: name });
    assert.deepEqual([refused.status, refused.body.code], [400, "bad_org_name"], JSON.stringify(name));
  }
  assert.equal(await orgs(), before);

  const first = await post("/auth/verify", { code, org_name: "  Acme,   Inc " });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.org.id, /^acme-inc-[a-z0-9]{6}$/);
  assert.equal(first.body.org.name, "Acme, Inc");
  assert.deepEqual([first.body.email, first.body.role, first.body.created], ["kay@acme.example", "admin", true]);
  assert.equal(await orgs(), before + 1);
  // About a week.
  const days = (Date.parse(first.body.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, String(days));

  const me = await get("/me", first.body.token);
  assert.deepEqual(
    [me.body.org, me.body.org_name, me.body.email, me.body.role, me.body.signed_in],
    [first.body.org.id, "Acme, Inc", "kay@acme.example", "admin", true],
  );
  // The new organisation is empty, and its owner is its one person.
  assert.equal((await get("/sessions", first.body.token)).body.total, 0);
  assert.deepEqual((await get("/users", first.body.token)).body.users.map((u: any) => [u.email, u.role]), [
    ["kay@acme.example", "owner"],
  ]);
  // The session says how it was made.
  const [kept] = await db.query<{ sign_in: string }>(`SELECT sign_in FROM tokens WHERE org_id = $1`, [first.body.org.id]);
  assert.equal(kept?.sign_in, "google");

  // The code worked once.
  const again = await post("/auth/verify", { code, org_name: "Acme Two" });
  assert.deepEqual([again.status, again.body.code], [400, "invalid_code"]);
  assert.equal((await post("/auth/check", { code })).body.code, "invalid_code");
  assert.equal(await orgs(), before + 1);
  for (const bad of ["", "nonsense", "x".repeat(300), 7]) {
    assert.equal((await post("/auth/verify", { code: bad, org_name: "Fine Name" })).body.code, "invalid_code");
    assert.equal((await post("/auth/verify", { code: bad, user_id: "usr_x" })).body.code, "invalid_code");
    assert.equal((await post("/auth/check", { code: bad })).body.code, "invalid_code");
  }
  // Neither where to sign in nor what to create: nothing is used up.
  const other = await arrive(["kay@acme.example"]);
  assert.equal((await post("/auth/verify", { code: other })).status, 400);
  assert.equal((await post("/auth/check", { code: other })).status, 200);
  for (const name of ["Ab", "Müller & Söhne", "O'Neil (EU) 2", "R+D, Berlin"]) {
    assert.equal((await signUp(`${orgIdFor(name)}@names.example`, name)).org.name, name);
  }
  // With GitHub, the owner is the account's main address.
  const hub = await arrive(["main@hub.example", "second@hub.example"], { provider: "github", create: true });
  const made = await post("/auth/verify", { code: hub, org_name: "Hub" });
  assert.deepEqual([made.body.email, made.body.created], ["main@hub.example", true]);
});

test("two uses of one code at the same moment: one works", async () => {
  await clearOfTheClock(db);
  const code = await arrive(["twice@race.example"], { create: true });
  const both = await Promise.all([post("/auth/verify", { code, org_name: "Race" }), post("/auth/verify", { code, org_name: "Race" })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  const [made] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs WHERE name = 'Race'`);
  assert.equal(Number(made?.n), 1);
  // What the one that lost was counted for is given back.
  const [counted] = await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = 'signup:twice@race.example'`);
  assert.equal(Number(counted?.n), 1);
});

test("a code that has run out does nothing", async () => {
  const code = await arrive(["late@slow.example"], { create: true });
  await db.query(`UPDATE sign_in_codes SET expires_at = now() - interval '1 second' WHERE emails = ARRAY['late@slow.example']`);
  assert.equal((await post("/auth/verify", { code, org_name: "Slow" })).body.code, "invalid_code");
  assert.equal((await post("/auth/check", { code })).body.code, "invalid_code");
  const [made] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs WHERE name = 'Slow'`);
  assert.equal(Number(made?.n), 0);
  // Only the hash of a code is kept, and for ten minutes.
  const stored = await db.query<{ code_hash: string; minutes: number }>(
    `SELECT code_hash, extract(epoch FROM expires_at - now()) / 60 AS minutes FROM sign_in_codes`,
  );
  assert.ok(stored.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash) && row.code_hash !== code && Number(row.minutes) <= 10));
  // A sign-in that came back is noted until it could no longer come back again.
  const noted = async () => Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM sign_in_states`))[0]?.n);
  assert.ok((await noted()) > 0);
  await db.query(`UPDATE sign_in_states SET expires_at = now() - interval '1 second'`);
  await tidy(db);
  assert.equal((await db.query(`SELECT 1 FROM sign_in_codes WHERE emails = ARRAY['late@slow.example']`)).length, 0);
  assert.equal(await noted(), 0);
});

test("signing in shows where one can sign in, and takes one there", async () => {
  const owner = await signUp("pat@solo.example", "Solo");
  const code = await arrive(["pat@solo.example"]);
  const what = await post("/auth/check", { code });
  const [only] = what.body.orgs;
  assert.deepEqual(what.body.orgs, [
    {
      user_id: only.user_id,
      org_id: owner.org.id,
      org_name: "Solo",
      email: "pat@solo.example",
      first_time: false,
      invited_by: null,
      invited_via: null,
      other_account: null,
    },
  ]);
  const signed = await post("/auth/verify", { code, user_id: only.user_id });
  assert.deepEqual([signed.status, signed.body.org.id, signed.body.role, signed.body.created], [200, owner.org.id, "admin", false]);
  assert.notEqual(signed.body.token, owner.token);
  assert.equal((await get("/me", signed.body.token)).body.email, "pat@solo.example");
  // Once.
  assert.equal((await post("/auth/verify", { code, user_id: only.user_id })).body.code, "invalid_code");

  // Someone nobody has added can sign in nowhere, and not by naming someone else.
  const stranger = await arrive(["nobody@solo.example"]);
  assert.deepEqual((await post("/auth/check", { code: stranger })).body.orgs, []);
  assert.equal((await post("/auth/verify", { code: stranger, user_id: only.user_id })).body.code, "invalid_code");
  // Signing out ends the session on the server.
  assert.equal((await call(app, "DELETE", "/auth/session", { token: signed.body.token })).status, 200);
  assert.equal((await get("/me", signed.body.token)).status, 401);
  assert.equal((await get("/me", owner.token)).status, 200);
});

test("one address in two organisations chooses between them, each time", async () => {
  const first = await signUp("dana@both.example", "First");
  const second = await signUp("dana@both.example", "Second");
  const code = await arrive(["dana@both.example"]);
  const offered = (await post("/auth/check", { code })).body.orgs;
  assert.deepEqual(offered.map((org: any) => org.org_id), [first.org.id, second.org.id]);
  const one = await post("/auth/verify", { code, user_id: offered[1].user_id });
  assert.equal(one.body.org.id, second.org.id);
  // The code is used: the other organisation takes signing in again.
  assert.equal((await post("/auth/verify", { code, user_id: offered[0].user_id })).body.code, "invalid_code");
  assert.equal((await signIn("dana@both.example", first.org.id)).org.id, first.org.id);
});

test("every address GitHub vouches for is a way in, and no other", async () => {
  const owner = await signUp("lee@corp.example", "Corp");
  await post("/users", { email: "gus@corp.example" }, owner.token);
  const elsewhere = await signUp("gus@home.example", "Home");
  // Gus's GitHub account is under his own address; his work address is its second.
  const code = await arrive(["gus@home.example", "gus@corp.example"], { provider: "github" });
  const offered = (await post("/auth/check", { code })).body;
  assert.equal(offered.provider, "github");
  assert.deepEqual(
    offered.orgs.map((org: any) => [org.org_id, org.email, org.first_time]),
    [
      [elsewhere.org.id, "gus@home.example", false],
      [owner.org.id, "gus@corp.example", true],
    ],
  );
  const signed = await post("/auth/verify", { code, user_id: offered.orgs[1].user_id });
  // In each organisation he is who he was added as.
  assert.deepEqual([signed.body.org.id, signed.body.email, signed.body.role], [owner.org.id, "gus@corp.example", "member"]);
  const [kept] = await db.query<{ sign_in: string }>(`SELECT sign_in FROM tokens WHERE org_id = $1 AND email = 'gus@corp.example'`, [owner.org.id]);
  assert.equal(kept?.sign_in, "github");
  // Lee's place is not Gus's, whatever he asks for.
  const people = (await get("/users", owner.token)).body.users;
  const lee = people.find((u: any) => u.email === "lee@corp.example").id;
  const sly = await arrive(["gus@home.example", "gus@corp.example"], { provider: "github" });
  assert.equal((await post("/auth/verify", { code: sly, user_id: lee })).body.code, "invalid_code");
});

test("who added someone is shown only if that is known, not on a token's word", async () => {
  const owner = await signUp("omar@host.example", "Host");
  // Added by a person who signed in: their address is their own, and is shown.
  await post("/users", { email: "new@guest.example" }, owner.token);
  const shown = async (email: string) => {
    const offered = (await post("/auth/check", { code: await arrive([email]) })).body.orgs;
    return offered.map((org: any) => [org.org_name, org.first_time, org.invited_by, org.invited_via]);
  };
  assert.deepEqual(await shown("new@guest.example"), [["Host", true, "omar@host.example", "sign_in"]]);
  // Added with a token, whose address is whatever its maker typed: only that much is said.
  const made = await post("/tokens", { email: "ceo@bigbank.example", role: "admin" }, owner.token);
  await post("/users", { email: "other@guest.example" }, made.body.token);
  assert.deepEqual(await shown("other@guest.example"), [["Host", true, null, "token"]]);
  // Once they have signed in to it, it is an organisation they know.
  await signIn("new@guest.example");
  assert.deepEqual(await shown("new@guest.example"), [["Host", false, null, null]]);
});

test("being added to other people's organisations hides neither one's own nor the one just added", async () => {
  const own = await signUp("vera@mine.example", "Mine");
  // Twelve organisations, each made before hers, that added her address
  // ahead of time: what someone would do to bury a real invitation.
  const crowd = async (from: number, to: number, when: string) => {
    for (let i = from; i < to; i++) {
      await db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'Mine')`, [`crowd-${i}`]);
      await db.query(
        `INSERT INTO users (id, org_id, email, role, invited_via, created_at)
         VALUES ($1, $2, 'vera@mine.example', 'member', 'token', now() + $3::interval)`,
        [`usr_crowd${i}`, `crowd-${i}`, when],
      );
    }
  };
  await crowd(0, 12, "-1 day");
  // Then the real one, by a person who signed in.
  const corp = await signUp("hr@corp.example", "Corp");
  await post("/users", { email: "vera@mine.example" }, corp.token);
  const browser = await arrive(["vera@mine.example"]);
  const first = (await post("/auth/check", { code: browser })).body;
  // Hers first; then the ones she was added to, the newest first, ten at a
  // time: the real one leads them, and the rest can be asked for.
  assert.deepEqual(first.orgs.map((org: any) => org.org_id).slice(0, 2), [own.org.id, corp.org.id]);
  assert.deepEqual([first.orgs[0].first_time, first.orgs[1].first_time, first.orgs[1].invited_by], [false, true, "hr@corp.example"]);
  assert.equal(first.orgs.length, 1 + INVITATIONS_SHOWN);
  assert.equal(first.more, 3);
  const rest = (await post("/auth/check", { code: browser, shown: INVITATIONS_SHOWN })).body;
  assert.deepEqual([rest.orgs.length, rest.more], [3, 0]);
  assert.ok(rest.orgs.every((org: any) => org.first_time && org.org_id.startsWith("crowd-")));
  assert.deepEqual((await post("/auth/check", { code: browser, shown: 13 })).body.orgs, []);
  for (const shown of [-1, 1.5, "ten", 1e9]) assert.equal((await post("/auth/check", { code: browser, shown })).status, 400, String(shown));

  // Fakes added after the real one push it down the list, not out of it.
  await crowd(12, 27, "1 hour");
  const seen: string[] = [];
  let more = 1;
  for (let shown = 0; more > 0; shown += INVITATIONS_SHOWN) {
    const page = (await post("/auth/check", { code: browser, shown })).body;
    seen.push(...page.orgs.filter((org: any) => org.first_time).map((org: any) => org.org_id));
    more = page.more;
  }
  assert.equal(seen.length, 28);
  assert.equal(new Set(seen).size, 28);
  assert.equal(seen.indexOf(corp.org.id), 15);
  // And she can sign in to it from wherever in the list it is.
  const there = (await post("/auth/check", { code: browser, shown: 10 })).body.orgs.find((org: any) => org.org_id === corp.org.id);
  assert.equal((await post("/auth/verify", { code: browser, user_id: there.user_id })).body.org.id, corp.org.id);

  // An organisation that is being deleted, or that removed her, is not offered.
  await db.query(`UPDATE orgs SET deleted_at = now() WHERE id LIKE 'crowd-%' AND id <> 'crowd-3'`);
  await db.query(`UPDATE users SET removed_at = now() WHERE id = 'usr_crowd3'`);
  const left = (await post("/auth/check", { code: await arrive(["vera@mine.example"]) })).body;
  assert.deepEqual([left.orgs.map((org: any) => org.org_id), left.more], [[own.org.id, corp.org.id], 0]);
});

test("an owner whose account is gone is let in with another: by an admin, or by whoever runs the server", async () => {
  const owner = await signUp("ona@lost.example", "Lost");
  const ownerId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE org_id = $1 AND role = 'owner'`, [owner.org.id]))[0]?.id ?? "";
  const machine = await post("/me/tokens", { name: "laptop" }, owner.token);
  assert.equal(machine.status, 201);
  const people = async (token: string) =>
    Object.fromEntries((await get("/users", token)).body.users.map((u: any) => [u.email, u.signed_in_with]));
  // Her Google account is deleted and made again: the same address, another account.
  const again = await arrive(["ona@lost.example"], { account: "ona-made-again" });
  const refused = await post("/auth/verify", { code: again, user_id: ownerId });
  assert.deepEqual([refused.status, refused.body.code], [403, "other_account"]);
  // What she is told is true of an owner, who cannot be removed and added again.
  assert.match(refused.body.error, /another admin of the organisation can let you in .* whoever runs this server can/);
  assert.doesNotMatch(refused.body.error, /remove/);
  // Nobody does it for themselves, and a member does it for nobody.
  const self = await post(`/users/${ownerId}/forget-account`, {}, owner.token);
  assert.deepEqual([self.status, self.body.code], [409, "not_yourself"]);
  // Nor is it done for an owner with a token, which says nothing of who holds it.
  const unsigned = (await post("/tokens", { email: "ops@lost.example", role: "admin" }, owner.token)).body.token;
  const byToken = await post(`/users/${ownerId}/forget-account`, {}, unsigned);
  assert.deepEqual([byToken.status, byToken.body.code], [403, "sign_in_needed"]);
  assert.equal((await get("/me", owner.token)).status, 200);
  await post("/users", { email: "adam@lost.example", role: "admin" }, owner.token);
  await post("/users", { email: "mel@lost.example", role: "member" }, owner.token);
  const adam = await signIn("adam@lost.example", owner.org.id);
  const mel = await signIn("mel@lost.example", owner.org.id);
  assert.equal((await post(`/users/${ownerId}/forget-account`, {}, mel.token)).status, 403);
  assert.deepEqual(await people(adam.token), { "ona@lost.example": "google", "adam@lost.example": "google", "mel@lost.example": "google" });

  // With a token it is done for someone who is not the owner.
  const melId = (await get("/users", adam.token)).body.users.find((u: any) => u.email === "mel@lost.example").id;
  assert.equal((await post(`/users/${melId}/forget-account`, {}, unsigned)).status, 200);
  assert.equal((await get("/me", mel.token)).status, 401);
  // Another admin, signed in, lets the owner in anew, and it is written
  // down who did. Her sessions end; her machine's token does not.
  const logged: string[] = [];
  const log = console.log;
  console.log = (line: string) => void logged.push(line);
  const forgotten = await post(`/users/${ownerId}/forget-account`, {}, adam.token).finally(() => (console.log = log));
  assert.deepEqual(logged, [
    `"${owner.org.id}": the account of ona@lost.example (owner) was forgotten by adam@lost.example, signed in; whoever signs in under that address next is that person`,
  ]);
  assert.deepEqual([forgotten.status, forgotten.body.email, forgotten.body.role, forgotten.body.signed_in_with], [200, "ona@lost.example", "owner", null]);
  assert.equal((await get("/me", owner.token)).status, 401);
  assert.equal((await get("/ping", machine.body.token)).status, 200);
  assert.equal((await people(adam.token))["ona@lost.example"], null);
  // She is asked, as someone let in anew and told by whom, and the account she comes with is hers from then on.
  const anew = await arrive(["ona@lost.example"], { account: "ona-made-again" });
  const [place] = (await post("/auth/check", { code: anew })).body.orgs;
  assert.deepEqual([place.first_time, place.other_account, place.invited_by], [true, null, "adam@lost.example"]);
  const back = await post("/auth/verify", { code: anew, user_id: ownerId });
  assert.deepEqual([back.status, back.body.role, back.body.org.id], [200, "admin", owner.org.id]);
  const old = await arrive(["ona@lost.example"], { account: "google-account-of-ona@lost.example" });
  assert.equal((await post("/auth/verify", { code: old, user_id: ownerId })).body.code, "other_account");
  // Someone of another organisation is not there to be let in.
  const elsewhere = await signUp("eli@elsewhere.example", "Elsewhere");
  assert.equal((await post(`/users/${ownerId}/forget-account`, {}, elsewhere.token)).status, 404);
  assert.equal((await post(`/users/usr_nobody/forget-account`, {}, adam.token)).status, 404);

  // An owner who is the only admin there is: whoever runs the server does it, from the command line.
  const solo = await signUp("sol@alone.example", "Alone");
  const lost = await arrive(["sol@alone.example"], { account: "sol-new" });
  const soloId = (await post("/auth/check", { code: lost })).body.orgs[0].user_id;
  assert.equal((await post("/auth/verify", { code: lost, user_id: soloId })).body.code, "other_account");
  const done = await db.asOrg(solo.org.id, (scoped) => forgetAccount(scoped, { email: " Sol@Alone.example " }, null));
  assert.deepEqual([done.email, done.signed_in_with], ["sol@alone.example", null]);
  const next = await arrive(["sol@alone.example"], { account: "sol-new" });
  const [shown] = (await post("/auth/check", { code: next })).body.orgs;
  assert.deepEqual([shown.first_time, shown.invited_by, shown.invited_via], [true, null, null]);
  assert.equal((await post("/auth/verify", { code: next, user_id: soloId })).status, 200);
  await assert.rejects(
    db.asOrg(solo.org.id, (scoped) => forgetAccount(scoped, { email: "nobody@alone.example" }, null)),
    /no such person/,
  );
});

test("a server tried under one of this machine's names is found under the public one, and a proxy's name for it changes nothing", async () => {
  const web = () => mkdtempSync(join(tmpdir(), "sessionly-web-"));
  const at = (publicUrl: string) => hostedApp(db, { ...hosted, publicUrl }, { webRoot: web() });
  const ask = (server: Hono<Env>, path: string, host: string | undefined, method = "GET") =>
    server.request(path, { method, headers: { ...(host ? { host } : {}), "x-forwarded-for": nextCaller() } });
  const moved = async (server: Hono<Env>, path: string, host: string | undefined) => {
    const answer = await ask(server, path, host);
    return answer.status === 307 ? answer.headers.get("location") : null;
  };
  // Under another name for the same machine the cookie of a sign-in would
  // be kept for that name, and not shown at the one the provider sends
  // people back to. So the browser is sent to the public one, to the same page.
  const local = at("http://localhost:8080");
  for (const [path, host] of [
    ["/", "127.0.0.1:8080"],
    ["/?x=1", "[::1]:8080"],
    ["/assets/app.js", "127.0.0.1:8080"],
    ["/api/v1/auth/google", "127.0.0.1:8080"],
    ["/api/v1/auth/github?create", "[::1]:8080"],
  ] as const) {
    assert.equal(await moved(local, path, host), `http://localhost:8080${path}`, `${host}${path}`);
    assert.deepEqual((await ask(local, path, host)).headers.getSetCookie(), [], `${host}${path}`);
  }
  assert.equal(await moved(at("http://127.0.0.1:8080"), "/", "localhost:8080"), "http://127.0.0.1:8080/");
  assert.equal(await moved(at("http://localhost"), "/", "127.0.0.1"), "http://localhost/");
  // At the public address itself, however the host is written, nothing is moved.
  for (const host of ["localhost:8080", "LOCALHOST:8080", undefined]) {
    assert.equal((await ask(local, "/api/v1/auth/google", host)).headers.get("location")?.startsWith("https://google.test/"), true, String(host));
  }

  // Behind a proxy, Host is often the proxy's own name for this server and
  // not what the browser asked for. Sent to the public address for that,
  // the browser would be handed straight back here, without end. So
  // nothing is moved for a host that is not one of this machine's names,
  // or when the public address is not one...
  const proxied = at("https://app.example.com");
  for (const host of ["127.0.0.1:8080", "localhost:8080", "server-1:8080", "sessionly_backend", "10.0.0.7:8080", "app.example.com"]) {
    for (const path of ["/", "/api/v1/auth/google"]) assert.equal(await moved(proxied, path, host), null, `${host}${path}`);
  }
  for (const host of ["my-laptop.local:8080", "10.0.0.7:8080", "localhost.example.com:8080", "sessionly:8080"]) {
    assert.equal(await moved(local, "/", host), null, host);
  }
  // ...and not for one of this machine's names on another port: that is a
  // proxy on this machine, which listens on one port and passes on to another.
  assert.equal(await moved(at("http://localhost"), "/", "127.0.0.1:8080"), null);
  assert.equal(await moved(at("http://localhost:8080"), "/", "127.0.0.1:3000"), null);
  assert.equal(await moved(at("https://localhost"), "/", "127.0.0.1:8080"), null);
  // Followed as a browser would, through a proxy that names the server its
  // own way, the dashboard is answered at once: there is nothing to follow.
  const page = await ask(at("http://localhost"), "/", "127.0.0.1:8080");
  assert.notEqual(page.status, 307);
  assert.equal(thisMachine("LocalHost:8080", "http:")?.name, "localhost");
  assert.deepEqual(thisMachine("[::1]", "https:"), { name: "[::1]", port: "443" });
  assert.deepEqual([thisMachine("localhost.evil.example", "http:"), thisMachine("127.0.0.10", "http:"), thisMachine("", "http:")], [null, null, null]);

  // The API is answered wherever it is asked, as is whatever keeps the server running.
  assert.equal((await ask(local, "/readyz", "127.0.0.1:8080")).status, 200);
  assert.equal((await ask(local, "/healthz", "127.0.0.1:8080")).status, 200);
  assert.equal((await ask(local, "/api/v1/auth/options", "127.0.0.1:8080")).status, 200);
  assert.equal((await ask(local, "/api/v1/ping", "127.0.0.1:8080")).status, 401);
  assert.equal((await ask(local, "/api/v1/auth/check", "127.0.0.1:8080", "POST")).status, 415);
  // A provider sends people back to the public address only, so the way back is not moved either.
  assert.equal((await ask(local, "/api/v1/auth/google/callback?state=x", "127.0.0.1:8080")).headers.get("location"), "http://localhost:8080/#problem=not_started");
  // A server nobody signs in to has no one address, and moves nothing.
  const tokens = hostedApp(db, { publicUrl: "http://localhost:8080" }, { webRoot: web() });
  assert.notEqual((await tokens.request("/", { headers: { host: "127.0.0.1:8080" } })).status, 307);
  // Another site that sends a browser to sign in begins nothing: the dashboard is shown.
  const sent = await app.request("/api/v1/auth/google", { headers: { "sec-fetch-site": "cross-site", "x-forwarded-for": nextCaller() } });
  assert.deepEqual([sent.status, sent.headers.get("location"), sent.headers.getSetCookie()], [302, "https://app.test/", []]);
  for (const site of ["same-origin", "none"]) {
    const begun = await app.request("/api/v1/auth/google", { headers: { "sec-fetch-site": site, "x-forwarded-for": nextCaller() } });
    assert.equal(new URL(begun.headers.get("location") ?? "").host, "google.test", site);
  }
});

test("what the dashboard asks of a sign-in is taken from the dashboard only", async () => {
  const browser = await arrive(["dana@site.example"], { create: true });
  const ask = (path: string, headers: Record<string, string>, body = "{}") =>
    app.request(`/api/v1/auth/${path}`, {
      method: "POST",
      headers: { cookie: browser, "x-forwarded-for": nextCaller(), ...headers },
      body,
    });
  const json = { "content-type": "application/json" };
  for (const path of ["check", "verify", "cancel"]) {
    // A form on another site can send text, or a form; not JSON.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", ""]) {
      const refused = await ask(path, type ? { "content-type": type } : {}, `{"org_name":"Planted"}`);
      assert.deepEqual([refused.status, ((await refused.json()) as any).code], [415, "not_json"], `${path} as ${type}`);
    }
    // A page of a neighbouring host is sent the cookie, and says where it is from.
    const elsewhere: Record<string, string>[] = [
      { origin: "https://evil.app.test" },
      { origin: "https://test" },
      { origin: "http://app.test" },
      { origin: "null" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://app.test", "sec-fetch-site": "same-site" },
    ];
    for (const from of elsewhere) {
      const refused = await ask(path, { ...json, ...from });
      assert.deepEqual([refused.status, ((await refused.json()) as any).code], [403, "elsewhere"], `${path} from ${JSON.stringify(from)}`);
    }
  }
  // Nothing was done in her name by any of it.
  assert.equal((await db.query(`SELECT 1 FROM orgs WHERE name = 'Planted'`)).length, 0);
  // The dashboard itself, as a browser sends it, and with a character set named.
  const mine = await ask("check", { "content-type": "application/json; charset=utf-8", origin: "https://app.test", "sec-fetch-site": "same-origin" });
  assert.equal(mine.status, 200);
  assert.deepEqual(((await mine.json()) as any).emails, ["dana@site.example"]);
  const made = await ask("verify", { ...json, origin: "https://app.test", "sec-fetch-site": "same-origin" }, JSON.stringify({ org_name: "Dana's" }));
  assert.equal(made.status, 200);
});

test("an admin adds people, who sign in as what they were added as", async () => {
  const owner = await signUp("olive@team.example", "Team");
  const added = await post("/users", { email: "Mo@Team.example", role: "member" }, owner.token);
  assert.deepEqual([added.status, added.body.email, added.body.role], [201, "mo@team.example", "member"]);
  // Nothing is sent to Mo. Signing in, Mo is shown where, and by whom, before anything happens.
  const code = await arrive(["mo@team.example"]);
  const [place] = (await post("/auth/check", { code })).body.orgs;
  assert.deepEqual(
    [place.org_name, place.org_id, place.email, place.first_time, place.invited_by, place.invited_via],
    ["Team", owner.org.id, "mo@team.example", true, "olive@team.example", "sign_in"],
  );
  const mo = await post("/auth/verify", { code, user_id: place.user_id });
  assert.deepEqual([mo.body.org.id, mo.body.role], [owner.org.id, "member"]);
  // A member manages nobody.
  assert.equal((await get("/users", mo.body.token)).status, 403);
  // Nor adds anyone: adding is on the core's /users, behind its check for admins.
  const byMember = await post("/users", { email: "nope@team.example" }, mo.body.token);
  assert.deepEqual([byMember.status, byMember.body.error], [403, "admins only"]);
  assert.equal((await post("/users", { email: "x@team.example" }, mo.body.token)).status, 403);

  assert.equal((await post("/users", { email: "mo@team.example" }, owner.token)).body.code, "already_a_user");
  assert.equal((await post("/users", { email: "nope" }, owner.token)).status, 400);
  assert.equal((await post("/users", { email: `${"x".repeat(250)}@team.example` }, owner.token)).status, 400);
  assert.equal((await post("/users", { email: "x@team.example", role: "owner" }, owner.token)).status, 400);
  assert.deepEqual(
    (await get("/users", owner.token)).body.users.map((u: any) => [u.email, u.role]),
    [
      ["olive@team.example", "owner"],
      ["mo@team.example", "member"],
    ],
  );
  // Where nobody can sign in, there is nobody to add: a token is the way.
  const plain = hostedApp(db, {});
  const admin = await tokenFor(db, { email: "root@example.com", role: "admin" });
  const refused = await call(plain, "POST", "/users", { body: { email: "x@example.com" }, token: admin });
  assert.deepEqual([refused.status, refused.body.code], [409, "no_sign_in"]);
});

test("a person's own tokens are for their machines, and go when they do", async () => {
  const owner = await signUp("ria@shop.example", "Shop");
  await post("/users", { email: "sam@shop.example", role: "member" }, owner.token);
  const sam = await signIn("sam@shop.example");

  // What `sessionly connect` is given: a member's token, tied to the person.
  const made = await post("/me/tokens", { name: "laptop" }, sam.token);
  assert.deepEqual([made.status, made.body.role, made.body.email, made.body.name], [201, "member", "sam@shop.example", "laptop"]);
  const machine = made.body.token as string;
  assert.equal((await get("/ping", machine)).body.email, "sam@shop.example");
  // Even an owner's own token for a machine is a member's.
  const owners = await post("/me/tokens", {}, owner.token);
  assert.equal((await get("/ping", owners.body.token)).body.role, "member");
  // Each sees their own, and revokes only their own.
  assert.deepEqual((await get("/me/tokens", sam.token)).body.tokens.map((t: any) => t.name), ["laptop"]);
  assert.equal((await call(app, "DELETE", `/me/tokens/${owners.body.id}`, { token: sam.token })).status, 404);
  // A token for an environment or for CI is nobody's own.
  const env = await post("/tokens", { email: "cloud@shop.example", role: "env" }, owner.token);
  assert.equal((await post("/me/tokens", {}, env.body.token)).status, 403);

  // The owner stays, and nobody removes themselves.
  const people = (await get("/users", owner.token)).body.users;
  const id = (email: string) => people.find((u: any) => u.email === email).id;
  const remove = (who: string, token: string) => call(app, "DELETE", `/users/${who}`, { token });
  assert.equal((await remove(id("ria@shop.example"), owner.token)).body.code, "owner_stays");
  await post("/users", { email: "ada@shop.example", role: "admin" }, owner.token);
  const ada = await signIn("ada@shop.example");
  const adaId = (await get("/users", owner.token)).body.users.find((u: any) => u.email === "ada@shop.example").id;
  assert.equal((await remove(adaId, ada.token)).body.code, "not_yourself");
  assert.equal((await remove(id("ria@shop.example"), ada.token)).body.code, "owner_stays");

  // Removing Sam ends his session and his machine's token, and a sign-in he
  // was in the middle of leads nowhere.
  const midway = await arrive(["sam@shop.example"]);
  assert.equal((await remove(id("sam@shop.example"), ada.token)).body.removed, true);
  assert.equal((await get("/me", sam.token)).status, 401);
  assert.equal((await get("/ping", machine)).status, 401);
  assert.deepEqual((await post("/auth/check", { code: midway })).body.orgs, []);
  assert.equal((await post("/auth/verify", { code: midway, user_id: id("sam@shop.example") })).body.code, "invalid_code");
  assert.equal((await remove(id("sam@shop.example"), owner.token)).status, 404);
  // He can be added again, as something else.
  const back = await post("/users", { email: "sam@shop.example", role: "admin" }, owner.token);
  assert.deepEqual([back.status, back.body.role, back.body.removed_at], [201, "admin", null]);
  assert.equal((await signIn("sam@shop.example")).role, "admin");

  // An admin may remove another admin.
  const samId = (await get("/users", owner.token)).body.users.find((u: any) => u.email === "sam@shop.example").id;
  assert.equal((await remove(samId, ada.token)).body.removed, true);
});

test("a token issued to someone as they are removed is dead", async () => {
  const owner = await signUp("una@late.example", "Late");
  await post("/users", { email: "vic@late.example" }, owner.token);
  const vic = await signIn("vic@late.example");
  // As if the removal and the sign-in crossed: the person is gone, and a
  // token of theirs was left unrevoked.
  await db.query(`UPDATE users SET removed_at = now() WHERE email = 'vic@late.example'`);
  assert.equal((await get("/me", vic.token)).status, 401);
});

test("people are one organisation's: another cannot see or remove them", async () => {
  const a = await signUp("ann@one.example", "One");
  const b = await signUp("bea@two.example", "Two");
  await post("/users", { email: "al@one.example" }, a.token);
  const al = (await get("/users", a.token)).body.users.find((u: any) => u.email === "al@one.example");
  const theirs = await get("/users", b.token);
  assert.deepEqual(theirs.body.users.map((u: any) => u.email), ["bea@two.example"]);
  assert.equal((await call(app, "DELETE", `/users/${al.id}`, { token: b.token })).status, 404);
  assert.equal((await get("/users", a.token)).body.users.length, 2);
  // A token an admin makes for someone who is a user is tied to them.
  const forAl = await post("/tokens", { email: "al@one.example" }, a.token);
  assert.equal((await call(app, "DELETE", `/users/${al.id}`, { token: a.token })).status, 200);
  assert.equal((await get("/ping", forAl.body.token)).status, 401);
});

test("too many requests are refused, and too many organisations are not created", async () => {
  await clearOfTheClock(db);
  // Twenty goings a minute from one address; past that the browser is sent
  // back to be told so, and not on to the provider.
  const from = "203.0.113.9";
  for (let i = 0; i < 20; i++) assert.match((await leave({ from })).to.host, /google\.test/);
  assert.equal((await leave({ from })).to.href, "https://app.test/#problem=busy");
  // Someone else is not held up by it.
  assert.match((await leave()).to.host, /google\.test/);
  // Addresses of one IPv6 network are one caller.
  for (let i = 0; i < 20; i++) await leave({ from: `2001:db8:7:7::${i + 1}` });
  assert.equal((await leave({ from: "2001:db8:7:7:ffff::9" })).to.hash, "#problem=busy");
  assert.match((await leave({ from: "2001:db8:7:8::1" })).to.host, /google\.test/);
  // Coming back is counted on its own, as is using a code.
  const comer = "203.0.113.10";
  const lefts = [];
  for (let i = 0; i < 21; i++) lefts.push(await leave());
  const backs = [];
  for (const left of lefts) backs.push((await comeBack(["a@x.example"], left, { from: comer })).to.hash.replace(/=.*/, ""));
  assert.deepEqual(backs.slice(18), ["#signed-in", "#signed-in", "#problem"]);
  const asker = "203.0.113.11";
  const asks = [];
  for (let i = 0; i < 21; i++) asks.push((await call(app, "POST", "/auth/check", { body: { code: "x" }, from: asker })).status);
  assert.deepEqual(asks.slice(18), [400, 400, 429]);

  // Without a proxy of its own in front, the server does not believe what a
  // caller says its address is: all of these count as one.
  const direct = hostedApp(db, { ...hosted, trustProxy: false });
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await leave({ server: direct, from: `198.51.100.${i}` })).to.host);
  assert.deepEqual(statuses.slice(18), ["google.test", "google.test", "app.test"]);

  /** Try to create an organisation, on a server and from an address. */
  const create = async (server: Hono<Env>, email: string, name: string, from = nextCaller()) => {
    const code = await arrive([email], { server, create: true });
    return call(server, "POST", "/auth/verify", { body: { code, org_name: name }, from });
  };
  // One address creates five organisations an hour.
  const five = [];
  for (let i = 0; i < 7; i++) five.push((await create(app, "busy@x.example", `Busy ${i}`)).status);
  assert.deepEqual(five, [200, 200, 200, 200, 200, 429, 429]);
  // A refusal does not use the sign-in up, nor count against anything else.
  const kept = await db.query<{ key: string; n: number }>(`SELECT key, n FROM rate_counters WHERE key = 'signup:busy@x.example'`);
  assert.deepEqual(kept.map((row) => Number(row.n)), [5]);

  // All new organisations together have a ceiling, however many addresses
  // and networks they come from.
  const capped = hostedApp(db, { ...hosted, signupsPerHour: 7 });
  await db.query(`DELETE FROM rate_counters WHERE key LIKE 'signup%'`);
  for (let i = 0; i < 7; i++) assert.equal((await create(capped, `c${i}@x.example`, "Capped")).status, 200);
  // Reached, it says so to the next, and (once) to whoever runs the server.
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => void warned.push(line);
  try {
    for (const email of ["d1@x.example", "d2@x.example"]) {
      const refused = await create(capped, email, "Capped", "198.18.3.1");
      assert.deepEqual([refused.status, refused.body.code], [429, "signups_busy"]);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0] ?? "", /ceiling of 7 new organisations an hour is reached/);
  // A refusal there counts against neither the address nor the network.
  assert.equal(
    (await db.query(`SELECT 1 FROM rate_counters WHERE key IN ('signup:d1@x.example', 'signups-from:198.18.3.0/24') AND n > 0`)).length,
    0,
  );
  const [{ n: inAll } = { n: 0 }] = await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = 'signups'`);
  assert.equal(Number(inAll), 7);

  // One network creates so many an hour (five here, ten unless set),
  // whichever of its addresses asks and whoever for. The next network is
  // not held up by it.
  await db.query(`DELETE FROM rate_counters WHERE key LIKE 'signup%'`);
  const perNet = hostedApp(db, { ...hosted, signupsPerNetwork: 5 });
  const fromOne = [];
  for (let i = 0; i < 7; i++) fromOne.push((await create(perNet, `n${i}@x.example`, "Net", `198.18.7.${i + 1}`)).status);
  assert.deepEqual(fromOne, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await create(perNet, "n8@x.example", "Net", "198.18.8.1")).status, 200);
  const fromSite = [];
  for (let i = 0; i < 6; i++) fromSite.push((await create(perNet, `s${i}@x.example`, "Site", `2001:db8:9:${i}::1`)).status);
  assert.deepEqual(fromSite, [200, 200, 200, 200, 200, 429]);
  const unset = [];
  for (let i = 0; i < 11; i++) unset.push((await create(app, `u${i}@x.example`, "Net", `198.18.10.${i + 1}`)).status);
  assert.deepEqual(unset.slice(8), [200, 200, 429]);
  // What is refused for what it says, or for a code that is no good, is not counted there.
  for (let i = 0; i < 4; i++) {
    assert.equal((await create(app, "n9@x.example", "no/good", "198.18.9.1")).status, 400);
    assert.equal((await call(app, "POST", "/auth/verify", { body: { code: "stale", org_name: "Net" }, from: "198.18.9.1" })).status, 400);
  }
  assert.equal((await db.query(`SELECT 1 FROM rate_counters WHERE key = 'signups-from:198.18.9.0/24' AND n > 0`)).length, 0);

  // A token's own limit, where one is set.
  const limited = hostedApp(db, { ...hosted, ratePerMinute: 3 });
  const token = await tokenFor(db, { email: "fast@example.com", role: "member" });
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await call(limited, "GET", "/ping", { token })).status);
  assert.deepEqual(answers, [200, 200, 200, 429, 429]);

  // Where none is set, a hosted service still counts: 600 a minute, as the ee server is started.
  const env = { SESSIONLY_PUBLIC_URL: "https://app.test", SESSIONLY_GITHUB_CLIENT_ID: "id", SESSIONLY_GITHUB_CLIENT_SECRET: "secret" };
  const started = createApp(db, { hosting: hosting(db, { accounts: accountsFrom(env) }) });
  const steady = await tokenFor(db, { email: "steady@example.com", role: "member" });
  const before = (await db.query<{ key: string }>(`SELECT key FROM rate_counters`)).map((row) => row.key);
  assert.equal((await call(started, "GET", "/ping", { token: steady })).status, 200);
  const counted = await db.query<{ key: string }>(`SELECT key FROM rate_counters WHERE key LIKE 'token:%' AND NOT key = ANY($1)`, [before]);
  assert.equal(counted.length, 1);
  await db.query(`UPDATE rate_counters SET n = 599 WHERE key = $1`, [counted[0]?.key]);
  assert.equal((await call(started, "GET", "/ping", { token: steady })).status, 200);
  assert.equal((await call(started, "GET", "/ping", { token: steady })).status, 429);

  // Counters of windows long past are cleared away.
  await db.query(`UPDATE rate_counters SET window_start = window_start - interval '3 hours'`);
  await tidy(db);
  assert.equal((await db.query(`SELECT 1 FROM rate_counters`)).length, 0);
});

test("adding people is limited, since anyone can add anyone", async () => {
  await clearOfTheClock(db);
  // One organisation: thirty people an hour, whoever they are.
  const fresh = await signUp("kim@many.example", "Many");
  const many = [];
  for (let i = 0; i < 32; i++) many.push((await post("/users", { email: `p${i}@many.example` }, fresh.token)).status);
  assert.equal(many.filter((status) => status === 201).length, 30);
  assert.deepEqual(many.slice(30), [429, 429]);
  // Another organisation is not held up by it.
  const again = await signUp("moe@again.example", "Again");
  assert.equal((await post("/users", { email: "here@again.example" }, again.token)).status, 201);
  // Adding someone who is already there adds nobody, so it is not counted.
  for (let i = 0; i < 40; i++) {
    assert.equal((await post("/users", { email: "here@again.example" }, again.token)).status, 409);
  }
  const kept = await db.query<{ key: string; n: number }>(`SELECT key, n FROM rate_counters WHERE key = $1`, [`invites:${again.org.id}`]);
  assert.deepEqual(kept.map((row) => Number(row.n)), [1]);
  // A member's attempts, and nonsense, are refused without being counted.
  await post("/users", { email: "mem@again.example" }, again.token);
  const member = await signIn("mem@again.example");
  for (let i = 0; i < 40; i++) await post("/users", { email: `x${i}@again.example` }, member.token);
  for (let i = 0; i < 40; i++) await post("/users", { email: "not an address" }, again.token);
  assert.equal((await post("/users", { email: "ok@again.example" }, again.token)).status, 201);
});

test("nothing large is read from someone who is not signed in", async () => {
  const big = "x".repeat(20 * 1024);
  for (const path of ["/auth/verify", "/auth/check"]) {
    const answer = await call(app, "POST", path, { body: { org_name: big, code: big } });
    assert.equal(answer.status, 413, path);
  }
});

test("signing up can be closed, or need an invitation code", async () => {
  await clearOfTheClock(db);
  const closed = hostedApp(db, { ...hosted, signup: "off" });
  assert.equal((await call(closed, "GET", "/auth/options")).body.signup, false);
  // Someone who signed in while it was open creates nothing once it is closed.
  const code = await arrive(["slow@c.example"], { create: true });
  const refused = await call(closed, "POST", "/auth/verify", { body: { code, org_name: "Closing" } });
  assert.deepEqual([refused.status, refused.body.code], [403, "signup_closed"]);
  // People who are in an organisation still sign in there.
  const owner = await signUp("open@c.example", "Open");
  const still = await arrive(["open@c.example"], { server: closed });
  const [place] = (await call(closed, "POST", "/auth/check", { body: { code: still } })).body.orgs;
  assert.equal((await call(closed, "POST", "/auth/verify", { body: { code: still, user_id: place.user_id } })).body.org.id, owner.org.id);

  const invited = hostedApp(db, { ...hosted, signupCode: "early-2026" });
  assert.equal((await call(invited, "GET", "/auth/options")).body.inviteCode, true);
  const mine = await arrive(["d@e.example"], { server: invited, create: true });
  const ask = (invite_code?: string) =>
    call(invited, "POST", "/auth/verify", { body: { code: mine, org_name: "Dee", invite_code } });
  assert.equal((await ask()).body.code, "invite_required");
  assert.equal((await ask("wrong")).body.code, "invite_required");
  // A wrong code did not use the sign-in up.
  assert.equal((await ask("early-2026")).status, 200);

  // Whether a code is right is told only to someone who has signed in:
  // without a sign-in the answer is the same for the right code and a wrong one.
  const guess = (invite_code: string, from?: string, code?: string) =>
    call(invited, "POST", "/auth/verify", { body: { ...(code ? { code } : {}), org_name: "Guess", invite_code }, from });
  assert.deepEqual([(await guess("early-2026")).body.code, (await guess("wrong")).body.code], ["invalid_code", "invalid_code"]);
  assert.deepEqual([(await guess("early-2026", undefined, "made-up")).status, (await guess("wrong", undefined, "made-up")).status], [400, 400]);
  // And someone who has can only try so many an hour from one network: ten
  // wrong ones, and then no code of theirs is looked at, the right one neither.
  const guesser = await arrive(["guess@f.example"], { server: invited, create: true, account: "guesser" });
  const tries = [];
  for (let i = 0; i < 12; i++) tries.push((await guess(`try-${i}`, `198.51.100.${i + 1}`, guesser)).body.code);
  assert.deepEqual(tries, [...Array(10).fill("invite_required"), "invite_limited", "invite_limited"]);
  const locked = await guess("early-2026", "198.51.100.200", guesser);
  assert.deepEqual([locked.status, locked.body.code], [429, "invite_limited"]);
  // Nor from another network, with the same account: the account is counted too.
  assert.equal((await guess("early-2026", "203.0.113.77", guesser)).body.code, "invite_limited");
  // Another account from that network is refused there; from elsewhere its code is looked at.
  const other = await arrive(["other@f.example"], { server: invited, create: true, account: "someone-else" });
  assert.equal((await guess("early-2026", "198.51.100.201", other)).body.code, "invite_limited");
  // Ten tries at the same moment are ten tries: each is counted before it is looked at.
  const racer = await arrive(["race@f.example"], { server: invited, create: true, account: "racer" });
  const together = await Promise.all(Array.from({ length: 18 }, (_, i) => guess(`race-${i}`, "192.0.2.50", racer)));
  assert.equal(together.filter((each) => each.body.code === "invite_required").length, 10);
  assert.equal(together.filter((each) => each.body.code === "invite_limited").length, 8);
  // A right code is not a try: it can be given as often as there are organisations to make.
  const counted = async (key: string) => (await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = $1`, [key]))[0]?.n ?? 0;
  assert.equal((await guess("early-2026", "203.0.113.90", other)).status, 200);
  assert.deepEqual([await counted("invite-wrong:203.0.113.0/24"), await counted("invite-wrong-by:google:someone-else")], [0, 0]);
  // Many wrong ones from everywhere are said in the log, once, and close signing up for nobody.
  await db.query(`UPDATE rate_counters SET n = 1000 WHERE key = 'invite-wrong'`);
  const late = await arrive(["late@f.example"], { server: invited, create: true, account: "latecomer" });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => void warned.push(line);
  try {
    assert.equal((await guess("nope", "198.18.77.9", late)).body.code, "invite_required");
    assert.equal((await guess("nope", "198.18.77.9", late)).body.code, "invite_required");
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0] ?? "", /^More than 1000 wrong invitation codes were tried in an hour/);
  assert.equal((await guess("early-2026", "198.18.77.9", late)).status, 200);
});

test("the environment sets how people get in", () => {
  const env = {
    SESSIONLY_HOSTED: "true",
    DATABASE_URL: "postgres://app@db.internal/sessionly",
    SESSIONLY_PUBLIC_URL: "https://app.example.com",
    SESSIONLY_GITHUB_CLIENT_ID: "Iv1.test",
    SESSIONLY_GITHUB_CLIENT_SECRET: "secret-of-github",
    SESSIONLY_HASH_KEY: "k".repeat(32),
  };
  const both = { ...env, SESSIONLY_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", SESSIONLY_GOOGLE_CLIENT_SECRET: "secret-of-google" };
  assert.deepEqual(hostedProblems(env), []);
  const accounts = accountsFrom(env);
  assert.deepEqual(offers(accounts), { hosted: true, noSignIn: false, providers: ["github"], signup: true, inviteCode: false, publicUrl: "https://app.example.com" });
  assert.deepEqual(offers(accountsFrom(both)).providers, ["google", "github"]);
  // Each sends the browser to its own, with this server's id and never its secret.
  const [google, github] = accountsFrom(both).providers ?? [];
  const ask = { redirectUri: "https://app.example.com/api/v1/auth/x/callback", state: "s", challenge: "c" };
  assert.match(google?.authorizeUrl(ask) ?? "", /^https:\/\/accounts\.google\.com\/.*client_id=test\.apps\.googleusercontent\.com/);
  assert.match(github?.authorizeUrl(ask) ?? "", /^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=Iv1\.test/);
  assert.doesNotMatch(`${google?.authorizeUrl(ask)}${github?.authorizeUrl(ask)}`, /secret-of/);
  assert.equal(accounts.ratePerMinute, 600);
  assert.equal(accounts.signupsPerHour, undefined);
  // The core's settings come with them: a hosted server has no other accounts.
  assert.deepEqual(
    [accountsFrom({ ...env, SESSIONLY_TRUST_PROXY: "true", SESSIONLY_ADMIN_EMAIL: "ops@example.com" }).trustProxy, accountsFrom({ ...env, SESSIONLY_ADMIN_EMAIL: "ops@example.com" }).admin],
    [true, "ops@example.com"],
  );
  assert.equal(accountsFrom({ ...env, SESSIONLY_SIGNUPS_PER_HOUR: "20" }).signupsPerHour, 20);
  assert.equal(accountsFrom({ ...env, SESSIONLY_SIGNUPS_PER_HOUR: "lots" }).signupsPerHour, undefined);
  // A count is a whole number above 0, in plain digits. Anything else is
  // as if it were not set: given to the database as a count, it would fail
  // every request, and "1e2" or "0x10" may not be the number that was meant.
  for (const odd of ["0", "-3", "2.5", "1e12", "1e2", "0x10", "Infinity", "NaN", "0x", "12 an hour", " ", ""]) {
    const set = accountsFrom({
      ...env,
      SESSIONLY_RATE_PER_MINUTE: odd,
      SESSIONLY_SIGNUPS_PER_HOUR: odd,
      SESSIONLY_SIGNUPS_PER_NETWORK: odd,
    });
    assert.deepEqual([set.ratePerMinute, set.signupsPerHour, set.signupsPerNetwork], [600, undefined, undefined], `"${odd}"`);
  }
  const counts = accountsFrom({
    ...env,
    SESSIONLY_RATE_PER_MINUTE: "50",
    SESSIONLY_SIGNUPS_PER_HOUR: " 7 ",
    SESSIONLY_SIGNUPS_PER_NETWORK: "100",
  });
  assert.deepEqual([counts.ratePerMinute, counts.signupsPerHour, counts.signupsPerNetwork], [50, 7, 100]);
  assert.equal(offers(accountsFrom({ ...env, SESSIONLY_SIGNUP: "off" })).signup, false);
  assert.equal(offers(accountsFrom({ ...env, SESSIONLY_SIGNUP_CODE: "x" })).inviteCode, true);
  // A hosted service nobody could sign in to is refused at the start: one
  // with no provider, with half of one, or with nowhere to send people back to.
  assert.match(hostedProblems({ ...env, SESSIONLY_GITHUB_CLIENT_SECRET: "" }).join(), /No way of signing in is set \(SESSIONLY_GOOGLE_CLIENT_ID with SESSIONLY_GOOGLE_CLIENT_SECRET, or SESSIONLY_GITHUB_CLIENT_ID with SESSIONLY_GITHUB_CLIENT_SECRET\)/);
  assert.match(hostedProblems({ ...env, SESSIONLY_PUBLIC_URL: " " }).join(), /SESSIONLY_PUBLIC_URL is not set/);
  // A scheme or a host in capitals is the same address.
  assert.deepEqual(hostedProblems({ ...env, SESSIONLY_PUBLIC_URL: "HTTPS://App.Example.com" }), []);
  assert.equal(accountsFrom({ ...env, SESSIONLY_PUBLIC_URL: "HTTPS://App.Example.com/" }).publicUrl, "https://app.example.com");
  assert.deepEqual(hostedProblems({ ...env, SESSIONLY_PUBLIC_URL: "HTTP://LOCALHOST:8080" }), []);
  // Said before the server starts, not thrown once it is starting.
  assert.match(hostedProblems({ ...env, SESSIONLY_PUBLIC_URL: "https://app.example.com/app" }).join(), /SESSIONLY_PUBLIC_URL must be an address like https:\/\/app\.example\.com, with no path/);
  // Or one reached over plain HTTP, where the cookies of a sign-in are not
  // kept to this host and every token crosses in clear. On the machine it
  // runs on nothing crosses anything, which is how one is tried.
  for (const plain of ["http://app.example.com", "http://localhost.example.com", "http://10.0.0.5:8080", "HTTP://app.example.com"]) {
    assert.match(hostedProblems({ ...env, SESSIONLY_PUBLIC_URL: plain }).join(), /SESSIONLY_PUBLIC_URL must begin with https:\/\//, plain);
  }
  for (const here of ["http://localhost:8080", "http://127.0.0.1:8080/", "http://[::1]:8080", "http://localhost"]) {
    assert.deepEqual(hostedProblems({ ...env, SESSIONLY_PUBLIC_URL: here }), [], here);
  }
  assert.deepEqual(offers(accountsFrom({ ...env, SESSIONLY_GITHUB_CLIENT_SECRET: " " })).providers, []);
  assert.throws(() => accountsFrom({ SESSIONLY_PUBLIC_URL: "app.example.com/x" }), /SESSIONLY_PUBLIC_URL/);
});

test("people from before the account was kept are asked as someone new, and then have one", async (t) => {
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-confirmed-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const url = folder ? `file:${join(folder, "db")}` : fresh;
  // As a server from before first sign-ins were noted left it.
  const old = await openDb(url, { migrations: migrationAt("UPDATE users u") });
  await old.query(`INSERT INTO orgs (id, name) VALUES ('old-org', 'Old Org')`);
  await old.query(
    `INSERT INTO users (id, org_id, email, role) VALUES
       ('usr_owner', 'old-org', 'owner@old.example', 'owner'),
       ('usr_seen', 'old-org', 'seen@old.example', 'member'),
       ('usr_never', 'old-org', 'never@old.example', 'member')`,
  );
  await old.query(
    `INSERT INTO tokens (org_id, id, token_hash, email, role, user_id, sign_in, expires_at) VALUES
       ('old-org', 't1', 'h1', 'seen@old.example', 'member', 'usr_seen', 'email', now() - interval '3 days'),
       ('old-org', 't2', 'h2', 'never@old.example', 'member', 'usr_never', NULL, NULL)`,
  );
  await old.close();
  const known = (at: Db) =>
    at
      .query<{ id: string; known: boolean }>(`SELECT id, confirmed_at IS NOT NULL AS known FROM users WHERE org_id = 'old-org' ORDER BY id`)
      .then((rows) => rows.map((row) => [row.id, row.known]));
  // As the server that noted them left it, which kept no account yet: the
  // owner signed up by a link; one member has had a session; the other
  // only a token for a machine, which says nothing of the address.
  const noted = await openDb(url, { migrations: migrationAt("UPDATE users SET confirmed_at = NULL") });
  assert.deepEqual(await known(noted), [["usr_never", false], ["usr_owner", true], ["usr_seen", true]]);
  await noted.close();
  // Now: nobody has signed in with an account that is kept, the owner neither.
  const now = await openDb(url);
  try {
    assert.deepEqual(await known(now), [["usr_never", false], ["usr_owner", false], ["usr_seen", false]]);
    // And nobody can be noted as having signed in without one.
    await assert.rejects(now.query(`UPDATE users SET confirmed_at = now() WHERE id = 'usr_seen'`), /users_confirmed_with_account/);
    // Whoever comes under the owner's address is not taken straight in:
    // they are shown the organisation as one they have not signed in to,
    // and asked. The account that goes on is the owner's from then on, and
    // another that has the address is refused.
    const upgraded = hostedApp(now, hosted);
    const ask = (code: string) => call(upgraded, "POST", "/auth/check", { body: { code } });
    const first = await arrive(["owner@old.example"], { server: upgraded, account: "the-owner" });
    const [place] = (await ask(first)).body.orgs;
    assert.deepEqual([place.org_id, place.first_time, place.other_account], ["old-org", true, null]);
    const entered = await call(upgraded, "POST", "/auth/verify", { body: { code: first, user_id: "usr_owner" } });
    assert.deepEqual([entered.status, entered.body.role], [200, "admin"]);
    const other = await arrive(["owner@old.example"], { server: upgraded, account: "someone-else" });
    assert.deepEqual((await ask(other)).body.orgs.map((org: any) => [org.first_time, org.other_account]), [[false, "google"]]);
    assert.equal((await call(upgraded, "POST", "/auth/verify", { body: { code: other, user_id: "usr_owner" } })).body.code, "other_account");
  } finally {
    await now.close();
  }
});

test("a setting that does nothing as it is set is said at the start", () => {
  assert.deepEqual(hostedNotes({}), []);
  // Half of what a provider needs, or all of it and nowhere to send people back to.
  const half = hostedNotes({ SESSIONLY_GOOGLE_CLIENT_ID: "id", SESSIONLY_PUBLIC_URL: "https://app.example.com" });
  assert.deepEqual(half, [
    "Only one of SESSIONLY_GOOGLE_CLIENT_ID and SESSIONLY_GOOGLE_CLIENT_SECRET is set: signing in with Google needs both, and is off.",
  ]);
  assert.match(
    hostedNotes({ SESSIONLY_GITHUB_CLIENT_ID: "id", SESSIONLY_GITHUB_CLIENT_SECRET: "s" }).join(),
    /^SESSIONLY_GITHUB_CLIENT_ID is set, but SESSIONLY_PUBLIC_URL is not: signing in with GitHub is off/,
  );
  assert.deepEqual(hostedNotes({ SESSIONLY_GITHUB_CLIENT_ID: "id", SESSIONLY_GITHUB_CLIENT_SECRET: "s", SESSIONLY_PUBLIC_URL: "https://app.example.com" }), []);
  // It may be tried over plain HTTP on its own machine, and is told if it is set up that way anywhere else.
  const github = { SESSIONLY_GITHUB_CLIENT_ID: "id", SESSIONLY_GITHUB_CLIENT_SECRET: "s" };
  for (const here of ["http://localhost:8080", "http://127.0.0.1:8080/", "http://[::1]:8080", "http://localhost"]) {
    assert.deepEqual(hostedNotes({ ...github, SESSIONLY_PUBLIC_URL: here }), [], here);
  }
  for (const there of ["http://sessionly.corp.example", "http://localhost.evil.example", "http://10.0.0.5:8080"]) {
    assert.match(hostedNotes({ ...github, SESSIONLY_PUBLIC_URL: there }).join(), /^SESSIONLY_PUBLIC_URL is plain HTTP on a host that is not this machine/, there);
  }
  assert.deepEqual(hostedNotes({ SESSIONLY_PUBLIC_URL: "http://sessionly.corp.example" }), []);
  // A count of its own that is not one; the core's (SESSIONLY_RATE_PER_MINUTE, SESSIONLY_DB_POOL) the core says itself.
  assert.deepEqual(hostedNotes({ SESSIONLY_SIGNUPS_PER_HOUR: "100", SESSIONLY_SIGNUPS_PER_NETWORK: "" }), []);
  const notes = hostedNotes({ SESSIONLY_RATE_PER_MINUTE: "0.5", SESSIONLY_SIGNUPS_PER_HOUR: "many", SESSIONLY_SIGNUPS_PER_NETWORK: "0", SESSIONLY_DB_POOL: "-1" });
  assert.equal(notes.length, 2);
  assert.match(notes[0] ?? "", /^SESSIONLY_SIGNUPS_PER_HOUR is "many", which is not a whole number above 0/);
  assert.equal(accountsFrom({ SESSIONLY_SIGNUPS_PER_NETWORK: "25" }).signupsPerNetwork, 25);
});

test("an organisation's name: any script's letters, composed, and no styled lookalikes", () => {
  // Typed with a separate accent, it is kept as the one letter.
  assert.equal(orgNameFrom("Cafe\u0301 Central"), "Caf\u00e9 Central");
  assert.equal(orgNameFrom("  Acme,   Inc "), "Acme, Inc");
  // Scripts that write vowels and tones as marks on a letter.
  for (const name of ["देवनागरी सेवा", "น้ำใจ บริษัท", "ກຳໄລ", "شركة النور", "한국 회사", "Ünïcödé & Sons", "Société Générale"]) {
    assert.equal(orgNameFrom(name), name.normalize("NFC"), name);
  }
  // Letters that are a styled form of another: fullwidth, mathematical, circled, ligatures.
  for (const name of ["Ａｃｍｅ", "\u{1D400}cme Inc", "Ⓐcme", "Oﬃce Co", "Acme\u00a0Inc²"]) {
    assert.equal(orgNameFrom(name), null, name);
  }
  // Marks piled on a letter, and what could carry a link or an address.
  assert.equal(orgNameFrom(`Za${"\u0301".repeat(5)}lgo`), null);
  assert.equal(orgNameFrom(`Za${"\u0301".repeat(4)}lgo`)?.length, 8);
  for (const name of ["evil.example", "a@b", "http://x", "x", "", "\u0301Acme", "x".repeat(61)]) {
    assert.equal(orgNameFrom(name), null, name);
  }
});

test("an organisation's id is readable and its own", () => {
  assert.match(orgIdFor("Acme, Inc"), /^acme-inc-[a-z0-9]{6}$/);
  assert.match(orgIdFor("Ünïcödé & Sons"), /^unicode-sons-[a-z0-9]{6}$/);
  assert.match(orgIdFor("!!!"), /^org-[a-z0-9]{6}$/);
  assert.match(orgIdFor("x".repeat(200)), /^x{40}-[a-z0-9]{6}$/);
  assert.notEqual(orgIdFor("Same"), orgIdFor("Same"));
});

test("anyone who signs in may join the organisation a repository is shown in, as a viewer who can only look", async () => {
  await newOrg(db, "showcase", "Showcase");
  const demoApp = hostedApp(db, hosted, {}, { org: "showcase", hide: [] });
  const on = (method: string, path: string, token: string, body?: unknown) => call(demoApp, method, path, { token, body });
  // one of the server's copies there, as `demo import` stores it
  const upload = (id: string) => ({
    schema_version: 1,
    session: { schema_version: 1, source: "claude-code", machine_id: "m1", session_id: id, started_at: "2026-11-10T09:00:00Z", repo: { remote: "github.com/acme/shown" } },
  });
  const ann = { orgId: "showcase", email: "ann@example.com", name: null, role: "member" as const, tokenId: null, userId: null, signedIn: false, owner: false };
  await db.asOrg("showcase", (tx) => storeUpload(tx, upload("copy1") as never, ann, { copy: true }));

  // offered to someone nobody added, and joined as a viewer
  const code = await arrive(["visitor@example.com"], { server: demoApp });
  const offered = (await call(demoApp, "POST", "/auth/check", { body: { code } })).body.orgs as { user_id: string; org_id: string; demo?: boolean }[];
  assert.deepEqual(offered.map((o) => [o.org_id, o.user_id, o.demo]), [["showcase", "demo", true]]);
  const joined = await call(demoApp, "POST", "/auth/verify", { body: { code, user_id: "demo" } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual([joined.body.org.id, joined.body.role], ["showcase", "viewer"]);
  const token = joined.body.token as string;

  // they see everyone's sessions, and the pull requests
  const seen = await on("GET", "/sessions", token);
  assert.deepEqual([seen.status, seen.body.sessions.map((s: { session_id: string }) => s.session_id)], [200, ["copy1"]]);
  assert.equal((await on("GET", "/sessions/m1/claude-code/copy1", token)).status, 200);
  assert.equal((await on("GET", "/prs", token)).status, 200);
  assert.equal((await on("GET", "/prs/summary", token)).status, 200);
  // and change nothing: no upload, no taking back, no tokens, no people, no stopping a repository, no matching
  for (const [method, path, body] of [
    ["PUT", "/sessions/m1/claude-code/mine", upload("mine")],
    ["DELETE", "/sessions/m1/claude-code/copy1", undefined],
    ["POST", "/me/tokens", { name: "laptop" }],
    ["POST", "/tokens", { email: "x@example.com", role: "admin" }],
    ["POST", "/users", { email: "x@example.com", role: "admin" }],
    ["PUT", "/repos/excluded", { repo: "github.com/acme/shown" }],
    ["POST", "/prs/match", {}],
    ["PUT", "/prs", { repo: "github.com/acme/shown", number: 1 }],
    ["DELETE", "/org", undefined],
  ] as const) {
    const answer = await on(method, path, token, body);
    assert.equal(answer.status, 403, `${method} ${path}`);
  }
  for (const path of ["/users", "/tokens", "/me/tokens", "/export"]) assert.equal((await on("GET", path, token)).status, 403, path);
  assert.equal((await db.query(`SELECT 1 FROM sessions WHERE org_id = 'showcase'`)).length, 1);

  // someone who came by the website's Demo button is told which it is, to be taken straight in; nobody else is
  const fromButton = await arrive(["button@example.com"], { server: demoApp, demo: true });
  const told = (await call(demoApp, "POST", "/auth/check", { body: { code: fromButton } })).body;
  assert.deepEqual([told.demo_org, told.orgs.map((o: { user_id: string }) => o.user_id)], ["showcase", ["demo"]]);
  assert.equal("demo_org" in (await call(demoApp, "POST", "/auth/check", { body: { code: await arrive(["plain@example.com"], { server: demoApp }) } })).body, false);

  // the next time, it is a place of theirs like any other; and they can sign out
  const again = await arrive(["visitor@example.com"], { server: demoApp });
  const theirs = (await call(demoApp, "POST", "/auth/check", { body: { code: again } })).body.orgs as { user_id: string; demo?: boolean }[];
  assert.deepEqual([theirs.length, theirs[0]!.user_id.startsWith("usr_"), theirs[0]!.demo], [1, true, undefined]);
  assert.equal((await on("DELETE", "/auth/session", token)).status, 200);

  // an organisation holding a session that is not one of the server's copies is not opened to anyone:
  // the settings may name the one the work is in
  await db.asOrg("showcase", (tx) => storeUpload(tx, upload("own") as never, ann));
  const later = await arrive(["someone@example.com"], { server: demoApp });
  assert.deepEqual((await call(demoApp, "POST", "/auth/check", { body: { code: later } })).body.orgs, []);
  const forced = await call(demoApp, "POST", "/auth/verify", { body: { code: later, user_id: "demo" } });
  assert.deepEqual([forced.status, forced.body.code], [403, "not_open"]);
});

test("a hosted service refuses what only a single install may have", () => {
  const set = {
    DATABASE_URL: "postgres://app@db.internal/sessionly",
    SESSIONLY_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
    SESSIONLY_GOOGLE_CLIENT_SECRET: "secret",
    SESSIONLY_PUBLIC_URL: "https://app.example.com",
    SESSIONLY_HASH_KEY: "k".repeat(32),
  };
  assert.deepEqual(hostedProblems(set), []);
  assert.match(hostedProblems({ ...set, SESSIONLY_HASH_KEY: "short" }).join(), /SESSIONLY_HASH_KEY/);
  assert.match(hostedProblems({ ...set, SESSIONLY_ADMIN_TOKEN: "x" }).join(), /no admin of every organisation/);
  assert.match(hostedProblems({}).join(), /postgres:\/\//);
  assert.match(hostedProblems({ ...set, DATABASE_URL: "file:/data" }).join(), /postgres:\/\//);
});
