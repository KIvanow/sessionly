// Signing up, signing in by email, and the people of an organisation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import { APP_ROLE, migrationAt, openDb, type Db } from "../src/db.ts";
import { tidy } from "../src/limits.ts";
import { MailProblem, resendMailer, type Mail } from "../src/mail.ts";
import { accountsFrom, background, hostedProblems, outdated } from "../src/run.ts";
import { emailFrom, mailbox, network, offers, orgIdFor, orgNameFrom, widerNetwork, type Accounts } from "../src/signup.ts";
import { testDb, testDbUrl, tokenFor } from "./helpers.ts";

let db: Db;
let app: Hono<Env>;
const sent: Mail[] = [];
// Set by a test to have messages fail to go out, as when the mail service is down.
let mailDown = false;
const mailer = {
  send: async (mail: Mail) => {
    if (mailDown) throw new Error("Resend did not take the message (503 service_unavailable)");
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
    "x-forwarded-for": options.from ?? `10.${Math.floor(++caller / 250)}.${caller % 250}.1`,
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
  assert.deepEqual(what.body, {
    purpose: "signup",
    email: "kay@acme.example",
    org_name: "Acme, Inc",
    org_id: null,
    first_time: false,
    invited_by: null,
    invited_via: null,
  });
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
  assert.match(text, /Each link is for one organisation/);
  assert.ok(text.indexOf("First Co:") < text.indexOf("Second Co:"));
  const codes = linksTo("pat@both.example");
  assert.equal(codes.length, 2);
  // What a link is for says which organisation, by its id too: a name is
  // not enough to tell one by.
  const what = await post("/auth/check", { code: codes[1] });
  assert.deepEqual(what.body, {
    purpose: "sign_in",
    email: "pat@both.example",
    org_name: "Second Co",
    org_id: two.org.id,
    first_time: false,
    invited_by: null,
    invited_via: null,
  });
  const into = await Promise.all(codes.map((code) => post("/auth/verify", { code })));
  assert.deepEqual(into.map((s) => s.body.org.name), ["First Co", "Second Co"]);
  // Each session is of its own organisation.
  assert.equal((await get("/me", into[0]?.body.token)).body.org, one.org.id);
  assert.equal((await get("/me", into[1]?.body.token)).body.org, two.org.id);
});

test("a message to sign in names no organisation the person has not signed in to", async () => {
  // Anyone can make an organisation, call it anything the rule allows, and
  // add an address to it.
  const name = "Call 0800 123 4567 to stop the 499 USD charge";
  const attacker = await signUp("mal@attacker.example", name);
  const added = await post("/users", { email: "vic@victim.example" }, attacker.token);
  assert.equal(added.status, 201);
  assert.doesNotMatch(sent.at(-1)?.text ?? "", /0800|attacker/);
  // Then asks for a link to sign in, in the victim's name.
  const before = sent.length;
  assert.equal((await post("/auth/email", { email: "vic@victim.example" })).status, 202);
  assert.equal(sent.length, before + 1);
  const mail = sent.at(-1);
  assert.equal(mail?.to, "vic@victim.example");
  assert.doesNotMatch(`${mail?.subject} ${mail?.text}`, /0800|499|Call|attacker/);
  assert.match(mail?.text ?? "", /^Sign in to Sessionly:/);
  // The page the link opens does say, with who added them.
  const what = await post("/auth/check", { code: linksTo("vic@victim.example")[0] });
  assert.deepEqual(
    [what.body.org_name, what.body.org_id, what.body.first_time, what.body.invited_by],
    [name, attacker.org.id, true, "mal@attacker.example"],
  );

  // With an organisation of their own that they have signed in to: its name
  // is given, and the other's still is not.
  await signUp("vic@victim.example", "Victim and Co");
  await db.query(`DELETE FROM login_codes`);
  await post("/auth/email", { email: "vic@victim.example" });
  const both = sent.at(-1)?.text ?? "";
  assert.match(both, /An organisation you have not signed in to before:\nhttps/);
  assert.match(both, /Victim and Co:\nhttps/);
  assert.doesNotMatch(both, /0800/);
  // Once they have used a link of the first, it is one they know.
  assert.equal((await post("/auth/verify", { code: linksTo("vic@victim.example")[0] })).body.org.id, attacker.org.id);
  await db.query(`DELETE FROM login_codes`);
  await post("/auth/email", { email: "vic@victim.example" });
  assert.match(sent.at(-1)?.text ?? "", /0800/);
  const known = await post("/auth/check", { code: linksTo("vic@victim.example")[0] });
  assert.deepEqual([known.body.first_time, known.body.invited_by], [false, null]);
});

