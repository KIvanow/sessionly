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
import { network, offers, orgIdFor, type Accounts } from "../src/signup.ts";
import { testDb, tokenFor } from "./helpers.ts";

let db: Db;
let app: Hono<Env>;
const sent: Mail[] = [];
const mailer = {
  send: async (mail: Mail) => {
    sent.push(mail);
  },
};
// What the server does after it has answered (looking an address up, sending
// it a link) is collected here, so that a test can wait for it.
const pending: Promise<void>[] = [];
const hosted: Accounts = {
  hosted: true,
  mailer,
  publicUrl: "https://app.test",
  trustProxy: true,
  defer: (work) => void pending.push(work()),
};
const settled = () => Promise.all(pending.splice(0));

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
  options: { token?: string; body?: unknown; from?: string; settle?: boolean } = {},
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
  if (options.settle !== false) await settled();
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
  assert.equal((await post("/auth/signup", { email: "Kay@Acme.example", org_name: "  Acme,   Inc " })).status, 202);
  assert.equal(await orgs(), before);
  assert.equal(sent.at(-1)?.to, "kay@acme.example");
  // The message goes to an address nobody has confirmed, so it carries
  // nothing its asker chose: not the name they gave.
  assert.match(sent.at(-1)?.text ?? "", /create your organisation on Sessionly/);
  assert.doesNotMatch(sent.at(-1)?.text ?? "", /Acme/);
  // What the link is for can be asked without using it.
  const what = await post("/auth/check", { code: linksTo("kay@acme.example")[0] });
  assert.deepEqual(what.body, { purpose: "signup", email: "kay@acme.example", org_name: "Acme, Inc" });
  assert.equal(await orgs(), before);

  const [code] = linksTo("kay@acme.example");
  const first = await post("/auth/verify", { code });
  assert.equal(first.status, 200);
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

  // The link worked once.
  const again = await post("/auth/verify", { code });
  assert.deepEqual([again.status, again.body.code], [400, "invalid_code"]);
  assert.equal((await post("/auth/check", { code })).body.code, "invalid_code");
  assert.equal(await orgs(), before + 1);
  for (const bad of ["", "nonsense", "x".repeat(300), 7]) {
    assert.equal((await post("/auth/verify", { code: bad })).status, 400);
  }
  // Bad requests are told so, and create nothing.
  assert.equal((await post("/auth/signup", { email: "not-an-address", org_name: "X" })).status, 400);
  // A name is letters, digits and a little punctuation: nothing that could
  // be a link or an address in a message that shows it.
  for (const name of ["", "x", "x".repeat(81), "visit evil.tld", "a/b", "see http://x", "me@there", "<b>bold</b>"]) {
    const refused = await post("/auth/signup", { email: "a@b.example", org_name: name });
    assert.deepEqual([refused.status, refused.body.code], [400, "bad_org_name"], JSON.stringify(name));
  }
  for (const name of ["Ab", "Müller & Söhne", "O'Neil (EU) 2", "R+D, Berlin"]) {
    assert.equal((await post("/auth/signup", { email: "a@b.example", org_name: name })).status, 202, name);
  }
});

