import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { createApp, testDb, type Db } from "@sessionly/server";
import { eeApi } from "../src/api.ts";
import { Entitlements } from "../src/entitlements.ts";
import { GRACE_MS, signLicense } from "../src/license/license.ts";
import { migrateEe } from "../src/migrate.ts";
import { issuer, license } from "./harness.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const clock = { now: new Date("2026-06-01T00:00:00Z") };
const ADMIN = "admin-secret";
let member = "";

before(async () => {
  db = await testDb();
  await migrateEe(db);
  await migrateEe(db); // running it again changes nothing
  const ent = new Entitlements(() => clock.now, issuer.publicKey, 0);
  app = createApp(db, {
    bootstrap: { token: ADMIN, email: "boss@example.com" },
    extensions: [eeApi({ entitlements: ent, org: "acme", now: () => clock.now })],
  });
  const created = await app.request("/api/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ email: "ann@example.com" }),
  });
  member = ((await created.json()) as { token: string }).token;
});
after(() => db.close());

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const install = (file: string, token = ADMIN) => call(token, "POST", "/license", { license: file });
const signed = (overrides = {}) => signLicense(license(overrides), issuer.privateKey);

test("with no license the core works and ee features answer license_required", async () => {
  const status = await call(member, "GET", "/license");
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "missing");
  assert.equal(status.body.license, null);
  assert.equal(status.body.org, "acme");
  assert.equal(status.body.people, 1);

  const policy = await call(member, "GET", "/policy");
  assert.equal(policy.status, 403);
  assert.equal(policy.body.code, "license_required");
  assert.equal((await call(ADMIN, "PUT", "/policy", { content: "previews" })).body.code, "license_required");
  // the core is untouched
  assert.equal((await call(member, "GET", "/ping")).status, 200);
  assert.equal((await call(member, "GET", "/summary")).status, 200);
});

test("only a valid license for this org, installed by an admin, is accepted", async () => {
  const refused = async (result: Promise<{ status: number; body: any }>, status: number, code: string) => {
    const r = await result;
    assert.deepEqual([r.status, r.body.code], [status, code]);
  };
  await refused(install(signed(), member), 403, "admins_only");
  await refused(install("garbage"), 400, "license_malformed");
  await refused(call(ADMIN, "POST", "/license", {}), 400, "license_malformed");
  const forged = JSON.parse(signed()) as { signature: string };
  forged.signature = forged.signature.replace(/^./, (c) => (c === "A" ? "B" : "A"));
  await refused(install(JSON.stringify(forged)), 400, "license_bad_signature");
  await refused(install(signed({ org: "someone-else" })), 403, "license_wrong_org");
  await refused(install(signed({ expiresAt: "2026-05-01T00:00:00.000Z" })), 400, "license_expired");
  assert.equal((await call(member, "GET", "/license")).body.status, "missing");

  const ok = await install(signed());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, "active");
  assert.equal(ok.body.license.edition, "business");
  assert.equal(ok.body.license.seats, 25);
  assert.deepEqual(ok.body.license.features, ["content_policy"]);
  assert.equal(ok.body.readOnlyAt, new Date(Date.parse("2027-01-01T00:00:00Z") + GRACE_MS).toISOString());
});

test("a license and a content policy are one organisation's", async () => {
  // Another organisation on the same server, with an admin of its own.
  const OTHER = "other-admin";
  await db.query(`INSERT INTO orgs (id, name) VALUES ('other', 'Other')`);
  await db.query(
    `INSERT INTO tokens (org_id, id, token_hash, email, role) VALUES ('other', 't-other', $1, 'boss@other.example', 'admin')`,
    [createHash("sha256").update(OTHER).digest("hex")],
  );
  // The license installed above is not theirs, and nor is the count of people.
  const theirs = await call(OTHER, "GET", "/license");
  assert.equal(theirs.body.status, "missing");
  assert.equal(theirs.body.people, 1);
  assert.equal((await call(OTHER, "GET", "/policy")).body.code, "license_required");
  // With a license of their own, their policy is theirs alone.
  assert.equal((await install(signed({ id: "lic_other" }), OTHER)).status, 201);
  assert.equal((await call(OTHER, "PUT", "/policy", { content: "previews" })).status, 200);
  assert.equal((await call(OTHER, "GET", "/policy")).body.updated_by, "boss@other.example");
  assert.deepEqual((await call(member, "GET", "/policy")).body, { content: "metadata", updated_by: null, updated_at: null });
  assert.equal((await call(member, "GET", "/license")).body.license.id, "lic_test");

  const unsecured = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
       AND EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`,
  );
  assert.deepEqual(unsecured, []);
  // Gone with their organisation, and the first one's untouched.
  await db.query(`DELETE FROM orgs WHERE id = 'other'`);
  const [left] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ee_licenses WHERE org_id = 'other'`);
  assert.equal(Number(left?.n), 0);
  assert.equal((await call(member, "GET", "/license")).body.status, "active");
});

test("a licensed feature works, then turns read-only after expiry and grace", async () => {
  const initial = await call(member, "GET", "/policy");
  assert.deepEqual(initial.body, { content: "metadata", updated_by: null, updated_at: null });

  assert.equal((await call(member, "PUT", "/policy", { content: "previews" })).body.code, "admins_only");
  assert.equal((await call(ADMIN, "PUT", "/policy", { content: "everything" })).body.code, "bad_policy");
  const set = await call(ADMIN, "PUT", "/policy", { content: "previews" });
  assert.equal(set.status, 200);
  const read = await call(member, "GET", "/policy");
  assert.equal(read.body.content, "previews");
  assert.equal(read.body.updated_by, "boss@example.com");

  // In the grace period changes still work.
  clock.now = new Date("2027-01-10T00:00:00Z");
  assert.equal((await call(member, "GET", "/license")).body.status, "grace");
  assert.equal((await call(ADMIN, "PUT", "/policy", { content: "metadata" })).status, 200);

  // After it: reads work, changes do not.
  clock.now = new Date("2027-02-01T00:00:00Z");
  assert.equal((await call(member, "GET", "/license")).body.status, "expired");
  assert.equal((await call(member, "GET", "/policy")).body.content, "metadata");
  const blocked = await call(ADMIN, "PUT", "/policy", { content: "previews" });
  assert.deepEqual([blocked.status, blocked.body.code], [403, "license_expired"]);

  // A renewed license restores them. The newest valid one is the one in force.
  const renewed = await install(signed({ id: "lic_renewed", issuedAt: "2027-02-01T00:00:00.000Z", expiresAt: "2028-02-01T00:00:00.000Z" }));
  assert.equal(renewed.body.status, "active");
  assert.equal((await call(ADMIN, "PUT", "/policy", { content: "previews" })).status, 200);
});

test("a license edited in the database stops counting", async () => {
  await db.query(`UPDATE ee_licenses SET raw = replace(raw, 'a', 'b')`);
  assert.equal((await call(member, "GET", "/license")).body.status, "missing");
  assert.equal((await call(member, "GET", "/policy")).body.code, "license_required");
});

test("a license without the feature does not unlock it", async () => {
  clock.now = new Date("2026-06-01T00:00:00Z");
  await db.query(`DELETE FROM ee_licenses`);
  const bare = await install(signed({ id: "lic_bare", features: [] }));
  assert.equal(bare.body.status, "active");
  assert.equal((await call(member, "GET", "/policy")).body.code, "license_required");
});
