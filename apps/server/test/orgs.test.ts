// Organisations: what one stores, another must never see, change or be told of.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { ApiError, createApp, type Env } from "../src/app.ts";
import { createToken } from "../src/auth.ts";
import { APP_ROLE, appRoleOf, FIRST_ORG_MIGRATION, openDb, versionProblem, type Db } from "../src/db.ts";
import { hostedProblems, reason } from "../src/run.ts";
import { adminRuns, newOrg, renameTestDb, testDbUrl, tokenFor, tokenWithId } from "./helpers.ts";

let db: Db;
let dbUrl: string;
let app: Hono<Env>;
type Tokens = { admin: string; member: string; memberId: string; ci: string; env: string };
const a = {} as Tokens;
const b = {} as Tokens;

async function people(org: string, domain: string): Promise<Tokens> {
  const member = await tokenWithId(db, { email: `ann@${domain}`, role: "member" }, org);
  return {
    admin: await tokenFor(db, { email: `boss@${domain}`, role: "admin" }, org),
    member: member.token,
    memberId: member.id,
    ci: await tokenFor(db, { email: `ci@${domain}`, role: "ci" }, org),
    env: await tokenFor(db, { email: `cloud@${domain}`, role: "env" }, org),
  };
}

before(async () => {
  dbUrl = await testDbUrl();
  db = await openDb(dbUrl);
  app = createApp(db, {
    extensions: [
      // A route that writes and then fails, to see that nothing of it stays.
      (api) =>
        api.post("/write-then-fail", async (c) => {
          await createToken(c.get("db"), { email: "left-behind@a.example", role: "member" });
          throw new ApiError(409, "failed", "failed after writing");
        }),
    ],
  });
  await newOrg(db, "org-a", "A");
  await newOrg(db, "org-b", "B");
  Object.assign(a, await people("org-a", "a.example"));
  Object.assign(b, await people("org-b", "b.example"));
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

test("another organisation sees none of an organisation's sessions, pull requests or tokens", async () => {
  assert.equal((await put(a.member, session("s1", {}, [1, 2, 3]))).status, 200);
  assert.equal((await call(a.ci, "PUT", "/prs", pull(1))).status, 200);
  // Org a sees its own.
  assert.equal((await call(a.admin, "GET", "/sessions")).body.total, 1);
  assert.equal((await call(a.admin, "GET", "/prs")).body.total, 1);

  // What org a stored must not be in any answer org b gets: its ids, its
  // people, its paths, its prompt.
  const ofA = /s1|a\.example|secret|org a|parser/;
  const asked: [string, string, unknown?][] = [
    ["GET", "/sessions"],
    ["GET", "/sessions?q=secret"],
    ["GET", "/sessions/m1/claude-code/s1"],
    ["GET", "/summary"],
    ["GET", "/summary?by=repo"],
    ["GET", "/files"],
    ["GET", "/filters"],
    ["GET", "/prs"],
    ["GET", "/prs/summary"],
    ["GET", "/tokens"],
    ["DELETE", `/tokens/${a.memberId}`],
  ];
  for (const token of [b.admin, b.member]) {
    for (const [method, path, body] of asked) {
      const answer = await call(token, method, path, body);
      assert.ok([200, 403, 404].includes(answer.status), `${method} ${path}: ${answer.status}`);
      assert.doesNotMatch(answer.text, ofA, `${method} ${path}`);
    }
  }
  assert.equal((await call(b.admin, "GET", "/sessions/m1/claude-code/s1")).status, 404);
  assert.equal((await call(b.admin, "DELETE", `/tokens/${a.memberId}`)).status, 404);
  assert.equal((await call(b.admin, "GET", "/summary")).body.total.sessions, 0);
  assert.equal((await call(b.admin, "GET", "/prs/summary")).body.total.pulls, 0);
  assert.equal((await call(b.admin, "GET", "/sessions")).body.total, 0);
  assert.deepEqual(
    (await call(b.admin, "GET", "/tokens")).body.tokens.map((t: any) => t.email).sort(),
    ["ann@b.example", "boss@b.example", "ci@b.example", "cloud@b.example"],
  );
  // Its tokens for CI and for a cloud environment read nothing at all,
  // of anyone's.
  for (const token of [b.ci, b.env]) {
    for (const [method, path, body] of asked) {
      const answer = await call(token, method, path, body);
      assert.equal(answer.status, 403, `${method} ${path}`);
      assert.doesNotMatch(answer.text, ofA, `${method} ${path}`);
    }
  }
  // What they do write lands in their own organisation, beside org a's of
  // the same name, and is told nothing of it.
  const same = await put(b.env, session("s1", { user: { name: null, email: "eve@b.example" } }));
  assert.deepEqual(same.body, { stored: true });
  const reported = await call(b.ci, "PUT", "/prs", pull(1, { title: "b's own" }));
  assert.equal(reported.body.attribution.now.agent_lines, 0);
  assert.doesNotMatch(reported.text, ofA);
  assert.equal((await call(a.admin, "GET", "/sessions/m1/claude-code/s1")).body.owner_email, "ann@a.example");
  assert.equal((await call(a.admin, "GET", "/prs")).body.pulls[0].title, "The pull request of org a");

  // And nothing org b did changed what org a has: the token it tried to
  // revoke still works.
  assert.equal((await call(a.member, "GET", "/ping")).body.org, "org-a");
  assert.equal((await call(a.admin, "GET", "/sessions")).body.total, 1);
});

test("the same ids in two organisations are two things", async () => {
  // Every cloud session's machine is "cloud", and both report acme/web#1.
  const cloud = (person: string) =>
    session("same-id", {
      machine_id: "cloud",
      user: { name: null, email: person },
      runtime: { kind: "cloud", id: "cse_same" },
    });
  assert.deepEqual((await put(a.env, cloud("dee@a.example"))).body, { stored: true });
  // Not "uploaded by someone else": org b is told nothing of org a's session.
  assert.deepEqual((await put(b.env, cloud("eve@b.example"))).body, { stored: true });
  assert.equal((await call(b.ci, "PUT", "/prs", pull(1, { title: "The pull request of org b" }))).status, 200);

  const inA = await call(a.admin, "GET", "/sessions/cloud/claude-code/same-id");
  const inB = await call(b.admin, "GET", "/sessions/cloud/claude-code/same-id");
  assert.equal(inA.body.owner_email, "dee@a.example");
  assert.equal(inB.body.owner_email, "eve@b.example");
  assert.equal((await call(a.admin, "GET", "/prs")).body.pulls[0].title, "The pull request of org a");
  assert.equal((await call(b.admin, "GET", "/prs")).body.pulls[0].title, "The pull request of org b");
});

test("a pull request is attributed from its own organisation's sessions only", async () => {
  // Org b has a session in the same repository, on the same branch, by the
  // same committer, with the very lines org a's pull request adds.
  const theirs = session(
    "s-b",
    { user: { name: null, email: "ann@a.example" }, repo: { remote: "github.com/acme/web", branch: "work" } },
    [50, 51, 52],
  );
  assert.equal((await put(b.member, theirs)).status, 200);
  const cloudOfB = session(
    "c-b",
    { machine_id: "cloud", runtime: { kind: "cloud", id: "cse_b" }, repo: { remote: "github.com/acme/web", branch: "work" } },
    [50, 51, 52],
  );
  assert.equal((await put(b.env, cloudOfB)).status, 200);

  const report = pull(2, { head_ref: "work", files: [{ path: "src/parser.ts", hashes: [h(50), h(51), h(52)] }] });
  const forA = await call(a.ci, "PUT", "/prs", report);
  assert.equal(forA.body.attribution.now.agent_lines, 0);
  assert.equal(forA.body.attribution.cloud, null);
  // The same report from org b is matched to them.
  const forB = await call(b.ci, "PUT", "/prs", report);
  assert.equal(forB.body.attribution.now.agent_lines, 3);
  assert.equal(forB.body.attribution.cloud.sessions, 1);
});

test("the database itself confines a request to its organisation", async () => {
  // Counted first as the owner, who sees every organisation's rows.
  const tables = ["sessions", "pull_requests", "tokens", "orgs"];
  const mine = new Map<string, number>();
  for (const table of tables) {
    const column = table === "orgs" ? "id" : "org_id";
    const [row] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} = 'org-a'`);
    const [all] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table}`);
    mine.set(table, Number(row?.n));
    assert.ok(Number(all?.n) > Number(row?.n), `${table}: other organisations have rows too`);
  }
  await db.asOrg("org-a", async (scoped) => {
    // No WHERE at all: still only this organisation's rows.
    for (const table of tables) {
      const [seen] = await scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table}`);
      assert.equal(Number(seen?.n), mine.get(table), table);
      assert.ok(Number(seen?.n) > 0, table);
    }
  });
  // Writing another organisation's row is refused, whatever the statement says.
  await assert.rejects(
    db.asOrg("org-a", (scoped) =>
      scoped.query(`INSERT INTO tokens (org_id, id, token_hash, email, role) VALUES ('org-b', 'x', 'x', 'x@x', 'member')`),
    ),
    /row-level security/,
  );
  await assert.rejects(
    db.asOrg("org-a", (scoped) => scoped.query(`UPDATE sessions SET org_id = 'org-b'`)),
    /row-level security/,
  );
  // Changing or deleting another's rows touches none.
  await db.asOrg("org-a", async (scoped) => {
    assert.equal((await scoped.query(`UPDATE sessions SET title = 'x' WHERE org_id = 'org-b' RETURNING 1`)).length, 0);
    assert.equal((await scoped.query(`DELETE FROM tokens WHERE org_id = 'org-b' RETURNING 1`)).length, 0);
  });
  // With no organisation set there is nothing to see.
  const [{ role } = { role: "" }] = await db.query<{ role: string }>(
    `SELECT ${APP_ROLE} AS role`,
  );
  const unset = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE "${role}"`);
    return tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM sessions`);
  });
  assert.equal(Number(unset[0]?.n), 0);

  // The role and the organisation do not outlive their transaction. Asked
  // on the very connection it ran on: a pool of one has no other.
  const one = dbUrl === "memory://" ? db : await openDb(dbUrl, { pool: 1 });
  try {
    const during = await one.asOrg("org-a", (scoped) =>
      scoped.query<{ who: string; org: string }>(`SELECT current_user AS who, current_setting('sessionly.org_id', true) AS org`),
    );
    assert.deepEqual(during, [{ who: role, org: "org-a" }]);
    const [after] = await one.query<{ who: string; org: string | null; n: unknown }>(
      `SELECT current_user AS who, current_setting('sessionly.org_id', true) AS org,
              (SELECT count(*) FROM sessions) AS n`,
    );
    assert.notEqual(after?.who, role);
    assert.ok(!after?.org, `organisation still set: ${after?.org}`);
    assert.ok(Number(after?.n) >= 4);
    // A transaction that fails leaves nothing set either.
    await assert.rejects(one.asOrg("org-a", (scoped) => scoped.query(`SELECT 1 / 0`)));
    const [then] = await one.query<{ who: string; org: string | null }>(
      `SELECT current_user AS who, current_setting('sessionly.org_id', true) AS org`,
    );
    assert.notEqual(then?.who, role);
    assert.ok(!then?.org);
  } finally {
    if (one !== db) await one.close();
  }
});

test("requests are granted exactly the tables they must reach", async () => {
  const granted = await db.query<{ name: string; can: string }>(
    `SELECT c.relname AS name,
            concat_ws(',',
              CASE WHEN has_table_privilege(r.role, c.oid, 'SELECT') THEN 'select' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'INSERT') THEN 'insert' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'UPDATE') THEN 'update' END,
              CASE WHEN has_table_privilege(r.role, c.oid, 'DELETE') THEN 'delete' END) AS can
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
          (SELECT ${APP_ROLE} AS role) r
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
  );
  const can = Object.fromEntries(granted.map((t) => [t.name, t.can]));
  // Everything an organisation owns: all of it, behind row-level security.
  for (const table of ["tokens", "sessions", "pull_requests"]) assert.equal(can[table], "select,insert,update,delete", table);
  // Its own row of the organisations, to read.
  assert.equal(can.orgs, "select");
  // And nothing else: not the record of migrations.
  assert.equal(can.migrations, "");
  // A table with an org column that requests cannot reach was forgotten.
  const scoped = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`,
  );
  for (const { name } of scoped) assert.match(can[name] ?? "", /select/, name);
});

test("two people storing the same new session at once: one has it, the other is told", async () => {
  const ann = await tokenFor(db, { email: "ann@a.example", role: "member" }, "org-a");
  const bob = await tokenFor(db, { email: "bob@a.example", role: "member" }, "org-a");
  for (let round = 0; round < 5; round++) {
    const id = `raced-${round}`;
    const answers = await Promise.all([put(ann, session(id)), put(bob, session(id))]);
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409], id);
    const winner = answers[0]?.status === 200 ? "ann@a.example" : "bob@a.example";
    assert.equal((await call(a.admin, "GET", `/sessions/m1/claude-code/${id}`)).body.owner_email, winner);
  }
});

/** The statement a start-up error tells the database's admin to run. */
function whatToRun(err: Error): string {
  const block = /DO \$\$[\s\S]*?END \$\$;/.exec(err.message)?.[0];
  assert.ok(block, err.message);
  return block;
}

test("a database user who may not make roles is told what its admin must run", async (t) => {
  if (!process.env.TEST_DATABASE_ADMIN_URL) return t.skip("needs TEST_DATABASE_ADMIN_URL and a user without CREATEROLE");
  const url = await testDbUrl({ provision: false });
  const name = new URL(url).pathname.slice(1);
  const role = appRoleOf(name);
  let told: Error | undefined;
  await assert.rejects(openDb(url), (err: Error) => {
    assert.match(err.message, new RegExp(`"${role}", does not exist`));
    assert.match(err.message, new RegExp(`connected to the database "${name}"`));
    told = err;
    return true;
  });
  // The role made but not granted: it says so, and what it prints does not
  // trip over the role being there already.
  await adminRuns(name, `CREATE ROLE "${role}" NOLOGIN`);
  await assert.rejects(openDb(url), (err: Error) => {
    assert.match(err.message, new RegExp(`has not been granted the role requests run as, "${role}"`));
    assert.equal(whatToRun(err), whatToRun(told!));
    return true;
  });
  // What it printed is all that was needed, and running it again is harmless.
  await adminRuns(name, whatToRun(told!));
  await adminRuns(name, whatToRun(told!));
  const opened = await openDb(url);
  try {
    const [who] = await opened.asOrg("default", (scoped) => scoped.query<{ who: string }>(`SELECT current_user AS who`));
    assert.equal(who?.who, role);
  } finally {
    await opened.close();
  }
});

test("a database that was renamed gets a role for its new name at the next start", async (t) => {
  const url = await testDbUrl();
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const before = await openDb(url);
  await newOrg(before, "org-a");
  const token = await tokenFor(before, { email: "ann@a.example", role: "admin" }, "org-a");
  const [was] = await before.query<{ role: string }>(`SELECT ${APP_ROLE} AS role`);
  await before.close();

  const renamed = await renameTestDb(url);
  const name = new URL(renamed).pathname.slice(1);
  if (process.env.TEST_DATABASE_ADMIN_URL) {
    // This user may not make the new role: the start fails, and says what to run.
    let told = "";
    await assert.rejects(openDb(renamed), (err: Error) => {
      told = whatToRun(err);
      return true;
    });
    await adminRuns(name, told);
  }
  const now = await openDb(renamed);
  try {
    const [is] = await now.query<{ role: string }>(`SELECT ${APP_ROLE} AS role`);
    assert.equal(is?.role, appRoleOf(name));
    assert.notEqual(is?.role, was?.role);
    // Requests work, and see what was there.
    const asked = await createApp(now).request("/api/v1/tokens", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(asked.status, 200);
    assert.equal(((await asked.json()) as any).tokens.length, 1);
    // The role of the old name holds nothing here any more.
    const [old] = await now.query<{ can: boolean }>(
      `SELECT bool_or(has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE')) AS can
       FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
      [was?.role],
    );
    assert.equal(old?.can, false);
  } finally {
    await now.close();
  }
  // A start with nothing missing changes nothing.
  await (await openDb(renamed)).close();
});

