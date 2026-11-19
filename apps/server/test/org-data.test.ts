// Exporting an organisation, deleting it, and erasing one person's sessions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";
import { createToken, hash } from "../src/auth.ts";
import { openDb, type Db } from "../src/db.ts";
import { EXPORTED_TABLES, exportLines, OMITTED_FROM_EXPORT } from "../src/export.ts";
import { exportKey, invitesKey } from "../src/limits.ts";
import { purgeDeletedOrgs, restoreOrg } from "../src/orgs.ts";
import { newOrg, testDbUrl, tokenFor } from "./helpers.ts";

let db: Db;
let app: ReturnType<typeof createApp>;

before(async () => {
  db = await openDb(await testDbUrl());
  app = createApp(db);
});
after(() => db.close());

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
}

const h = (n: number) => n.toString(16).padStart(16, "0");

function session(id: string, overrides: Record<string, unknown> = {}, lines: number[] = []) {
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      source: "claude-code",
      machine_id: "m1",
      session_id: id,
      content: "previews",
      user: { name: null, email: "ann@a.example" },
      started_at: "2026-11-14T10:00:00Z",
      repo: { root: "/home/user/web", remote: "github.com/acme/web", branch: "main" },
      models: ["claude-opus-5-5"],
      counts: { prompts: 1, tool_calls: 3, files_changed: 1, lines_added: 3 },
      prompts: [{ text: { preview: "the secret plan of org a", chars: 24, sha256: "0".repeat(64) } }],
      files: [{ path: "src/secret-of-a.ts", writes: 1, lines_added: 3 }],
      ...overrides,
    },
    rewrite: null,
    lines: lines.length ? [{ path: "src/parser.ts", model: "claude-opus-5-5", hashes: lines.map(h) }] : [],
  };
}

const put = (token: string, s: ReturnType<typeof session>) =>
  call(token, "PUT", `/sessions/${s.session.machine_id}/${s.session.source}/${s.session.session_id}`, s);

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    repo: "github.com/acme/web",
    number,
    title: "The pull request of org a",
    author: "ann",
    state: "open",
    created_at: "2026-11-14T12:00:00Z",
    event: "opened",
    commits: 1,
    reviews: 0,
    changes_requested: 0,
    review_comments: 0,
    bot_review_comments: 0,
    review_rounds: 0,
    commit_emails: ["ann@a.example"],
    head_ref: "feature",
    files: [{ path: "src/parser.ts", hashes: [h(1), h(2), h(3), h(90)] }],
    ...overrides,
  };
}

test("a person who signed in as the owner is the owner, and a token for their machine is not", async () => {
  await newOrg(db, "org-a", "A");
  await db.query(
    `INSERT INTO users (id, org_id, email, role) VALUES
       ('usr_ownera', 'org-a', 'own@a.example', 'owner'),
       ('usr_admina', 'org-a', 'adm@a.example', 'admin')`,
  );
  const signedIn = await db.asOrg("org-a", (scoped) =>
    createToken(scoped, { email: "own@a.example", role: "admin", userId: "usr_ownera", signIn: "github" }),
  );
  const laptop = await db.asOrg("org-a", (scoped) =>
    createToken(scoped, { email: "own@a.example", role: "admin", userId: "usr_ownera" }),
  );
  const admin = await db.asOrg("org-a", (scoped) =>
    createToken(scoped, { email: "adm@a.example", role: "admin", userId: "usr_admina", signIn: "github" }),
  );
  assert.equal((await call(signedIn.token, "GET", "/me")).body.owner, true);
  // Same person, and an admin's token, which is what an owner signs in with.
  // It was not a sign-in, so it cannot export or delete the organisation.
  assert.equal((await call(laptop.token, "GET", "/me")).body.owner, false);
  assert.equal((await call(laptop.token, "GET", "/me")).body.role, "admin");
  assert.equal((await call(admin.token, "GET", "/me")).body.owner, false);
  const boss = await tokenFor(db, { email: "boss@a.example", role: "admin" }, "org-a");
  const member = await tokenFor(db, { email: "ann@a.example", role: "member" }, "org-a");
  assert.equal((await call(boss, "GET", "/me")).body.owner, false);
  assert.equal((await call(member, "GET", "/me")).body.owner, false);

  const ask = async (server: ReturnType<typeof createApp>) => {
    const response = await server.request("/api/v1/me", { headers: { authorization: "Bearer bootstrap-secret" } });
    return { status: response.status, body: (await response.json()) as { owner: boolean; role: string } };
  };
  // A server of one team has no owner. Its admin token from the environment is.
  const selfHosted = createApp(db, { bootstrap: { token: "bootstrap-secret", email: "root@example.com" } });
  assert.equal((await ask(selfHosted)).status, 200);
  assert.equal((await ask(selfHosted)).body.owner, true);
  // A hosted service has owners of its own. That token is an admin of the
  // default organisation and not an owner.
  const hosted = createApp(db, {
    bootstrap: { token: "bootstrap-secret", email: "root@example.com" },
    accounts: { hosted: true },
  });
  assert.equal((await ask(hosted)).body.owner, false);
  assert.equal((await ask(hosted)).body.role, "admin");
});