test("who added someone is shown only if that is known, not on a token's word", async () => {
  // Anyone can make an organisation, and its admin can make a token in any
  // address and any name.
  const attacker = await signUp("mal@lookalike.example", "Acme");
  const made = await post("/tokens", { email: "it-admin@acme.example", name: "IT Admin (it-admin@acme.example)", role: "admin" }, attacker.token);
  assert.equal(made.status, 201);
  // (A token's address is at least a plain address.)
  for (const email of ['"it admin"@acme.example', "it-admin\u200b@acme.example", "nope"]) {
    assert.equal((await post("/tokens", { email, role: "admin" }, attacker.token)).status, 400, email);
  }
  // Adding the victim with that token does not make the token's address
  // "who added you": the page is told a token did, and no address or name.
  assert.equal((await post("/users", { email: "victim@acme.example" }, made.body.token)).status, 201);
  const what = await post("/auth/check", { code: linksTo("victim@acme.example")[0] });
  assert.deepEqual(
    [what.body.first_time, what.body.invited_by, what.body.invited_via],
    [true, null, "token"],
  );
  assert.doesNotMatch(JSON.stringify(what.body), /it-admin|IT Admin/);
  // Added by the same person signed in, it is their own, confirmed address.
  assert.equal((await post("/users", { email: "second@acme.example" }, attacker.token)).status, 201);
  const honest = await post("/auth/check", { code: linksTo("second@acme.example")[0] });
  assert.deepEqual([honest.body.invited_by, honest.body.invited_via], ["mal@lookalike.example", "sign_in"]);
  // Brought back by a token after having been added by a person: the token's word again.
  const id = (await get("/users", attacker.token)).body.users.find((u: any) => u.email === "second@acme.example").id;
  await call(app, "DELETE", `/users/${id}`, { token: attacker.token });
  assert.equal((await post("/users", { email: "second@acme.example" }, made.body.token)).status, 201);
  const again = await post("/auth/check", { code: linksTo("second@acme.example")[0] });
  assert.deepEqual([again.body.invited_by, again.body.invited_via], [null, "token"]);
});

