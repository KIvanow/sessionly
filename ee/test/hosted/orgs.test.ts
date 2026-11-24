// Deleting an organisation of the hosted service, restoring it, and purging
// what was deleted a week ago.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../../../apps/server/src/app.ts";
import { createToken, hash } from "../../../apps/server/src/auth.ts";
import { openDb, type Db } from "../../../apps/server/src/db.ts";
import { exportKey, invitesKey } from "../../../apps/server/src/limits.ts";
import { newOrg, testDbUrl, tokenFor } from "../../../apps/server/test/helpers.ts";
import { hosting } from "../../src/hosted/index.ts";
import { purgeDeletedOrgs, restoreOrg } from "../../src/hosted/orgs.ts";
import type { Accounts } from "../../src/hosted/signup.ts";

let db: Db;
let app: ReturnType<typeof createApp>;

before(async () => {
  db = await openDb(await testDbUrl());
  app = createApp(db);
});
after(() => db.close());

async function raw(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  server: ReturnType<typeof createApp> = app,
) {
  const response = await server.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? (JSON.parse(text) as any) : undefined };
}

test("the owner deletes the organisation by its name, and it drops out of signing in", async () => {
  await newOrg(db, "org-end", "Ends Here");
  await newOrg(db, "org-stay", "Stays");
  await db.query(
    `INSERT INTO users (id, org_id, email, role, confirmed_at, sign_in_provider, sign_in_account) VALUES
       ('usr_end', 'org-end', 'own@end.example', 'owner', now(), 'github', 'acct-end'),
       ('usr_stay', 'org-stay', 'own@end.example', 'member', now(), 'github', 'acct-end')`,
  );
  const owner = await db.asOrg("org-end", (scoped) =>
    createToken(scoped, { email: "own@end.example", role: "admin", userId: "usr_end", signIn: "github" }),
  );
  const admin = await tokenFor(db, { email: "admin@end.example", role: "admin" }, "org-end");
  const accounts: Accounts = { publicUrl: "http://localhost:8080" };
  const hosted = createApp(db, { accounts, hosting: hosting(db, { accounts }) });
  const secret = "owner-sign-in";
  await db.query(
    `INSERT INTO sign_in_codes (code_hash, provider, account, emails, expires_at)
     VALUES ($1, 'github', 'acct-end', ARRAY['own@end.example'], now() + interval '10 minutes')`,
    [hash(secret)],
  );
  const places = async () => {
    const response = await hosted.request("/api/v1/auth/check", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `sessionly-arrived=${secret}.in` },
      body: "{}",
    });
    const body = (await response.json()) as { orgs?: { org_id: string }[] };
    assert.equal(response.status, 200);
    return (body.orgs ?? []).map((org) => org.org_id).sort();
  };
  assert.deepEqual(await places(), ["org-end", "org-stay"]);

  // Not the owner, and not a server of your own: there, whoever runs it drops the database.
  assert.equal((await raw(admin, "DELETE", "/org", { name: "Ends Here" }, hosted)).status, 403);
  const selfHosted = createApp(db, { bootstrap: { token: "delete-bootstrap", email: "root@example.com" } });
  const refused = await raw("delete-bootstrap", "DELETE", "/org", { name: "Default" }, selfHosted);
  assert.equal(refused.status, 404);
  const [untouched] = await db.query<{ deleted_at: unknown }>(`SELECT deleted_at FROM orgs WHERE id = 'default'`);
  assert.equal(untouched?.deleted_at, null);

  assert.equal((await raw(owner.token, "DELETE", "/org", { name: "Wrong" }, hosted)).status, 400);
  assert.equal((await raw(owner.token, "DELETE", "/org", {}, hosted)).status, 400);
  const gone = await raw(owner.token, "DELETE", "/org", { name: "  Ends Here  " }, hosted);
  assert.equal(gone.status, 204);
  assert.equal(gone.text, "");
  // The token that asked is refused from then on, and signing in no longer offers the organisation.
  assert.equal((await raw(owner.token, "GET", "/me", undefined, hosted)).status, 401);
  assert.deepEqual(await places(), ["org-stay"]);

  assert.equal(await restoreOrg(db, "org-end"), true);
  assert.equal((await raw(owner.token, "GET", "/me", undefined, hosted)).status, 200);
  assert.deepEqual(await places(), ["org-end", "org-stay"]);
});