test("two uses of one link at the same moment: one works", async () => {
  await post("/auth/signup", { email: "twice@race.example", org_name: "Race" });
  const [code] = linksTo("twice@race.example");
  const both = await Promise.all([post("/auth/verify", { code }), post("/auth/verify", { code })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  const [made] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs WHERE name = 'Race'`);
  assert.equal(Number(made?.n), 1);
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

  // A session that has run its week is nobody's.
  const week = await signIn("lee@lumen.example");
  await db.query(`UPDATE tokens SET expires_at = now() - interval '1 second' WHERE sign_in = 'email' AND expires_at > now() + interval '6 days 23 hours 59 minutes'`);
  assert.equal((await get("/me", week.token)).status, 401);

  // The answer does not wait for the address to be looked up, so it takes
  // no longer for one somebody has: nothing is sent yet when it arrives.
  const count2 = sent.length;
  const quick = await call(app, "POST", "/auth/email", { body: { email: "lee@lumen.example" }, settle: false });
  assert.equal(quick.status, 202);
  assert.equal(sent.length, count2);
  await settled();
  assert.equal(sent.length, count2 + 1);
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
  // Like the signup message, this one says nothing its sender chose.
  assert.match(sent.at(-1)?.text ?? "", /added this address to their organisation/);
  assert.doesNotMatch(sent.at(-1)?.text ?? "", /olive|Team\b/);
  // The page the link opens shows where it leads, before anything happens.
  const what = await post("/auth/check", { code: linksTo("mo@team.example")[0] });
  assert.deepEqual(what.body, { purpose: "sign_in", email: "mo@team.example", org_name: "Team" });
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

  // An admin may remove another admin.
  const samId = (await get("/users", owner.token)).body.users.find((u: any) => u.email === "sam@shop.example").id;
  assert.equal((await remove(samId, ada.token)).body.removed, true);
  // The link Sam was just sent is no use to him now, to look at or to use.
  const stale = linksTo("sam@shop.example")[0];
  assert.equal((await post("/auth/check", { code: stale })).body.code, "invalid_code");
  assert.equal((await post("/auth/verify", { code: stale })).body.code, "invalid_code");
});

test("a token issued to someone as they are removed is dead", async () => {
  const owner = await signUp("una@late.example", "Late");
  await post("/users", { email: "vic@late.example" }, owner.token);
  const vic = (await post("/auth/verify", { code: linksTo("vic@late.example")[0] })).body;
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

  // Addresses of one IPv6 network are one caller.
  for (let i = 0; i < 5; i++) {
    const answer = await call(app, "POST", "/auth/email", { body: { email: `b${i}@x.example` }, from: `2001:db8:7:7::${i + 1}` });
    assert.equal(answer.status, 202);
  }
  assert.equal((await call(app, "POST", "/auth/email", { body: { email: "b6@x.example" }, from: "2001:db8:7:7:ffff::9" })).status, 429);
  assert.equal((await call(app, "POST", "/auth/email", { body: { email: "b7@x.example" }, from: "2001:db8:7:8::1" })).status, 202);

  // Five links an hour to one address, whoever asks: the answer stays the same.
  await signUp("busy@inbox.example", "Inbox");
  const count = sent.length;
  for (let i = 0; i < 8; i++) assert.equal((await post("/auth/email", { email: "busy@inbox.example" })).status, 202);
  assert.equal(sent.length - count, 5);
  // Asking to sign up in someone's name does not use up their links to sign
  // in: each kind is counted on its own.
  await signUp("target@inbox.example", "Target");
  for (let i = 0; i < 8; i++) {
    assert.equal((await post("/auth/signup", { email: "target@inbox.example", org_name: "Noise" })).status, 202);
  }
  const before = sent.length;
  assert.equal((await post("/auth/email", { email: "target@inbox.example" })).status, 202);
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1)?.subject ?? "", /Sign in/);
  // Nor does asking for someone who has no account: nothing is sent, nothing counted.
  for (let i = 0; i < 8; i++) await post("/auth/email", { email: "later@inbox.example" });
  await signUp("later@inbox.example", "Later");
  const then = sent.length;
  await post("/auth/email", { email: "later@inbox.example" });
  assert.equal(sent.length, then + 1);

  // Without a proxy of its own in front, the server does not believe what a
  // caller says its address is: all of these count as one.
  const direct = createApp(db, { accounts: { ...hosted, trustProxy: false } });
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await call(direct, "POST", "/auth/email", { body: { email: `c${i}@x.example` }, from: `198.51.100.${i}` })).status);
  }
  assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);

  // All sign-ups together have a ceiling, however many addresses they come from.
  const capped = createApp(db, { accounts: { ...hosted, signupsPerHour: 2 } });
  await db.query(`DELETE FROM rate_counters WHERE key = 'signups'`);
  const asks = [];
  for (let i = 0; i < 3; i++) {
    asks.push(await call(capped, "POST", "/auth/signup", { body: { email: `d${i}@x.example`, org_name: "Capped" } }));
  }
  assert.deepEqual(asks.map((r) => r.status), [202, 202, 429]);
  assert.equal(asks[2]?.body.code, "signups_busy");

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

test("adding people is limited, since each is a message to an address nobody confirmed", async () => {
  const owner = await signUp("ivy@flood.example", "Flood");
  const add = (email: string) => post("/users", { email }, owner.token);
  const idOf = async (email: string) => (await get("/users", owner.token)).body.users.find((u: any) => u.email === email).id;
  // One address: adding it, removing it and adding it again is a message each time.
  const before = sent.filter((m) => m.to === "victim@elsewhere.example").length;
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const added = await add("victim@elsewhere.example");
    statuses.push(added.status);
    if (added.status === 201) await call(app, "DELETE", `/users/${await idOf("victim@elsewhere.example")}`, { token: owner.token });
  }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
  assert.equal(sent.filter((m) => m.to === "victim@elsewhere.example").length - before, 5);
  // The same address from another organisation is still the same address.
  const other = await signUp("jay@second.example", "Second");
  assert.equal((await post("/users", { email: "victim@elsewhere.example" }, other.token)).status, 429);

  // One organisation: thirty people an hour, whoever they are.
  const fresh = await signUp("kim@many.example", "Many");
  const many = [];
  for (let i = 0; i < 32; i++) many.push((await post("/users", { email: `p${i}@many.example` }, fresh.token)).status);
  assert.equal(many.filter((status) => status === 201).length, 30);
  assert.deepEqual(many.slice(30), [429, 429]);
  // A member's attempts, and nonsense, are refused without being counted.
  await db.query(`DELETE FROM rate_counters WHERE key LIKE 'invites:%' OR key LIKE 'invite:%'`);
  const admin2 = await signUp("lou@count.example", "Count");
  await post("/users", { email: "mem@count.example" }, admin2.token);
  const member = (await post("/auth/verify", { code: linksTo("mem@count.example")[0] })).body;
  for (let i = 0; i < 40; i++) await post("/users", { email: `x${i}@count.example` }, member.token);
  for (let i = 0; i < 40; i++) await post("/users", { email: "not an address" }, admin2.token);
  assert.equal((await post("/users", { email: "ok@count.example" }, admin2.token)).status, 201);
});

test("a message is sent only once what it links to is really there", async () => {
  const owner = await signUp("nat@commit.example", "Commit");
  // Already a user: the request fails and undoes itself, and sends nothing.
  await post("/users", { email: "dup@commit.example" }, owner.token);
  const count = sent.length;
  assert.equal((await post("/users", { email: "dup@commit.example" }, owner.token)).status, 409);
  assert.equal(sent.length, count);
});

test("nothing large is read from someone who is not signed in", async () => {
  const big = "x".repeat(20 * 1024);
  for (const path of ["/auth/email", "/auth/signup", "/auth/verify", "/auth/check"]) {
    const answer = await call(app, "POST", path, { body: { email: "a@b.example", org_name: big, code: big } });
    assert.equal(answer.status, 413, path);
  }
});

test("requests may add a link and nothing more to what is kept outside organisations", async () => {
  const granted = await db.query<{ name: string; can: string }>(
    `SELECT c.relname AS name,
            concat_ws(',',
              CASE WHEN has_table_privilege(r.role, c.oid, 'SELECT') THEN 'select' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'INSERT') THEN 'insert' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'UPDATE') THEN 'update' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'DELETE') THEN 'delete' END) AS can
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
          (SELECT left('sessionly_app_' || current_database(), 63) AS role) r
     WHERE n.nspname = 'public' AND c.relname IN ('users', 'login_codes', 'rate_counters')`,
  );
  assert.deepEqual(Object.fromEntries(granted.map((t) => [t.name, t.can])), {
    users: "select,insert,update,delete",
    login_codes: "insert",
    rate_counters: "",
  });
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
    call(invited, "POST", "/auth/signup", { body: { email: "d@e.example", org_name: "Dee", invite_code } });
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

test("an IPv6 caller is counted by its network, an IPv4 caller by its address", () => {
  assert.equal(network("203.0.113.9"), "203.0.113.9");
  assert.equal(network("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(network("2001:0DB8:0001:0002::1"), "2001:db8:1:2::/64");
  assert.equal(network("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(network("::1"), "0:0:0:0::/64");
  assert.equal(network("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(network("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(network("unknown"), "unknown");
});

test("an organisation's id is readable and its own", () => {
  assert.match(orgIdFor("Acme, Inc"), /^acme-inc-[a-z0-9]{6}$/);
  assert.match(orgIdFor("Ünïcödé & Sons"), /^unicode-sons-[a-z0-9]{6}$/);
  assert.match(orgIdFor("!!!"), /^org-[a-z0-9]{6}$/);
  assert.match(orgIdFor("x".repeat(200)), /^x{40}-[a-z0-9]{6}$/);
  assert.notEqual(orgIdFor("Same"), orgIdFor("Same"));
});