test("a message that could not be sent holds nothing back and uses nothing up", async () => {
  const counted = async (like: string) =>
    (await db.query<{ key: string; n: number }>(`SELECT key, n FROM rate_counters WHERE key LIKE $1 AND n > 0 ORDER BY key`, [like])).map((r) => `${r.key}=${r.n}`);
  const links = async (purpose: string) =>
    Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM login_codes WHERE purpose = $1`, [purpose]))[0]?.n);
  const owner = await signUp("flo@outage.example", "Outage");
  await db.query(`DELETE FROM login_codes`);
  await db.query(`DELETE FROM rate_counters`);
  const error = console.error;
  const logged: string[] = [];
  console.error = (...line: unknown[]) => void logged.push(line.join(" "));
  try {
    mailDown = true;
    // A link to sign in: asked for, not sent. Nothing is kept of it.
    assert.equal((await post("/auth/email", { email: "flo@outage.example" })).status, 202);
    assert.equal(await links("sign_in"), 0);
    assert.deepEqual(await counted("signin%"), []);
    // What is logged names the domain, not the address.
    assert.match(logged.join("\n"), /email to …@outage\.example was not sent/);
    assert.doesNotMatch(logged.join("\n"), /flo@/);
    // A link to finish signing up.
    assert.equal((await post("/auth/signup", { email: "new@outage.example", org_name: "Later" })).status, 202);
    assert.equal(await links("signup"), 0);
    // (What the caller's own network asked for is theirs, and stays counted.)
    assert.deepEqual((await counted("signup%")).map((kept) => kept.split(":")[0]), ["signups-from"]);
    // An invitation: the person is added, the link and the counts are not kept.
    assert.equal((await post("/users", { email: "added@outage.example" }, owner.token)).status, 201);
    assert.equal(await links("invite"), 0);
    assert.deepEqual(await counted("invite%"), []);
    mailDown = false;
    // The mail service is back: the very next ask sends, with nothing to wait out.
    const before = sent.length;
    await post("/auth/email", { email: "flo@outage.example" });
    await post("/auth/signup", { email: "new@outage.example", org_name: "Later" });
    await post("/auth/email", { email: "added@outage.example" });
    assert.deepEqual(sent.slice(before).map((m) => m.to), ["flo@outage.example", "new@outage.example", "added@outage.example"]);
  } finally {
    mailDown = false;
    console.error = error;
  }
});

test("spellings of a mailbox that nobody confirmed cannot use up its owner's links", async () => {
  await signUp("ann.owner@gmail.com", "Ann and Co");
  const attacker = await signUp("eve@variants.example", "Variants");
  // Twelve spellings of Ann's mailbox, added to an organisation of the
  // attacker's (over hours: five invitations an hour go to one mailbox).
  for (let i = 1; i <= 13; i++) {
    await db.query(`DELETE FROM rate_counters WHERE key LIKE 'invite%'`);
    assert.equal((await post("/users", { email: `annowner+${i}@gmail.com` }, attacker.token)).status, 201);
  }
  await db.query(`DELETE FROM login_codes`);
  await db.query(`DELETE FROM rate_counters`);
  // Links asked for to all of them: twelve go out, and then no more.
  const before = sent.length;
  for (let i = 1; i <= 13; i++) await post("/auth/email", { email: `annowner+${i}@gmail.com` });
  assert.equal(sent.length - before, 12);
  // Ann's own address, which she has signed in with, still gets hers.
  await post("/auth/email", { email: "ann.owner@gmail.com" });
  assert.equal(sent.at(-1)?.to, "ann.owner@gmail.com");
  assert.equal(sent.length - before, 13);
});

test("asking in someone's name does not leave them without a link that works", async () => {
  await signUp("dana@steady.example", "Steady");
  await db.query(`DELETE FROM login_codes`);
  // Asked for twenty times by someone else: one message, not twenty.
  const before = sent.length;
  for (let i = 0; i < 20; i++) assert.equal((await post("/auth/email", { email: "dana@steady.example" })).status, 202);
  assert.equal(sent.length, before + 1);
  // Dana asks too: the link already in her inbox works, so no second one.
  await post("/auth/email", { email: "dana@steady.example" });
  assert.equal(sent.length, before + 1);
  assert.equal((await post("/auth/verify", { code: linksTo("dana@steady.example")[0] })).status, 200);
  // Used, or run out: the next ask sends one. Round after round, for hours
  // of the other's asking, she is never refused one.
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 6; i++) await post("/auth/email", { email: "dana@steady.example" });
    assert.equal(sent.length, before + 2 + round, `round ${round}`);
    await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 second'`);
    await db.query(`UPDATE rate_counters SET window_start = window_start - interval '15 minutes' WHERE key LIKE 'signin:%'`);
  }
  // A link sent on being added is not one that was asked for: it does not
  // hold back the link to an organisation of one's own.
  const other = await signUp("eve@elsewhere.example", "Elsewhere");
  await db.query(`DELETE FROM login_codes`);
  assert.equal((await post("/users", { email: "dana@steady.example" }, other.token)).status, 201);
  const then = sent.length;
  await post("/auth/email", { email: "dana@steady.example" });
  assert.equal(sent.length, then + 1);
  assert.equal(linksTo("dana@steady.example").length, 2);
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
  assert.deepEqual(what.body, {
    purpose: "invite",
    email: "mo@team.example",
    org_name: "Team",
    org_id: owner.org.id,
    first_time: true,
    invited_by: "olive@team.example",
    invited_via: "sign_in",
  });
  const mo = await post("/auth/verify", { code: linksTo("mo@team.example")[0] });
  assert.deepEqual([mo.body.org.id, mo.body.role], [owner.org.id, "member"]);
  // A member manages nobody.
  assert.equal((await get("/users", mo.body.token)).status, 403);
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

  // Five links an hour to finish signing up go to one mailbox, whoever
  // asks and however the address is spelt: the answer stays the same.
  const spellings = ["busy.box@gmail.com", "busybox+a@gmail.com", "b.u.s.y.box+b@googlemail.com", "BusyBox@Gmail.com"];
  const count = sent.length;
  for (let i = 0; i < 8; i++) {
    const email = spellings[i % spellings.length];
    assert.equal((await post("/auth/signup", { email, org_name: "Busy" })).status, 202);
  }
  assert.equal(sent.length - count, 5);
  // Each went to the address as it was typed.
  assert.deepEqual(sent.slice(count).map((m) => m.to).slice(0, 3), ["busy.box@gmail.com", "busybox+a@gmail.com", "b.u.s.y.box+b@googlemail.com"]);
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

  // All sign-up messages together have a ceiling, however many addresses
  // and networks they are asked from.
  const capped = createApp(db, { accounts: { ...hosted, signupsPerHour: 7 } });
  const ask = (email: string, from?: string) => call(capped, "POST", "/auth/signup", { body: { email, org_name: "Capped" }, from });
  await db.query(`DELETE FROM rate_counters WHERE key LIKE 'signups%'`);
  // Asking again and again for one address is not what reaches it: only
  // messages that go out count, and that address gets five.
  const sentBefore = sent.length;
  for (let i = 0; i < 20; i++) assert.equal((await ask("again@x.example")).status, 202);
  assert.equal(sent.length - sentBefore, 5);
  const [{ n: counted } = { n: 0 }] = await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = 'signups'`);
  assert.equal(Number(counted), 5);
  for (const email of ["c1@x.example", "c2@x.example"]) assert.equal((await ask(email)).status, 202);
  // Reached, it says so to the next address, and (once) to whoever runs the server.
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => void warned.push(line);
  try {
    for (const email of ["d1@x.example", "d2@x.example"]) {
      const refused = await ask(email);
      assert.deepEqual([refused.status, refused.body.code], [429, "signups_busy"]);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0] ?? "", /ceiling of 7 sign-up messages an hour is reached/);
  // A refusal there does not count against the address either.
  assert.equal((await db.query(`SELECT 1 FROM rate_counters WHERE key = 'signup:d1@x.example' AND n > 0`)).length, 0);

  // One network asks for so many sign-ups an hour (five here, ten unless
  // set), whichever of its addresses asks and whoever for. The next network
  // is not held up by it.
  await db.query(`DELETE FROM rate_counters WHERE key LIKE 'signups%'`);
  const five = createApp(db, { accounts: { ...hosted, signupsPerNetwork: 5 } });
  const fromOne = [];
  for (let i = 0; i < 7; i++) fromOne.push((await call(five, "POST", "/auth/signup", { body: { email: `n${i}@x.example`, org_name: "Net" }, from: `198.18.7.${i + 1}` })).status);
  assert.deepEqual(fromOne, [202, 202, 202, 202, 202, 429, 429]);
  assert.equal((await call(five, "POST", "/auth/signup", { body: { email: "n8@x.example", org_name: "Net" }, from: "198.18.8.1" })).status, 202);
  const fromSite = [];
  for (let i = 0; i < 6; i++) fromSite.push((await call(five, "POST", "/auth/signup", { body: { email: `s${i}@x.example`, org_name: "Site" }, from: `2001:db8:9:${i}::1` })).status);
  assert.deepEqual(fromSite, [202, 202, 202, 202, 202, 429]);
  const unset = [];
  for (let i = 0; i < 11; i++) unset.push((await call(app, "POST", "/auth/signup", { body: { email: `u${i}@x.example`, org_name: "Net" }, from: `198.18.10.${i + 1}` })).status);
  assert.deepEqual(unset.slice(8), [202, 202, 429]);
  // Requests that are refused for what they say are not counted there.
  for (let i = 0; i < 4; i++) await call(app, "POST", "/auth/signup", { body: { email: "nope", org_name: "Net" }, from: "198.18.9.1" });
  assert.equal((await call(app, "POST", "/auth/signup", { body: { email: "n9@x.example", org_name: "Net" }, from: "198.18.9.2" })).status, 202);

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
  // Adding someone who is already there sends nothing, so it is not
  // counted: it cannot use up what their address may be sent.
  await db.query(`DELETE FROM rate_counters WHERE key LIKE 'invites:%' OR key LIKE 'invite:%'`);
  const again = await signUp("moe@again.example", "Again");
  assert.equal((await post("/users", { email: "here@again.example" }, again.token)).status, 201);
  for (let i = 0; i < 40; i++) {
    assert.equal((await post("/users", { email: "here@again.example" }, again.token)).status, 409);
  }
  const kept = await db.query<{ key: string; n: number }>(`SELECT key, n FROM rate_counters WHERE key LIKE 'invite%' ORDER BY key`);
  assert.deepEqual(kept.map((row) => [row.key, Number(row.n)]), [["invite:here@again.example", 1], [`invites:${again.org.id}`, 1]]);
  // Addresses that lead to one mailbox are counted as that mailbox.
  const boxes = [];
  for (const email of ["dot.ty@gmail.com", "dotty+1@gmail.com", "d.otty@googlemail.com", "dotty+2@gmail.com", "do.tty@gmail.com", "dotty@gmail.com"]) {
    boxes.push((await post("/users", { email }, again.token)).status);
  }
  assert.deepEqual(boxes, [201, 201, 201, 201, 201, 429]);
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
          (SELECT ${APP_ROLE} AS role) r
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
    RESEND_API_KEY: "re_test",
    SESSIONLY_EMAIL_FROM: "Sessionly <sign-in@example.com>",
    SESSIONLY_PUBLIC_URL: "https://app.example.com",
  };
  assert.deepEqual(hostedProblems(env), []);
  const accounts = accountsFrom(env);
  assert.deepEqual(offers(accounts), { hosted: true, emailSignIn: true, signup: true, inviteCode: false });
  assert.equal(accounts.ratePerMinute, 600);
  assert.equal(accounts.signupsPerHour, undefined);
  assert.equal(accountsFrom({ ...env, SESSIONLY_SIGNUPS_PER_HOUR: "20" }).signupsPerHour, 20);
  assert.equal(accountsFrom({ ...env, SESSIONLY_SIGNUPS_PER_HOUR: "lots" }).signupsPerHour, undefined);
  assert.equal(offers(accountsFrom({ ...env, SESSIONLY_SIGNUP: "off" })).signup, false);
  assert.equal(offers(accountsFrom({ ...env, SESSIONLY_SIGNUP_CODE: "x" })).inviteCode, true);
  // A hosted service that could send no links is refused at the start.
  assert.match(hostedProblems({ ...env, RESEND_API_KEY: "" }).join(), /RESEND_API_KEY is not set/);
  // A single install: no limits, no signing up, and email only if it is set up.
  const single = accountsFrom({});
  assert.deepEqual(offers(single), { hosted: false, emailSignIn: false, signup: false, inviteCode: false });
  assert.equal(single.ratePerMinute, undefined);
  assert.throws(() => accountsFrom({ SESSIONLY_PUBLIC_URL: "app.example.com/x" }), /SESSIONLY_PUBLIC_URL/);
});

test("a message goes to Resend once, however often it has to be offered", async () => {
  // What Resend is asked, and what this stand-in for it answers in turn.
  const asked: { url: string; headers: Record<string, string>; body: any }[] = [];
  const waited: number[] = [];
  const resend = (...answers: (Response | Error)[]) =>
    resendMailer("re_secret_key", "Sessionly <sign-in@example.com>", {
      fetch: (async (url: string, init: RequestInit) => {
        asked.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        const answer = answers.shift() ?? new Error("nothing left to answer");
        if (answer instanceof Error) throw answer;
        return answer;
      }) as typeof fetch,
      wait: async (ms) => void waited.push(ms),
    });
  const says = (status: number, name: string, message: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ statusCode: status, name, message }), { status, headers });
  const taken = () => new Response(JSON.stringify({ id: "49a3999c" }), { status: 200 });
  const mail = { to: "ann@example.com", subject: "Sign in to Sessionly", text: "https://app.test/#login=abc" };

  // Taken at once: one request, saying who asks, with the key and the message as it is.
  await resend(taken()).send(mail);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.url, "https://api.resend.com/emails");
  assert.equal(asked[0]?.headers.authorization, "Bearer re_secret_key");
  assert.ok(asked[0]?.headers["user-agent"]);
  assert.deepEqual(asked[0]?.body, { from: "Sessionly <sign-in@example.com>", to: ["ann@example.com"], subject: mail.subject, text: mail.text });

  // Too many requests, then a failure on Resend's side, then no answer at
  // all: offered again each time under the same idempotency key, so that
  // Resend sends it once whichever of the offers it took.
  for (const first of [says(429, "rate_limit_exceeded", "Too many requests", { "retry-after": "1" }), says(500, "application_error", "An unexpected error occurred"), new Error("socket hang up")]) {
    asked.length = 0;
    waited.length = 0;
    await resend(first, taken()).send(mail);
    assert.equal(asked.length, 2);
    assert.equal(asked[0]?.headers["idempotency-key"], asked[1]?.headers["idempotency-key"]);
    assert.match(asked[0]?.headers["idempotency-key"] ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(waited.length, 1);
  }
  // As long as Resend says to wait, when it says.
  assert.deepEqual(waited, [500]);
  asked.length = 0;
  waited.length = 0;
  await resend(says(429, "rate_limit_exceeded", "Too many requests", { "retry-after": "2" }), taken()).send(mail);
  assert.deepEqual(waited, [2000]);
  // Another message has another key.
  const keyBefore = asked[0]?.headers["idempotency-key"];
  asked.length = 0;
  await resend(taken()).send(mail);
  assert.notEqual(asked[0]?.headers["idempotency-key"], keyBefore);

  // Three offers at most.
  asked.length = 0;
  await assert.rejects(
    resend(says(503, "service_unavailable", "down"), says(503, "service_unavailable", "down"), says(503, "service_unavailable", "down"), taken()).send(mail),
    (err: MailProblem) => err.status === 503 && err.code === "service_unavailable",
  );
  assert.equal(asked.length, 3);
  await assert.rejects(resend(new Error("a"), new Error("b"), new Error("no route to host")).send(mail), /Resend was not reached: no route to host/);

  // What is refused for what it is, is not offered again: a domain that is
  // not verified, a quota used up, a key that is not valid.
  for (const [status, name, message] of [
    [403, "validation_error", "The example.com domain is not verified. Please, add and verify your domain."],
    [429, "daily_quota_exceeded", "You have exceeded your daily email sending quota."],
    [401, "validation_error", "API key is invalid"],
  ] as const) {
    asked.length = 0;
    await assert.rejects(resend(says(status, name, message), taken()).send(mail), (err: MailProblem) => {
      assert.deepEqual([err.status, err.code], [status, name]);
      assert.ok(err.message.includes(message), err.message);
      return true;
    });
    assert.equal(asked.length, 1, name);
  }
  // What is logged of a refusal names no one, and never has the key in it.
  await assert.rejects(
    resend(says(403, "validation_error", "You can only send testing emails to your own email address (owner@corp.example).")).send(mail),
    (err: MailProblem) => {
      assert.match(err.message, /…@corp\.example/);
      assert.doesNotMatch(err.message, /owner@|ann@|re_secret_key/);
      return true;
    },
  );
});

test("people from before sign-ins were noted are known to have signed in", async (t) => {
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-confirmed-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const url = folder ? `file:${join(folder, "db")}` : fresh;
  // As a server just before this one left it: nobody's first sign-in noted.
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
  const now = await openDb(url);
  try {
    const rows = await now.query<{ id: string; known: boolean }>(
      `SELECT id, confirmed_at IS NOT NULL AS known FROM users WHERE org_id = 'old-org' ORDER BY id`,
    );
    // The owner signed up by a link; one member has had a session; the
    // other only a token for a machine, which says nothing of the address.
    assert.deepEqual(rows.map((r) => [r.id, r.known]), [["usr_never", false], ["usr_owner", true], ["usr_seen", true]]);
  } finally {
    await now.close();
  }
});

test("a setting that no longer does anything is said at the start", () => {
  assert.match(outdated({ SMTP_URL: "smtp://mail.example" }).join(), /SMTP_URL is set, but email is sent through Resend now/);
  assert.deepEqual(outdated({ SMTP_URL: "smtp://mail.example", RESEND_API_KEY: "re_test" }), []);
  assert.deepEqual(outdated({}), []);
  assert.equal(accountsFrom({ SESSIONLY_SIGNUPS_PER_NETWORK: "25" }).signupsPerNetwork, 25);
});

test("stopping waits for messages that are on their way out, for a while", async () => {
  const after = background();
  let done = 0;
  after.defer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    done++;
  });
  after.defer(async () => {
    throw new Error("a send that failed");
  });
  const error = console.error;
  console.error = () => {};
  try {
    await after.idle(2000);
  } finally {
    console.error = error;
  }
  assert.equal(done, 1);
  // Not for ever: one that hangs is left behind.
  after.defer(() => new Promise(() => {}));
  const began = Date.now();
  await after.idle(60);
  assert.ok(Date.now() - began < 1000);
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

test("by the hour a caller is counted by a wider network", () => {
  assert.equal(widerNetwork("203.0.113.9"), "203.0.113.0/24");
  assert.equal(widerNetwork("::ffff:203.0.113.9"), "203.0.113.0/24");
  assert.equal(widerNetwork("2001:db8:1:2:3:4:5:6"), "2001:db8:1::/48");
  assert.equal(widerNetwork("2001:0DB8:0001::1"), "2001:db8:1::/48");
  assert.equal(widerNetwork("unknown"), "unknown");
});

test("an address is taken in one plain form, or not at all", () => {
  assert.equal(emailFrom("  Kay@Acme.Example "), "kay@acme.example");
  assert.equal(emailFrom("o'brien+tag@example.co.uk"), "o'brien+tag@example.co.uk");
  // One domain however it is written: a trailing dot, fullwidth letters, its own script.
  assert.equal(emailFrom("ann@example.com."), "ann@example.com");
  assert.equal(emailFrom("ann@ｅｘａｍｐｌｅ.com"), "ann@example.com");
  assert.equal(emailFrom("ann@bücher.example"), "ann@xn--bcher-kva.example");
  // What makes one mailbox many addresses, or is no address.
  for (const odd of [
    '"ann"@example.com',
    "an n@example.com",
    "ann\u200b@example.com",
    "ａｎｎ@example.com",
    "änn@example.com",
    ".ann@example.com",
    "ann.@example.com",
    "a..nn@example.com",
    "ann@example",
    "ann@",
    "@example.com",
    "ann",
    "",
    `${"x".repeat(250)}@example.com`,
    42,
    null,
  ]) {
    assert.equal(emailFrom(odd), null, String(odd));
  }
});

test("addresses that lead to one mailbox are counted as one", () => {
  assert.equal(mailbox("Ann.Lee+work@Example.com"), "ann.lee@example.com");
  assert.equal(mailbox("ann.lee+a+b@gmail.com"), "annlee@gmail.com");
  assert.equal(mailbox("a.n.n.l.e.e@googlemail.com"), "annlee@gmail.com");
  assert.equal(mailbox("+tag@example.com"), "+tag@example.com");
  assert.equal(mailbox("plain@example.com"), "plain@example.com");
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