async function exported(token: string, server: ReturnType<typeof createApp> = app) {
  const response = await server.request("/api/v1/export", { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  const lines =
    response.status === 200
      ? text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return {
    status: response.status,
    text,
    lines,
    type: response.headers.get("content-type"),
    disposition: response.headers.get("content-disposition"),
    body: response.status === 200 ? undefined : (JSON.parse(text) as { error?: string; code?: string }),
  };
}

test("an owner can export every row of the organisation, and an admin or a member cannot", async () => {
  await newOrg(db, "org-out", "Out");
  await newOrg(db, "org-other", "Other");
  await db.query(
    `INSERT INTO users (id, org_id, email, role, invited_at) VALUES
       ('usr_out', 'org-out', 'own@out.example', 'owner', now())`,
  );
  const owner = await db.asOrg("org-out", (scoped) =>
    createToken(scoped, { email: "own@out.example", role: "admin", userId: "usr_out", signIn: "github", name: "Owner" }),
  );
  const admin = await tokenFor(db, { email: "admin@out.example", role: "admin" }, "org-out");
  const member = await tokenFor(db, { email: "mem@out.example", role: "member" }, "org-out");
  const other = await tokenFor(db, { email: "eve@other.example", role: "member" }, "org-other");

  // A refusal is not one of the ten minutes.
  assert.equal((await exported(admin)).status, 403);
  assert.equal((await exported(member)).status, 403);

  const uploaded = session("out-s", {
    user: { name: null, email: "mem@out.example" },
    prompts: [{ text: { preview: "out-only-preview", chars: 16, sha256: "ab".repeat(32) } }],
  });
  assert.equal((await put(member, uploaded)).status, 200);
  assert.equal((await call(admin, "PUT", "/prs", pull(7, { title: "out-only-pull" }))).status, 200);
  assert.equal((await call(member, "PUT", "/repos/excluded", { repo: "github.com/out/secret" })).status, 200);
  const marker = session("other-s", {
    user: { name: null, email: "eve@other.example" },
    prompts: [{ text: { preview: "other-org-marker", chars: 16, sha256: "cd".repeat(32) } }],
  });
  assert.equal((await put(other, marker)).status, 200);
  // A pull request's own lines, so the export has that table to copy. The
  // report above may have matched none.
  await db.query(
    `INSERT INTO pull_sessions (org_id, repo, number, machine_id, source, session_id, lines, weight)
     VALUES ('org-out', 'github.com/acme/web', 7, 'm1', 'claude-code', 'out-s', 3, 3)
     ON CONFLICT DO NOTHING`,
  );
  // Another organisation's pull history. The file must not contain it.
  await db.query(
    `INSERT INTO pull_requests (
       org_id, repo, number, author, state, first_event, last_event, first_files, last_files, attribution
     ) VALUES ('org-other', 'github.com/acme/other', 9, 'eve', 'open', 'opened', 'opened', '[]', '[]', '{}')`,
  );
  await db.query(
    `INSERT INTO pull_sessions (org_id, repo, number, machine_id, source, session_id, lines, weight)
     VALUES ('org-other', 'github.com/acme/other', 9, 'm1', 'claude-code', 'other-lines', 9, 9)`,
  );
  await db.query(
    `INSERT INTO pull_request_reports (org_id, repo, number, event, commits, lines, agent_lines, sessions)
     VALUES ('org-other', 'github.com/acme/other', 9, 'opened', 1, 9, 0, '[{"session_id":"other-org-report"}]')`,
  );

  const file = await exported(owner.token);
  assert.equal(file.status, 200);
  assert.match(file.type ?? "", /^application\/x-ndjson/);
  assert.match(file.disposition ?? "", /attachment; filename="sessionly-org-out-\d{4}-\d{2}-\d{2}\.jsonl"/);
  assert.equal(file.lines[0]?.type, "org");
  assert.equal(file.lines[0]?.id, "org-out");
  assert.equal(file.lines[0]?.name, "Out");
  assert.equal(file.lines[0]?.version, "0.1.0");
  assert.equal(typeof file.lines[0]?.created_at, "string");
  assert.equal(typeof file.lines[0]?.exported_at, "string");

  const of = (type: string) => file.lines.filter((row) => row.type === type);
  const count = async (table: string, org = "org-out") => {
    const [row] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table} WHERE org_id = $1`, [org]);
    return Number(row?.n);
  };
  assert.equal(of("user").length, await count("users"));
  assert.ok(of("user").some((row) => row.email === "own@out.example" && row.role === "owner"));
  assert.equal(of("user").some((row) => "sign_in_account" in row || "sign_in_provider" in row), false);
  assert.equal(of("session").length, await count("sessions"));
  assert.ok(of("session").some((row) => row.session_id === "out-s" && JSON.stringify(row.payload).includes("out-only-preview")));
  assert.equal(of("pull_request").length, await count("pull_requests"));
  assert.equal(of("pull_session").length, await count("pull_sessions"));
  const association = of("pull_session").find((row) => row.session_id === "out-s");
  assert.ok(association);
  assert.equal(association.org_id, "org-out");
  assert.equal(association.repo, "github.com/acme/web");
  assert.equal(Number(association.number), 7);
  assert.equal(Number(association.lines), 3);
  assert.equal(of("pull_request_report").length, await count("pull_request_reports"));
  const history = of("pull_request_report").find((row) => row.repo === "github.com/acme/web" && Number(row.number) === 7);
  assert.ok(history);
  assert.equal(history.org_id, "org-out");
  assert.equal(history.event, "opened");
  const pullRow = of("pull_request").find((row) => row.title === "out-only-pull");
  assert.ok(pullRow);
  for (const column of ["first_files", "last_files", "attribution", "detail", "feedback"]) {
    assert.ok(column in pullRow!, column);
  }
  assert.equal(of("repo_exclusion").length, await count("repo_exclusions"));
  assert.ok(of("repo_exclusion").some((row) => row.repo === "github.com/out/secret" && row.owner_email === "mem@out.example"));
  assert.equal(of("token").length, await count("tokens"));
  assert.ok(of("token").some((row) => row.email === "own@out.example" && row.name === "Owner" && row.role === "admin"));
  assert.doesNotMatch(file.text, /token_hash/);
  assert.doesNotMatch(file.text, new RegExp(hash(owner.token)));
  assert.doesNotMatch(file.text, new RegExp(owner.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(file.text, /other-org-marker/);
  assert.doesNotMatch(file.text, /other-lines/);
  assert.doesNotMatch(file.text, /other-org-report/);
  assert.equal(of("session").some((row) => row.session_id === "other-s"), false);
  assert.equal(of("pull_session").some((row) => row.org_id !== "org-out"), false);
  assert.equal(of("pull_request_report").some((row) => row.org_id !== "org-out"), false);

  const again = await exported(owner.token);
  assert.equal(again.status, 429);
  assert.equal(again.body?.code, "rate_limited");
  // Ten minutes from the last one, not from the start of a clock window.
  // One second short is still too soon. Exactly ten minutes is allowed.
  await db.query(
    `UPDATE rate_counters SET window_start = clock_timestamp() - interval '599 seconds' WHERE key = 'export:org-out'`,
  );
  const early = await exported(owner.token);
  assert.equal(early.status, 429);
  assert.equal(early.body?.code, "rate_limited");
  await db.query(
    `UPDATE rate_counters SET window_start = clock_timestamp() - interval '600 seconds' WHERE key = 'export:org-out'`,
  );
  const later = await exported(owner.token);
  assert.equal(later.status, 200);
  assert.equal(later.lines[0]?.id, "org-out");

  // The bootstrap token of a server that is not hosted can export. A hosted one cannot.
  const hosted = createApp(db, {
    bootstrap: { token: "export-bootstrap", email: "root@example.com" },
    accounts: { hosted: true },
  });
  const selfHosted = createApp(db, { bootstrap: { token: "export-bootstrap", email: "root@example.com" } });
  assert.equal((await exported("export-bootstrap", hosted)).status, 403);
  const own = await exported("export-bootstrap", selfHosted);
  assert.equal(own.status, 200);
  assert.equal(own.lines[0]?.type, "org");
  assert.equal(own.lines[0]?.id, "default");
  assert.doesNotMatch(own.text, /token_hash|out-only-preview|other-org-marker/);
});

test("an export names every table that belongs to an organisation", async () => {
  const tables = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
     ORDER BY 1`,
  );
  const named = new Set<string>([...EXPORTED_TABLES, ...OMITTED_FROM_EXPORT]);
  for (const { name } of tables) assert.ok(named.has(name), `${name} is neither exported nor left out on purpose`);
  for (const name of named) assert.ok(tables.some((table) => table.name === name), name);
});

test("an export reads the next page only after its line was asked for", async () => {
  let calls = 0;
  const lines = exportLines(async (fn) => {
    calls += 1;
    return db.asOrg("default", fn);
  }, "2026-11-18T00:00:00.000Z");
  const first = await lines.next();
  assert.equal(first.value?.type, "org");
  // The organisation line is one transaction. Nothing after it has been read.
  assert.equal(calls, 1);
  await lines.return(undefined);
  assert.equal(calls, 1);
});

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
  const hosted = createApp(db, { accounts: { hosted: true, publicUrl: "http://localhost:8080" } });
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

  // Not the owner, and not a hosted service.
  assert.equal((await raw(admin, "DELETE", "/org", { name: "Ends Here" }, hosted)).status, 403);
  const selfHosted = createApp(db, { bootstrap: { token: "delete-bootstrap", email: "root@example.com" } });
  const refused = await raw("delete-bootstrap", "DELETE", "/org", { name: "Default" }, selfHosted);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /drop the database/);
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

