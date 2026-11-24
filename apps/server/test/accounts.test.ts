// How people get into a server of your own: its dashboard opens without
// signing in, and machines come with tokens. Signing in and signing up with
// Google or GitHub are the hosted service's (ee/test/hosted/signup.test.ts).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { createApp, type Env } from "../src/app.ts";
import { APP_ROLE, type Db } from "../src/db.ts";
import { giveBack, network, take, widerNetwork } from "../src/limits.ts";
import { accountsFrom, notHostedProblems, unheeded } from "../src/run.ts";
import { emailFrom } from "../src/users.ts";
import { testDb } from "./helpers.ts";

let db: Db;
let app: Hono<Env>;

before(async () => {
  db = await testDb();
  app = createApp(db, {});
});
after(() => db.close());

async function call(server: Hono<Env>, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await server.request(`/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

test("a server of your own opens its dashboard as its admin, and a hosted service does not", async () => {
  const own = createApp(db, { accounts: { admin: "kris@example.com" } });
  assert.deepEqual((await call(own, "GET", "/auth/options")).body, {
    hosted: false,
    noSignIn: true,
    providers: [],
    signup: false,
    inviteCode: false,
    publicUrl: null,
  });
  // Signing in with a provider is the hosted service's: here it is no route that needs no token.
  assert.equal((await own.request("/api/v1/auth/google")).status, 401);
  const opened = await call(own, "POST", "/auth/open", { body: {} });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual([opened.body.org.id, opened.body.email, opened.body.role, opened.body.created], ["default", "kris@example.com", "admin", false]);
  assert.ok(Date.parse(opened.body.expires_at) > Date.now() + 6 * 86_400_000);
  // As the admin, and the owner, as the admin token is: nobody vouched for the address.
  const me = await call(own, "GET", "/me", { token: opened.body.token });
  assert.deepEqual([me.body.role, me.body.owner, me.body.signed_in, me.body.opened], ["admin", true, false, true]);
  // It is no token of the Team page's, and it ends as a sign-in does.
  const listed = await call(own, "GET", "/tokens", { token: opened.body.token });
  assert.ok(!listed.body.tokens.some((t: { email: string }) => t.email === "kris@example.com"));
  // Without the address, it is the admin's of the environment.
  assert.equal((await call(createApp(db, {}), "POST", "/auth/open", { body: {} })).body.email, "admin@localhost");
  // The rest of the API still takes a token: an upload without one is refused.
  assert.equal((await call(own, "GET", "/sessions")).status, 401);
  // Asked by the dashboard only: another site cannot have one made.
  const elsewhere = await own.request("/api/v1/auth/open", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: "{}",
  });
  assert.equal(elsewhere.status, 403);
  // A person from before under the admin's own address is the dashboard itself: not removed by it.
  const selfId = `u_self_${Date.now()}`;
  await db.asOrg("default", (tx) =>
    tx.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, 'default', 'kris@example.com', 'admin')`, [selfId]),
  );
  const removed = await call(own, "DELETE", `/users/${selfId}`, { token: opened.body.token });
  assert.deepEqual([removed.status, removed.body.code], [409, "not_yourself"]);
  await db.asOrg("default", (tx) => tx.query(`UPDATE users SET removed_at = now() WHERE id = $1`, [selfId]));
  const out = await call(own, "DELETE", "/auth/session", { token: opened.body.token });
  assert.equal(out.status, 200);
  assert.equal((await call(own, "GET", "/me", { token: opened.body.token })).status, 401);
});

test("a server is a hosted service only when SESSIONLY_HOSTED says so plainly", () => {
  assert.deepEqual(notHostedProblems({}), []);
  assert.deepEqual(notHostedProblems({ SESSIONLY_HOSTED: "true", SESSIONLY_SIGNUP: "open" }), []);
  assert.deepEqual(notHostedProblems({ SESSIONLY_HOSTED: "false" }), []);
  for (const said of ["TRUE", "1", "yes", " true"]) {
    assert.match(notHostedProblems({ SESSIONLY_HOSTED: said }).join(), /SESSIONLY_HOSTED is/, said);
  }
  // A hosted service's settings without it would open the dashboard to anyone.
  assert.match(
    notHostedProblems({ SESSIONLY_SIGNUP: "open", SESSIONLY_SIGNUPS_PER_HOUR: "100" }).join(),
    /SESSIONLY_SIGNUP and SESSIONLY_SIGNUPS_PER_HOUR are set/,
  );
});