test("the role's name fits whatever the database is called", async (t) => {
  // 25 two-byte letters: with the suffix of a test database a name of 62
  // bytes, which Postgres takes whole, and no room for anything before it.
  const long = "é".repeat(25);
  assert.equal(Buffer.byteLength(appRoleOf(`${long}0123456789ab`)), 30);
  // Names that begin alike for longer than a name may be do not share a role.
  assert.notEqual(appRoleOf(`${"a".repeat(60)}1`), appRoleOf(`${"a".repeat(60)}2`));
  const url = await testDbUrl({ prefix: long });
  if (url === "memory://") return t.skip("the rest needs a Postgres server (TEST_DATABASE_URL)");
  const odd = await openDb(url);
  try {
    const [who] = await odd.asOrg("default", (scoped) =>
      scoped.query<{ who: string; name: string }>(`SELECT current_user AS who, current_database() AS name`),
    );
    assert.equal(who?.who, appRoleOf(who?.name ?? ""));
  } finally {
    await odd.close();
  }
});

test("a Postgres older than 16 is refused", () => {
  assert.equal(versionProblem(160000), null);
  assert.equal(versionProblem(180001), null);
  assert.match(versionProblem(150014) ?? "", /needs Postgres 16 or later; this server is 15\.14/);
});

test("every table that belongs to an organisation has row-level security on", async () => {
  const tables = await db.query<{ name: string; secured: boolean }>(
    `SELECT c.relname AS name, c.relrowsecurity AS secured
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (c.relname = 'orgs' OR EXISTS (
         SELECT 1 FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped))
     ORDER BY 1`,
  );
  assert.ok(tables.length >= 4, JSON.stringify(tables));
  assert.deepEqual(tables.filter((t) => !t.secured).map((t) => t.name), []);
});