test("removing a person can delete their sessions and nobody else's", async () => {
  await newOrg(db, "org-people", "People");
  await db.query(
    `INSERT INTO users (id, org_id, email, role) VALUES
       ('usr_ann', 'org-people', 'ann@people.example', 'member'),
       ('usr_bob', 'org-people', 'bob@people.example', 'member')`,
  );
  const admin = await tokenFor(db, { email: "admin@people.example", role: "admin" }, "org-people");
  const ann = await tokenFor(db, { email: "ann@people.example", role: "member" }, "org-people");
  const bob = await tokenFor(db, { email: "bob@people.example", role: "member" }, "org-people");
  const ci = await tokenFor(db, { email: "ci@people.example", role: "ci" }, "org-people");
  assert.equal((await put(ann, session("ann-s", { user: { name: null, email: "ann@people.example" } }))).status, 200);
  assert.equal((await put(bob, session("bob-s", { user: { name: null, email: "bob@people.example" } }))).status, 200);
  assert.equal((await call(ci, "PUT", "/prs", pull(4, { title: "stays on the pull request" }))).status, 200);
  assert.equal((await call(ann, "PUT", "/repos/excluded", { repo: "~/Notes" })).status, 200);
  assert.equal((await call(ann, "DELETE", "/repos/excluded?repo=~/Notes")).status, 200);
  assert.equal((await call(ann, "PUT", "/repos/excluded", { repo: "~/Code" })).status, 200);
  assert.equal((await call(bob, "PUT", "/repos/excluded", { repo: "~/Bob" })).status, 200);

  const count = async (table: string, email: string) => {
    const [row] = await db.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM ${table} WHERE org_id = 'org-people' AND owner_email = $1`,
      [email],
    );
    return Number(row?.n);
  };
  // Lines a pull request kept of these sessions. Erasing the person clears
  // which lines they were. The pull request, and the other person's lines, stay.
  await db.query(
    `INSERT INTO pull_sessions (
       org_id, repo, number, machine_id, source, session_id, lines, weight, matched,
       opened_lines, opened_weight, opened_matched
     ) VALUES
       ('org-people', 'github.com/acme/web', 4, 'm1', 'claude-code', 'ann-s', 4, 1.5, '{"src/a.ts":["ab"]}'::jsonb, 4, 1.5, '{"src/a.ts":["ab"]}'::jsonb),
       ('org-people', 'github.com/acme/web', 4, 'm1', 'claude-code', 'bob-s', 2, 2, '{"src/b.ts":["cd"]}'::jsonb, 2, 2, '{"src/b.ts":["cd"]}'::jsonb)`,
  );
  assert.equal((await call(admin, "DELETE", "/users/usr_ann?data=true")).status, 200);
  assert.equal(await count("sessions", "ann@people.example"), 0);
  assert.equal(await count("sessions", "bob@people.example"), 1);
  assert.equal(await count("repo_exclusions", "ann@people.example"), 0);
  // One allowance, and the number stays so the next one is not 1 again.
  assert.equal(await count("repos_allowed_again", "ann@people.example"), 1);
  assert.equal(await count("repo_exclusions", "bob@people.example"), 1);
  assert.equal((await call(admin, "GET", "/prs")).body.pulls[0].title, "stays on the pull request");
  // A token that was already accepted can still ask to stop a repository.
  // The person is removed, so nothing is written.
  const lingering = await db.asOrg("org-people", (scoped) =>
    createToken(scoped, { email: "ann@people.example", role: "member", userId: null }),
  );
  const stopped = await call(lingering.token, "PUT", "/repos/excluded", { repo: "~/Later" });
  assert.equal(stopped.status, 403);
  assert.equal(stopped.body.code, "person_removed");
  const unstopped = await call(lingering.token, "DELETE", "/repos/excluded?repo=~/Code");
  assert.equal(unstopped.status, 403);
  assert.equal(unstopped.body.code, "person_removed");
  assert.equal(await count("repo_exclusions", "ann@people.example"), 0);
  assert.equal(await count("repos_allowed_again", "ann@people.example"), 1);
  const kept = async (id: string) => {
    const [row] = await db.query<{ matched: unknown; opened_matched: unknown; weight: unknown; opened_weight: unknown }>(
      `SELECT matched, opened_matched, weight, opened_weight FROM pull_sessions
       WHERE org_id = 'org-people' AND session_id = $1`,
      [id],
    );
    assert.ok(row, id);
    return row;
  };
  const annLines = await kept("ann-s");
  assert.equal(annLines.matched, null);
  assert.equal(annLines.opened_matched, null);
  assert.equal(Number(annLines.weight), 4);
  assert.equal(Number(annLines.opened_weight), 4);
  const bobLines = await kept("bob-s");
  assert.ok(bobLines.matched);
  assert.ok(bobLines.opened_matched);
  assert.equal(Number(bobLines.weight), 2);
  // A cloud session filed under the removed address is not stored. One filed
  // under someone who is still here is. A CI token still reports a pull request.
  const env = await tokenFor(db, { email: "env@people.example", role: "env" }, "org-people");
  const cloud = (id: string, email: string) =>
    session(id, {
      machine_id: "cloud",
      runtime: { kind: "cloud", id: `cse_${id}` },
      user: { name: null, email },
    });
  const refused = await put(env, cloud("ann-cloud", "ann@people.example"));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.stored, false);
  assert.equal(refused.body.code, "person_removed");
  assert.match(refused.body.error, /removed/);
  assert.equal(await count("sessions", "ann@people.example"), 0);
  assert.equal((await put(env, cloud("bob-cloud", "bob@people.example"))).status, 200);
  assert.equal(await count("sessions", "bob@people.example"), 2);
  assert.equal((await call(ci, "PUT", "/prs", pull(5, { title: "a later report" }))).status, 200);
  // Without the flag, the person goes and the sessions stay. A session filed
  // under them after that is still not stored.
  assert.equal((await call(admin, "DELETE", "/users/usr_bob")).status, 200);
  assert.equal(await count("sessions", "bob@people.example"), 2);
  assert.equal(await count("repo_exclusions", "bob@people.example"), 1);
  const later = await put(env, cloud("bob-later", "bob@people.example"));
  assert.equal(later.status, 403);
  assert.equal(later.body.code, "person_removed");
  assert.equal(await count("sessions", "bob@people.example"), 2);
  const bobLingering = await db.asOrg("org-people", (scoped) =>
    createToken(scoped, { email: "bob@people.example", role: "member", userId: null }),
  );
  assert.equal((await call(bobLingering.token, "PUT", "/repos/excluded", { repo: "~/Later" })).status, 403);
  assert.equal(await count("repo_exclusions", "bob@people.example"), 1);
});

test("erasing sessions keeps the allowance number a machine already saw", async () => {
  await newOrg(db, "org-allow", "Allow");
  await db.query(
    `INSERT INTO users (id, org_id, email, role) VALUES
       ('usr_ada', 'org-allow', 'ada@allow.example', 'member')`,
  );
  const admin = await tokenFor(db, { email: "admin@allow.example", role: "admin" }, "org-allow");
  const ada = await tokenFor(db, { email: "ada@allow.example", role: "member" }, "org-allow");
  const uploaded = session("ada-s", { user: { name: null, email: "ada@allow.example" } });
  assert.equal((await put(ada, uploaded)).status, 200);
  // One allowance. A machine that was here stores 1, then goes offline.
  assert.equal((await call(ada, "PUT", "/repos/excluded", { repo: "~/Notes" })).status, 200);
  assert.equal((await call(ada, "DELETE", "/repos/excluded?repo=~/Notes")).status, 200);
  assert.deepEqual((await call(ada, "GET", "/repos/excluded")).body, { repos: [], allowed_again: 1 });

  assert.equal((await call(admin, "DELETE", "/users/usr_ada?data=true")).status, 200);
  const [kept] = await db.query<{ times: unknown }>(
    `SELECT times FROM repos_allowed_again WHERE org_id = 'org-allow' AND owner_email = 'ada@allow.example'`,
  );
  assert.equal(Number(kept?.times), 1);

  // Brought back without a sign-in provider: the same clearing a re-add does.
  await db.query(`UPDATE users SET removed_at = NULL WHERE org_id = 'org-allow' AND id = 'usr_ada'`);
  const back = await tokenFor(db, { email: "ada@allow.example", role: "member" }, "org-allow");
  assert.equal((await call(back, "GET", "/repos/excluded")).body.allowed_again, 1);
  // The session the erasure removed is not here. The machine still has it,
  // and still has 1, so it does not ask while the number stays 1.
  assert.deepEqual((await call(back, "GET", "/sessions/held?machine=m1")).body.sessions, []);

  // The next allowance is 2, which that machine has not seen. It asks, finds
  // the session gone, and sends it again. The server stores it.
  assert.equal((await call(back, "PUT", "/repos/excluded", { repo: "~/Notes" })).status, 200);
  assert.equal((await call(back, "DELETE", "/repos/excluded?repo=~/Notes")).status, 200);
  assert.equal((await call(back, "GET", "/repos/excluded")).body.allowed_again, 2);
  assert.equal((await put(back, uploaded)).status, 200);
  assert.deepEqual((await call(back, "GET", "/sessions/held?machine=m1")).body.sessions, [
    { source: "claude-code", session_id: "ada-s" },
  ]);
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
      cwd: join(import.meta.dirname, ".."),
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