test("a count is given back to the hour it was taken in", async () => {
  // Taken a moment before the hour turned, for a message given up on a
  // moment after: the hour that has begun counts other messages.
  const [last] = await db.query<{ at: string }>(
    `INSERT INTO rate_counters (key, window_start, n)
     VALUES ('signup:late@hour.example', to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600) - interval '1 hour', 3)
     RETURNING window_start::text AS at`,
  );
  const now = await take(db, "signup:late@hour.example", 3600, 5);
  assert.ok(last && now);
  assert.notEqual(now.window, last.at);
  await giveBack(db, { key: "signup:late@hour.example", window: last.at });
  const counts = await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = 'signup:late@hour.example' ORDER BY window_start`);
  assert.deepEqual(counts.map((row) => row.n), [2, 1]);
  // And what was taken now goes back to now.
  await giveBack(db, now);
  const then = await db.query<{ n: number }>(`SELECT n FROM rate_counters WHERE key = 'signup:late@hour.example' ORDER BY window_start`);
  assert.deepEqual(then.map((row) => row.n), [2, 0]);
});


test("requests can do nothing with what is kept outside organisations", async () => {
  const granted = await db.query<{ name: string; can: string }>(
    `SELECT c.relname AS name,
            concat_ws(',',
              CASE WHEN has_table_privilege(r.role, c.oid, 'SELECT') THEN 'select' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'INSERT') THEN 'insert' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'UPDATE') THEN 'update' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'DELETE') THEN 'delete' END) AS can
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
          (SELECT ${APP_ROLE} AS role) r
     WHERE n.nspname = 'public' AND c.relname IN ('users', 'login_codes', 'sign_in_codes', 'rate_counters')`,
  );
  // The links that were sent before are gone, table and all.
  assert.deepEqual(Object.fromEntries(granted.map((t) => [t.name, t.can])), {
    users: "select,insert,update,delete",
    sign_in_codes: "",
    rate_counters: "",
  });
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
  // A server of your own: no limit unless one is set, and its dashboard is the admin's.
  assert.deepEqual(accountsFrom({}), { admin: undefined, trustProxy: false, ratePerMinute: undefined });
  const own = accountsFrom({ SESSIONLY_ADMIN_EMAIL: " kris@example.com ", SESSIONLY_TRUST_PROXY: "true", SESSIONLY_RATE_PER_MINUTE: "50" });
  assert.deepEqual(own, { admin: "kris@example.com", trustProxy: true, ratePerMinute: 50 });
  // A count is a whole number above 0, in plain digits. Anything else is
  // as if it were not set: given to the database as a count, it would fail
  // every request, and "1e2" or "0x10" may not be the number that was meant.
  for (const odd of ["0", "-3", "2.5", "1e12", "1e2", "0x10", "Infinity", "NaN", "0x", "12 an hour", " ", ""]) {
    assert.equal(accountsFrom({ SESSIONLY_RATE_PER_MINUTE: odd }).ratePerMinute, undefined, `"${odd}"`);
  }
});

test("a setting that does nothing as it is set is said at the start", () => {
  assert.deepEqual(unheeded({}), []);
  // A server of your own opens without signing in: either half of a provider is said once, as not used.
  assert.deepEqual(
    unheeded({ SESSIONLY_GITHUB_CLIENT_ID: "id", SESSIONLY_GITHUB_CLIENT_SECRET: "s", SESSIONLY_GOOGLE_CLIENT_SECRET: "s", SESSIONLY_PUBLIC_URL: "http://10.0.0.5:8080" }),
    [
      "SESSIONLY_GOOGLE_CLIENT_SECRET is set, but signing in with Google is for the hosted service: this server's dashboard opens without signing in, and it is not used.",
      "SESSIONLY_GITHUB_CLIENT_ID and SESSIONLY_GITHUB_CLIENT_SECRET are set, but signing in with GitHub is for the hosted service: this server's dashboard opens without signing in, and they are not used.",
    ],
  );
  // A hosted service says what it does not use of these itself.
  assert.deepEqual(unheeded({ SESSIONLY_GITHUB_CLIENT_ID: "id", SESSIONLY_RATE_PER_MINUTE: "x" }, true), []);
  // What sent the links that people signed in with before.
  assert.deepEqual(unheeded({ RESEND_API_KEY: "re_test", SESSIONLY_EMAIL_FROM: "a@b.example" }), [
    "RESEND_API_KEY and SESSIONLY_EMAIL_FROM are set, but no email is sent any more: people sign in with Google or GitHub.",
  ]);
  assert.match(unheeded({ SMTP_URL: "smtp://mail.example" }).join(), /^SMTP_URL is set, but no email is sent any more/);
  // A count that is not one.
  assert.deepEqual(unheeded({ SESSIONLY_RATE_PER_MINUTE: "600", SESSIONLY_DB_POOL: "8" }), []);
  const notes = unheeded({ SESSIONLY_RATE_PER_MINUTE: "0.5", SESSIONLY_DB_POOL: "-1" });
  assert.equal(notes.length, 2);
  assert.match(notes[0] ?? "", /^SESSIONLY_RATE_PER_MINUTE is "0\.5", which is not a whole number above 0/);
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
    // Not a domain the DNS could have: a label too long, a hyphen at an
    // end of one, a number where the top-level domain goes.
    `ann@${"a".repeat(64)}.example`,
    "ann@-acme.example",
    "ann@acme-.example",
    "ann@acme.-example",
    "ann@acme..example",
    "ann@192.168.1.10",
    "ann@example.123",
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

test("a domain's labels may be long, hyphenated and numbered, within what the DNS takes", () => {
  assert.equal(emailFrom(`ann@${"a".repeat(63)}.example`), `ann@${"a".repeat(63)}.example`);
  assert.equal(emailFrom("ann@my-team.co-op.example"), "ann@my-team.co-op.example");
  assert.equal(emailFrom("ann@3m.com"), "ann@3m.com");
  assert.equal(emailFrom("ann@123.example"), "ann@123.example");
  assert.equal(emailFrom("ann@mail.x1"), "ann@mail.x1");
  assert.equal(emailFrom("ann@例え.テスト"), "ann@xn--r8jz45g.xn--zckzah");
});