test("a purge removes an organisation deleted 8 days ago, and leaves one deleted 6 days ago", async () => {
  await newOrg(db, "org-aged", "Aged");
  await newOrg(db, "org-old", "Old");
  await newOrg(db, "org-young", "Young");
  const sessionRow = (org: string) =>
    db.query(
      `INSERT INTO sessions (org_id, machine_id, source, session_id, owner_email, content, payload)
       VALUES ($1, 'm', 'claude-code', 's', 'a@x.example', 'metadata', '{}')`,
      [org],
    );
  await sessionRow("org-aged");
  await sessionRow("org-old");
  await sessionRow("org-young");
  await db.query(
    `INSERT INTO pull_requests (
       org_id, repo, number, author, state, first_event, last_event, first_files, last_files, attribution
     ) VALUES ('org-old', 'github.com/acme/web', 1, 'ann', 'open', 'opened', 'opened', '[]', '[]', '{}')`,
  );
  await db.query(
    `INSERT INTO users (id, org_id, email, role) VALUES ('usr_old', 'org-old', 'a@old.example', 'member')`,
  );
  await db.query(
    `INSERT INTO tokens (id, org_id, token_hash, email, role) VALUES ('tok-old', 'org-old', 'hash-old', 'a@old.example', 'member')`,
  );
  await db.query(
    `UPDATE orgs SET deleted_at = now() - interval '8 days' WHERE id IN ('org-aged', 'org-old')`,
  );
  await db.query(`UPDATE orgs SET deleted_at = now() - interval '6 days' WHERE id = 'org-young'`);
  await db.query(`UPDATE orgs SET deleted_at = now() - interval '8 days' WHERE id = 'default'`);
  await db.query(
    `INSERT INTO rate_counters (key, window_start, n) VALUES
       ($1, now(), 1), ($2, now(), 1), ($3, now(), 1), ($4, now(), 2), ($5, now(), 3)`,
    [invitesKey("org-aged"), invitesKey("org-old"), exportKey("org-old"), invitesKey("org-young"), invitesKey("default")],
  );

  const removed = await purgeDeletedOrgs(db);
  assert.deepEqual(removed, ["org-aged", "org-old"]);
  const left = async (org: string) => {
    const [row] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs WHERE id = $1`, [org]);
    return Number(row?.n);
  };
  assert.equal(await left("org-aged"), 0);
  assert.equal(await left("org-old"), 0);
  for (const table of ["sessions", "pull_requests", "users", "tokens"]) {
    const [row] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table} WHERE org_id = 'org-old'`);
    assert.equal(Number(row?.n), 0, table);
  }
  assert.equal(await left("org-young"), 1);
  const [youngSession] = await db.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM sessions WHERE org_id = 'org-young'`,
  );
  assert.equal(Number(youngSession?.n), 1);
  assert.equal(await left("default"), 1);
  const [marked] = await db.query<{ deleted_at: unknown }>(`SELECT deleted_at FROM orgs WHERE id = 'default'`);
  assert.ok(marked?.deleted_at);
  const watched = [invitesKey("org-aged"), invitesKey("org-old"), exportKey("org-old"), invitesKey("org-young"), invitesKey("default")];
  const keys = await db.query<{ key: string }>(
    `SELECT key FROM rate_counters WHERE key = ANY($1::text[]) ORDER BY key`,
    [watched],
  );
  assert.deepEqual(keys.map((row) => row.key).sort(), [invitesKey("default"), invitesKey("org-young")].sort());
  // Put the default organisation back: nothing else in this file should see it as deleted.
  await db.query(`UPDATE orgs SET deleted_at = NULL WHERE id = 'default'`);
});

test("org purge and org restore say what they did", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessionly-org-"));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["src/cli.ts", ...args], {
      cwd: join(import.meta.dirname, "../.."),
      env: { ...process.env, DATABASE_URL: `file:${dir}` },
      encoding: "utf8",
    });
  try {
    const purge = run(["org", "purge"]);
    assert.equal(purge.status, 0, purge.stderr);
    assert.match(purge.stdout, /Nothing was due to be removed/);
    const missing = run(["org", "restore", "no-such"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /waiting to be deleted/);
    const usage = run(["org"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /org restore/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