test("what a request wrote before it failed does not stay", async () => {
  const failed = await call(a.admin, "POST", "/write-then-fail");
  assert.equal(failed.status, 409);
  const emails = (await call(a.admin, "GET", "/tokens")).body.tokens.map((t: any) => t.email);
  assert.ok(!emails.includes("left-behind@a.example"), emails.join(", "));
});

test("an expired token, and a token of an organisation being deleted, are nobody's", async () => {
  await newOrg(db, "org-c");
  const token = await tokenFor(db, { email: "cy@c.example", role: "admin" }, "org-c");
  assert.equal((await call(token, "GET", "/ping")).status, 200);
  await db.query(`UPDATE tokens SET expires_at = now() - interval '1 second' WHERE org_id = 'org-c'`);
  assert.equal((await call(token, "GET", "/ping")).status, 401);
  await db.query(`UPDATE tokens SET expires_at = now() + interval '1 hour' WHERE org_id = 'org-c'`);
  assert.equal((await call(token, "GET", "/ping")).status, 200);
  await db.query(`UPDATE orgs SET deleted_at = now() WHERE id = 'org-c'`);
  assert.equal((await call(token, "GET", "/ping")).status, 401);
  // Deleting the organisation takes everything of it along.
  await db.query(`DELETE FROM orgs WHERE id = 'org-c'`);
  const [left] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM tokens WHERE org_id = 'org-c'`);
  assert.equal(Number(left?.n), 0);
});

test("a database from before organisations lands in the default one", async (t) => {
  // On Postgres where the tests run on one; else a folder for the embedded database.
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-upgrade-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const dir = folder ? `file:${join(folder, "db")}` : fresh;
  // As a server before this one left it, with a token, a session and a pull request.
  const old = await openDb(dir, { migrations: FIRST_ORG_MIGRATION });
  const hash = await import("node:crypto").then((c) => c.createHash("sha256").update("old-token").digest("hex"));
  await old.query(
    `INSERT INTO tokens (id, token_hash, email, role) VALUES ('t1', $1, 'boss@example.com', 'admin')`,
    [hash],
  );
  await old.query(
    `INSERT INTO sessions (machine_id, source, session_id, owner_email, content, payload)
     VALUES ('m1', 'claude-code', 'old-1', 'boss@example.com', 'metadata', '{"session":{"session_id":"old-1"}}')`,
  );
  await old.query(
    `INSERT INTO pull_requests (repo, number, author, state, first_event, last_event, first_files, last_files, attribution)
     VALUES ('github.com/acme/web', 3, 'ann', 'open', 'opened', 'opened', '[]', '[]',
             '{"first":{"lines":0,"agent_lines":0},"now":{"lines":0,"agent_lines":0,"by":[]},"by":[]}')`,
  );
  await old.close();

  const upgraded = await openDb(dir);
  try {
    const now = createApp(upgraded, { bootstrap: { token: "from-the-environment", email: "root@example.com" } });
    const ask = async (token: string, path: string) =>
      (await now.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
    // The old token still works, in the default organisation, and sees what was there.
    for (const token of ["old-token", "from-the-environment"]) {
      assert.equal((await ask(token, "/me")).org, "default");
      assert.equal((await ask(token, "/sessions")).total, 1);
      assert.equal((await ask(token, "/prs")).total, 1);
    }
    // Opening it again changes nothing.
  } finally {
    await upgraded.close();
  }
  await (await openDb(dir)).close();
});

test("several copies of the server starting at once migrate once", async (t) => {
  const url = await testDbUrl();
  // The embedded database belongs to one process.
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const copies = await Promise.all([openDb(url), openDb(url), openDb(url), openDb(url)]);
  try {
    const [ran] = await copies[0]!.query<{ n: unknown }>(`SELECT count(*) AS n FROM migrations`);
    const [orgs] = await copies[0]!.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`);
    assert.ok(Number(ran?.n) > FIRST_ORG_MIGRATION);
    assert.equal(Number(orgs?.n), 1);
  } finally {
    await Promise.all(copies.map((copy) => copy.close()));
  }
});

