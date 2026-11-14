// Signing up, signing in by email, and the people of an organisation.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { tidy } from "../src/limits.ts";
import type { Mail } from "../src/mail.ts";
import { accountsFrom, hostedProblems } from "../src/run.ts";
import { offers, orgIdFor, type Accounts } from "../src/signup.ts";
import { testDb, tokenFor } from "./helpers.ts";

let db: Db;
let app: Hono<Env>;
const sent: Mail[] = [];
const mailer = {
  send: async (mail: Mail) => {
    sent.push(mail);
  },
};
const hosted: Accounts = { hosted: true, mailer, publicUrl: "https://app.test", trustProxy: true };

before(async () => {
  db = await testDb();
  app = createApp(db, { accounts: hosted });
});
after(() => db.close());

// Each call comes from an address of its own unless a test says otherwise,
// so that the limits per address only count where a test means them to.
let caller = 0;
async function call(
  server: Hono<Env>,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; from?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": options.from ?? `10.0.${Math.floor(++caller / 250)}.${caller % 250}`,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await server.request(`/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const post = (path: string, body: unknown, token?: string) => call(app, "POST", path, { body, token });
const get = (path: string, token: string) => call(app, "GET", path, { token });

/** The codes in the links of the last message to an address, by organisation as the message names them. */
function linksTo(address: string): string[] {
  const mail = sent.findLast((m) => m.to === address);
  assert.ok(mail, `no message to ${address}`);
  return [...mail.text.matchAll(/https:\/\/app\.test\/#login=([\w-]+)/g)].map((m) => m[1] ?? "");
}

/** Sign up and return the owner's session. */
async function signUp(email: string, orgName: string) {
  assert.equal((await post("/auth/signup", { email, org_name: orgName })).status, 202);
  const [code] = linksTo(email);
  const verified = await post("/auth/verify", { code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body as { token: string; org: { id: string; name: string }; email: string; role: string; expires_at: string; created: boolean };
}

async function signIn(email: string, pick = 0) {
  assert.equal((await post("/auth/email", { email })).status, 202);
  const code = linksTo(email)[pick];
  const verified = await post("/auth/verify", { code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body as { token: string; org: { id: string; name: string }; role: string; expires_at: string; created: boolean };
}

test("what the server offers depends on how it is set up", async () => {
  assert.deepEqual((await call(app, "GET", "/auth/options")).body, {
    hosted: true,
    emailSignIn: true,
    signup: true,
    inviteCode: false,
  });
  // A self-hosted install with email: people sign in, nobody signs up.
  assert.deepEqual(offers({ mailer, publicUrl: "https://s.test" }), {
    hosted: false,
    emailSignIn: true,
    signup: false,
    inviteCode: false,
  });
  // Without email there are only tokens.
  assert.deepEqual(offers({ hosted: true }), { hosted: true, emailSignIn: false, signup: false, inviteCode: false });
  assert.equal(offers({ ...hosted, signup: "off" }).signup, false);
  const plain = createApp(db, {});
  assert.equal((await call(plain, "POST", "/auth/email", { body: { email: "a@b.example" } })).status, 404);
  assert.equal((await call(plain, "POST", "/auth/signup", { body: { email: "a@b.example", org_name: "X" } })).body.code, "signup_closed");
});

test("signing up creates an organisation when the link is used, and not before", async () => {
  const orgs = async () => Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`))[0]?.n);
  const before = await orgs();
  assert.equal((await post("/auth/signup", { email: "Kay@Acme.example", org_name: "  Acme,   Inc. " })).status, 202);
  assert.equal(await orgs(), before);
  assert.equal(sent.at(-1)?.to, "kay@acme.example");
  assert.match(sent.at(-1)?.text ?? "", /create Acme, Inc\. on Sessionly/);

  const [code] = linksTo("kay@acme.example");
  const first = await post("/auth/verify", { code });
  assert.equal(first.status, 200);
  assert.match(first.body.org.id, /^acme-inc-[a-z0-9]{6}$/);
  assert.equal(first.body.org.name, "Acme, Inc.");
  assert.deepEqual([first.body.email, first.body.role, first.body.created], ["kay@acme.example", "admin", true]);
  assert.equal(await orgs(), before + 1);
  // About a week.
  const days = (Date.parse(first.body.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, String(days));

  const me = await get("/me", first.body.token);
  assert.deepEqual(
    [me.body.org, me.body.org_name, me.body.email, me.body.role, me.body.signed_in],
    [first.body.org.id, "Acme, Inc.", "kay@acme.example", "admin", true],
  );
  // The new organisation is empty, and its owner is its one person.
  assert.equal((await get("/sessions", first.body.token)).body.total, 0);
  assert.deepEqual((await get("/users", first.body.token)).body.users.map((u: any) => [u.email, u.role]), [
    ["kay@acme.example", "owner"],
  ]);

  // The link worked once.
  const again = await post("/auth/verify", { code });
  assert.deepEqual([again.status, again.body.code], [400, "invalid_code"]);
  assert.equal(await orgs(), before + 1);
  for (const bad of ["", "nonsense", "x".repeat(300), 7]) {
    assert.equal((await post("/auth/verify", { code: bad })).status, 400);
  }
  // Bad requests are told so, and create nothing.
  assert.equal((await post("/auth/signup", { email: "not-an-address", org_name: "X" })).status, 400);
  assert.equal((await post("/auth/signup", { email: "a@b.example", org_name: "" })).status, 400);
  assert.equal((await post("/auth/signup", { email: "a@b.example", org_name: "x".repeat(81) })).status, 400);
});

test("a link that has run out does nothing", async () => {
  assert.equal((await post("/auth/signup", { email: "late@slow.example", org_name: "Slow" })).status, 202);
  const [code] = linksTo("late@slow.example");
  await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 second' WHERE email = 'late@slow.example'`);
  assert.equal((await post("/auth/verify", { code })).body.code, "invalid_code");
  const [made] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs WHERE name = 'Slow'`);
  assert.equal(Number(made?.n), 0);
  // Only the hash of a code is kept.
  const stored = await db.query<{ code_hash: string }>(`SELECT code_hash FROM login_codes`);
  assert.ok(stored.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash) && row.code_hash !== code));
  await tidy(db);
  assert.equal((await db.query(`SELECT 1 FROM login_codes WHERE email = 'late@slow.example'`)).length, 0);
});

test("signing in sends a link to a known address and says the same to an unknown one", async () => {
  const owner = await signUp("lee@lumen.example", "Lumen");
  const count = sent.length;
  const unknown = await post("/auth/email", { email: "nobody@nowhere.example" });
  const known = await post("/auth/email", { email: "LEE@lumen.example" });
  assert.deepEqual([unknown.status, unknown.body], [known.status, known.body]);
  assert.equal(sent.length, count + 1);
  assert.match(sent.at(-1)?.text ?? "", /Sign in to Lumen on Sessionly/);

  const session = await post("/auth/verify", { code: linksTo("lee@lumen.example")[0] });
  assert.deepEqual([session.body.org.id, session.body.role, session.body.created], [owner.org.id, "admin", false]);
  assert.notEqual(session.body.token, owner.token);
  // A session is not one of the organisation's tokens to manage.
  assert.deepEqual((await get("/tokens", session.body.token)).body.tokens, []);

  // Signing out ends that session and no other.
  assert.equal((await call(app, "DELETE", "/auth/session", { token: session.body.token })).body.signed_out, true);
  assert.equal((await get("/me", session.body.token)).status, 401);
  assert.equal((await get("/me", owner.token)).status, 200);
  assert.equal((await post("/auth/email", { email: "nope" })).status, 400);
});

test("one address in two organisations gets a link to each", async () => {
  const one = await signUp("pat@both.example", "First Co");
  const two = await signUp("pat@both.example", "Second Co");
  assert.notEqual(one.org.id, two.org.id);
  assert.equal((await post("/auth/email", { email: "pat@both.example" })).status, 202);
  const text = sent.at(-1)?.text ?? "";
  assert.match(text, /in 2 organisations/);
  assert.ok(text.indexOf("First Co:") < text.indexOf("Second Co:"));
  const codes = linksTo("pat@both.example");
  assert.equal(codes.length, 2);
  const into = await Promise.all(codes.map((code) => post("/auth/verify", { code })));
  assert.deepEqual(into.map((s) => s.body.org.name), ["First Co", "Second Co"]);
  // Each session is of its own organisation.
  assert.equal((await get("/me", into[0]?.body.token)).body.org, one.org.id);
  assert.equal((await get("/me", into[1]?.body.token)).body.org, two.org.id);
});

test("an admin adds people, who sign in as what they were added as", async () => {
  const owner = await signUp("olive@team.example", "Team");
  const added = await post("/users", { email: "Mo@Team.example", role: "member" }, owner.token);
  assert.deepEqual([added.status, added.body.email, added.body.role], [201, "mo@team.example", "member"]);
  assert.match(sent.at(-1)?.text ?? "", /olive@team\.example added you to Team on Sessionly/);
  const mo = await post("/auth/verify", { code: linksTo("mo@team.example")[0] });
  assert.deepEqual([mo.body.org.id, mo.body.role], [owner.org.id, "member"]);
  // A member manages nobody.
  assert.equal((await get("/users", mo.body.token)).status, 403);
  assert.equal((await post("/users", { email: "x@team.example" }, mo.body.token)).status, 403);

  assert.equal((await post("/users", { email: "mo@team.example" }, owner.token)).body.code, "already_a_user");
  assert.equal((await post("/users", { email: "nope" }, owner.token)).status, 400);
  assert.equal((await post("/users", { email: "x@team.example", role: "owner" }, owner.token)).status, 400);
  assert.deepEqual(
    (await get("/users", owner.token)).body.users.map((u: any) => [u.email, u.role]),
    [
      ["olive@team.example", "owner"],
      ["mo@team.example", "member"],
    ],
  );
});

test("a person's own tokens are for their machines, and go when they do", async () => {
  const owner = await signUp("ria@shop.example", "Shop");
  await post("/users", { email: "sam@shop.example", role: "member" }, owner.token);
  const sam = (await post("/auth/verify", { code: linksTo("sam@shop.example")[0] })).body;

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
  const ada = (await post("/auth/verify", { code: linksTo("ada@shop.example")[0] })).body;
  const adaId = (await get("/users", owner.token)).body.users.find((u: any) => u.email === "ada@shop.example").id;
  assert.equal((await remove(adaId, ada.token)).body.code, "not_yourself");
  assert.equal((await remove(id("ria@shop.example"), ada.token)).body.code, "owner_stays");

  // Removing Sam ends his session and his machine's token, and he gets no more links.
  assert.equal((await remove(id("sam@shop.example"), ada.token)).body.removed, true);
  assert.equal((await get("/me", sam.token)).status, 401);
  assert.equal((await get("/ping", machine)).status, 401);
  const count = sent.length;
  assert.equal((await post("/auth/email", { email: "sam@shop.example" })).status, 202);
  assert.equal(sent.length, count);
  assert.equal((await remove(id("sam@shop.example"), owner.token)).status, 404);
  // He can be added again, as something else.
  const back = await post("/users", { email: "sam@shop.example", role: "admin" }, owner.token);
  assert.deepEqual([back.status, back.body.role, back.body.removed_at], [201, "admin", null]);
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

test("too many requests are refused, and too many links are not sent", async () => {
  // Five asks a minute from one address.
  const from = "203.0.113.9";
  for (let i = 0; i < 5; i++) {
    assert.equal((await call(app, "POST", "/auth/email", { body: { email: `a${i}@x.example` }, from })).status, 202);
  }
  const sixth = await call(app, "POST", "/auth/email", { body: { email: "a6@x.example" }, from });
  assert.deepEqual([sixth.status, sixth.body.code], [429, "rate_limited"]);
  // Someone else is not held up by it.
  assert.equal((await post("/auth/email", { email: "a7@x.example" })).status, 202);

  // Five links an hour to one address, whoever asks: the answer stays the same.
  await signUp("busy@inbox.example", "Inbox");
  const count = sent.length;
  for (let i = 0; i < 8; i++) assert.equal((await post("/auth/email", { email: "busy@inbox.example" })).status, 202);
  // The signup link above was the first of the five.
  assert.equal(sent.length - count, 4);

  // A token's own limit, where one is set.
  const limited = createApp(db, { accounts: { ...hosted, ratePerMinute: 3 } });
  const token = await tokenFor(db, { email: "fast@example.com", role: "member" });
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await call(limited, "GET", "/ping", { token })).status);
  assert.deepEqual(answers, [200, 200, 200, 429, 429]);

  // Counters of windows long past are cleared away.
  await db.query(`UPDATE rate_counters SET window_start = window_start - interval '3 hours'`);
  await tidy(db);
  assert.equal((await db.query(`SELECT 1 FROM rate_counters`)).length, 0);
});

test("signing up can be closed, or need an invitation code", async () => {
  const closed = createApp(db, { accounts: { ...hosted, signup: "off" } });
  const refused = await call(closed, "POST", "/auth/signup", { body: { email: "a@b.example", org_name: "X" } });
  assert.deepEqual([refused.status, refused.body.code], [403, "signup_closed"]);
  // A link asked for while it was open creates nothing once it is closed.
  await post("/auth/signup", { email: "slow@c.example", org_name: "Closing" });
  const late = await call(closed, "POST", "/auth/verify", { body: { code: linksTo("slow@c.example")[0] } });
  assert.equal(late.body.code, "invalid_code");

  const invited = createApp(db, { accounts: { ...hosted, signupCode: "early-2026" } });
  assert.equal((await call(invited, "GET", "/auth/options")).body.inviteCode, true);
  const ask = (invite_code?: string) =>
    call(invited, "POST", "/auth/signup", { body: { email: "d@e.example", org_name: "D", invite_code } });
  assert.equal((await ask()).body.code, "invite_required");
  assert.equal((await ask("wrong")).body.code, "invite_required");
  assert.equal((await ask("early-2026")).status, 202);
});

test("the server says whether it is alive and whether it can reach its database", async () => {
  assert.deepEqual(await (await app.request("/healthz")).json(), { ok: true });
  assert.deepEqual(await (await app.request("/readyz")).json(), { ok: true });
});

test("the dashboard is served with a policy that lets nothing else run in it", async () => {
  const webRoot = mkdtempSync(join(tmpdir(), "sessionly-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Sessionly</title>");
  const served = createApp(db, { webRoot });
  const page = await served.request("/");
  assert.equal(page.status, 200);
  const policy = page.headers.get("content-security-policy") ?? "";
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
});

test("the environment sets how people get in", () => {
  const env = {
    SESSIONLY_HOSTED: "true",
    DATABASE_URL: "postgres://app@db.internal/sessionly",
    SMTP_URL: "smtp://user:pass@mail.example:2587",
    SESSIONLY_EMAIL_FROM: "Sessionly <sign-in@example.com>",
    SESSIONLY_PUBLIC_URL: "https://app.example.com",
  };
  assert.deepEqual(hostedProblems(env), []);
  const accounts = accountsFrom(env);
  assert.deepEqual(offers(accounts), { hosted: true, emailSignIn: true, signup: true, inviteCode: false });
  assert.equal(accounts.ratePerMinute, 600);
  assert.equal(offers(accountsFrom({ ...env, SESSIONLY_SIGNUP: "off" })).signup, false);
  assert.equal(offers(accountsFrom({ ...env, SESSIONLY_SIGNUP_CODE: "x" })).inviteCode, true);
  // A hosted service that could send no links is refused at the start.
  assert.match(hostedProblems({ ...env, SMTP_URL: "" }).join(), /SMTP_URL is not set/);
  // A single install: no limits, no signing up, and email only if it is set up.
  const single = accountsFrom({});
  assert.deepEqual(offers(single), { hosted: false, emailSignIn: false, signup: false, inviteCode: false });
  assert.equal(single.ratePerMinute, undefined);
  assert.throws(() => accountsFrom({ SESSIONLY_PUBLIC_URL: "app.example.com/x" }), /SESSIONLY_PUBLIC_URL/);
});

test("an organisation's id is readable and its own", () => {
  assert.match(orgIdFor("Acme, Inc."), /^acme-inc-[a-z0-9]{6}$/);
  assert.match(orgIdFor("Ünïcödé & Sons"), /^unicode-sons-[a-z0-9]{6}$/);
  assert.match(orgIdFor("!!!"), /^org-[a-z0-9]{6}$/);
  assert.match(orgIdFor("x".repeat(200)), /^x{40}-[a-z0-9]{6}$/);
  assert.notEqual(orgIdFor("Same"), orgIdFor("Same"));
});