test("connections the database closes do not end the server", async (t) => {
  const url = await testDbUrl();
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const pooled = await openDb(url, { pool: 2 });
  const lost: string[] = [];
  const error = console.error;
  console.error = (line: string) => void lost.push(String(line));
  try {
    // Two connections, sitting unused, closed from the database's side.
    await Promise.all([pooled.query(`SELECT pg_sleep(0.05)`), pooled.query(`SELECT pg_sleep(0.05)`)]);
    await adminRuns(
      new URL(url).pathname.slice(1),
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still here, and the next request gets a connection that works.
    const [row] = await pooled.asOrg("default", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`));
    assert.equal(Number(row?.n), 1);
    assert.ok(lost.some((line) => /connection was lost while idle/.test(line)), lost.join("\n"));
  } finally {
    console.error = error;
    await pooled.close();
  }
});

test("a connection the database closes under a request fails that request and no more", async (t) => {
  const url = await testDbUrl();
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const pooled = await openDb(url, { pool: 2 });
  const name = new URL(url).pathname.slice(1);
  const cut = () =>
    adminRuns(name, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const error = console.error;
  console.error = () => {};
  try {
    // In the middle of a statement.
    const asking = assert.rejects(pooled.asOrg("default", (scoped) => scoped.query(`SELECT pg_sleep(5)`)));
    await pause(150);
    await cut();
    await asking;
    // Between two statements of one transaction.
    const between = pooled.asOrg("default", async (scoped) => {
      await scoped.query(`SELECT 1`);
      await cut();
      await pause(150);
      return scoped.query(`SELECT 2`);
    });
    await assert.rejects(between);
    // And as the owner, in a transaction of its own.
    const owner = pooled.transaction(async (tx) => {
      await tx.query(`SELECT 1`);
      await cut();
      await pause(150);
    });
    await assert.rejects(owner);
    await pause(100);
    // The server is still here, and the next request gets a connection that works.
    const [row] = await pooled.asOrg("default", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`));
    assert.equal(Number(row?.n), 1);
  } finally {
    console.error = error;
    await pooled.close();
  }
});

test("why the database could not be opened is said, whatever shape the error has", () => {
  assert.equal(reason(new Error("password authentication failed")), "password authentication failed");
  // A refused connection: one error per address tried, under one with no message.
  const refused = new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED ::1:5432"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
  ]);
  assert.equal(refused.message, "");
  assert.equal(reason(refused), "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432");
  assert.equal(reason(Object.assign(new Error(""), { code: "ETIMEDOUT" })), "ETIMEDOUT");
  assert.equal(reason("plain text"), "plain text");
});

test("a hosted service refuses what only a single install may have", () => {
  const postgres = "postgres://app@db.internal/sessionly";
  assert.deepEqual(hostedProblems({ DATABASE_URL: postgres }), []);
  assert.match(hostedProblems({ DATABASE_URL: postgres, SESSIONLY_ADMIN_TOKEN: "x" }).join(), /no admin of every organisation/);
  assert.match(hostedProblems({}).join(), /postgres:\/\//);
  assert.match(hostedProblems({ DATABASE_URL: "file:/data" }).join(), /postgres:\/\//);
});
