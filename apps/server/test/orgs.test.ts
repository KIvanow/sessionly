// Organisations: what one stores, another must never see, change or be told of.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import pg from "pg";
import { ApiError, createApp, failureLog, type Env } from "../src/app.ts";
import { createToken } from "../src/auth.ts";
import { APP_ROLE, appRoleOf, capped, count, DB_COUNTS, FIRST_ORG_MIGRATION, misset, openDb, versionProblem, type Db } from "../src/db.ts";
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
  const tables = ["sessions", "pull_requests", "pull_request_reports", "tokens", "orgs"];
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
  for (const table of ["tokens", "sessions", "pull_requests", "pull_request_reports", "repo_exclusions", "repos_allowed_again"]) assert.equal(can[table], "select,insert,update,delete", table);
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
    // The pull request it already had is the first row of its history, so the next change has something to compare with.
    const page = await ask("old-token", "/prs/detail?repo=github.com/acme/web&number=3");
    assert.equal(page.history.length, 1);
    assert.deepEqual(
      [page.history[0].event, page.history[0].lines, page.history[0].agent_lines, page.history[0].commits, page.history[0].change.reason],
      ["opened", 0, 0, 0, null],
    );
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

/** Closes, from the database's side, every connection to this database but the one asking. A row for each. */
const ENDED = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`;

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
    await adminRuns(new URL(url).pathname.slice(1), ENDED);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still here, and the next request gets a connection that works.
    const [row] = await pooled.asOrg("default", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`));
    assert.equal(Number(row?.n), 1);
    // Each of the two is said once, though a closing connection reports it twice.
    assert.equal(lost.filter((line) => /^A database connection was lost: /.test(line)).length, 2, lost.join("\n"));
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
  // How many connections were closed.
  const cut = async () => (await adminRuns(name, ENDED)).length;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const lost: string[] = [];
  const error = console.error;
  console.error = (line: string) => void lost.push(String(line));
  let closed = 0;
  try {
    // In the middle of a statement.
    const asking = assert.rejects(pooled.asOrg("default", (scoped) => scoped.query(`SELECT pg_sleep(5)`)));
    await pause(150);
    closed += await cut();
    await asking;
    // Between two statements of one transaction.
    const between = pooled.asOrg("default", async (scoped) => {
      await scoped.query(`SELECT 1`);
      closed += await cut();
      await pause(150);
      return scoped.query(`SELECT 2`);
    });
    await assert.rejects(between);
    // And as the owner, in a transaction of its own.
    const owner = pooled.transaction(async (tx) => {
      await tx.query(`SELECT 1`);
      closed += await cut();
      await pause(150);
    });
    await assert.rejects(owner);
    await pause(100);
    // The server is still here, and the next request gets a connection that works.
    const [row] = await pooled.asOrg("default", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`));
    assert.equal(Number(row?.n), 1);
    // Said once for each connection, however it was lost.
    assert.ok(closed >= 3, `${closed} closed`);
    assert.equal(lost.filter((line) => /^A database connection was lost: /.test(line)).length, closed, lost.join("\n"));
  } finally {
    console.error = error;
    await pooled.close();
  }
});

test("every connection closing again and again under many requests leaves the server standing", async (t) => {
  const url = await testDbUrl();
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  // Many more requests than connections, so that a connection one request
  // gives back goes straight to the next: the moment at which, for an
  // instant, neither the pool nor a request used to be listening to it.
  const pooled = await openDb(url, { pool: 10 });
  const name = new URL(url).pathname.slice(1);
  const error = console.error;
  console.error = () => {};
  let answered = 0;
  let failed = 0;
  let over = false;
  const asks = async (i: number) => {
    while (!over) {
      try {
        // Half through the pool directly, half in a transaction as an organisation.
        if (i % 2) await pooled.query(`SELECT pg_sleep(0.005)`);
        else await pooled.asOrg("default", (scoped) => scoped.query(`SELECT count(*) FROM orgs`));
        answered++;
      } catch {
        failed++;
      }
    }
  };
  try {
    const asking = Array.from({ length: 200 }, (_, i) => asks(i));
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
      await adminRuns(name, ENDED);
    }
    over = true;
    await Promise.all(asking);
    assert.ok(failed > 0 && answered > failed, `${answered} answered, ${failed} failed`);
    const [row] = await pooled.asOrg("default", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`));
    assert.equal(Number(row?.n), 1);
  } finally {
    over = true;
    console.error = error;
    await pooled.close();
  }
});

test("a database that never answers is given up on, at the start and when every connection is taken", async (t) => {
  // Something that takes the connection and says nothing, as a host behind a
  // firewall that drops what it is sent.
  const taken: Socket[] = [];
  const silent = createServer((socket) => void taken.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as AddressInfo;
  try {
    const began = Date.now();
    // Said with where the database is and how long it was given, and without the password.
    await assert.rejects(
      openDb(`postgres://app:hunter2@127.0.0.1:${port}/sessionly`, { connectMs: 300 }),
      (err: Error) => err.message.startsWith(`The database at 127.0.0.1:${port} did not answer within 0.3 seconds (`) && !/hunter2/.test(err.message),
    );
    assert.ok(Date.now() - began < 3000, `${Date.now() - began} ms`);
  } finally {
    for (const socket of taken) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }

  const url = await testDbUrl();
  if (url === "memory://") return t.skip("the rest needs a Postgres server (TEST_DATABASE_URL)");
  const pooled = await openDb(url, { pool: 1, connectMs: 300 });
  try {
    const holding = pooled.transaction((tx) => tx.query(`SELECT pg_sleep(1)`));
    await assert.rejects(pooled.query(`SELECT 1`), /timeout/);
    await assert.rejects(
      pooled.asOrg("default", (scoped) => scoped.query(`SELECT 1`)),
      /timeout/,
    );
    await holding;
    // Free again, and it answers.
    assert.deepEqual(await pooled.query(`SELECT 1 AS n`), [{ n: 1 }]);
  } finally {
    await pooled.close();
  }
});

/**
 * Something between the server and the database that can go silent on the
 * connections it has: what is sent on them goes nowhere and nothing comes
 * back, and nothing says they are closed. New connections pass as before.
 * That is how a failover can leave the old ones.
 */
async function silencer(url: string): Promise<{ url: string; silence(): number; close(): Promise<void> }> {
  const to = new URL(url);
  const open: { near: Socket; far: Socket; silent: boolean }[] = [];
  const server = createServer((near) => {
    const far = connect(Number(to.port || 5432), to.hostname);
    const pair = { near, far, silent: false };
    open.push(pair);
    near.on("data", (data) => void (pair.silent || far.write(data)));
    far.on("data", (data) => void (pair.silent || near.write(data)));
    near.on("error", () => {});
    far.on("error", () => {});
    // A connection that went silent does not say that its other end closed either.
    near.on("close", () => void (pair.silent || far.destroy()));
    far.on("close", () => void (pair.silent || near.destroy()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const through = new URL(url);
  through.hostname = "127.0.0.1";
  through.port = String((server.address() as AddressInfo).port);
  return {
    url: through.toString(),
    silence() {
      const live = open.filter((pair) => !pair.silent && !pair.near.destroyed);
      for (const pair of live) pair.silent = true;
      return live.length;
    },
    async close() {
      for (const { near, far } of open) {
        near.destroy();
        far.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("connections that go silent are given up on, and the server finds new ones by itself", async (t) => {
  const direct = await testDbUrl();
  if (direct === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const between = await silencer(direct);
  // A statement may take 400 ms, and an answer is given up on a fifth later.
  const pooled = await openDb(between.url, { pool: 3, queryMs: 400 });
  const count = () => pooled.asOrg("default", (scoped) => scoped.query<{ n: unknown }>(`SELECT count(*) AS n FROM orgs`));
  try {
    // Every connection of the pool is open and unused.
    await Promise.all([count(), count(), count()]);
    assert.equal(between.silence(), 3);
    // More requests than connections, through the pool and in transactions.
    // Those that get an old connection fail once the wait is over; the rest
    // are answered on new ones, and nobody restarted anything.
    const began = Date.now();
    const asked = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? pooled.query(`SELECT 1 AS n`) : count())),
    );
    const failed = asked.filter((each) => each.status === "rejected");
    assert.equal(failed.length, 3, asked.map((each) => each.status).join(" "));
    for (const each of failed) assert.match(String((each as PromiseRejectedResult).reason), /Query read timeout/);
    assert.ok(Date.now() - began < 2000, `${Date.now() - began} ms`);
    // From here on, as if nothing had happened.
    const after = Date.now();
    for (let i = 0; i < 6; i++) assert.equal(Number((await count())[0]?.n), 1);
    assert.ok(Date.now() - after < 400, `${Date.now() - after} ms`);

    // Silent in the middle of a transaction: its next statement is given up
    // on once, not a second time to undo what cannot be reached.
    const inside = Date.now();
    await assert.rejects(
      pooled.asOrg("default", async (scoped) => {
        await scoped.query(`SELECT 1`);
        between.silence();
        return scoped.query(`SELECT 2`);
      }),
      /Query read timeout/,
    );
    assert.ok(Date.now() - inside < 900, `${Date.now() - inside} ms`);
    // The other two went silent with it, unused. They are found the same way.
    const again = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? pooled.query(`SELECT 1 AS n`) : count())));
    assert.equal(again.filter((each) => each.status === "rejected").length, 2);
    assert.equal(Number((await count())[0]?.n), 1);
    assert.deepEqual(await pooled.query(`SELECT 1 AS n`), [{ n: 1 }]);
  } finally {
    await pooled.close();
    await between.close();
  }
});

test("a statement that takes too long is ended by the database, and its connection is used again", async (t) => {
  const url = await testDbUrl();
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  const pooled = await openDb(url, { pool: 1, queryMs: 300 });
  const connection = async () => (await pooled.transaction((tx) => tx.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)))[0]?.pid;
  try {
    const before = await connection();
    const began = Date.now();
    await assert.rejects(
      pooled.asOrg("default", (scoped) => scoped.query(`SELECT pg_sleep(5)`)),
      (err: Error & { code?: string }) => err.code === "57014",
    );
    assert.ok(Date.now() - began < 360, `${Date.now() - began} ms: the database's limit comes before this side's`);
    // The database said no, so the connection is as good as it was.
    assert.equal(await connection(), before);
    // One statement on its own has the limit too: the database ends it,
    // and does not go on with it after this side has stopped waiting.
    const alone = Date.now();
    await assert.rejects(pooled.query(`SELECT pg_sleep(5)`), (err: Error & { code?: string }) => err.code === "57014");
    assert.ok(Date.now() - alone < 360, `${Date.now() - alone} ms`);
    assert.deepEqual(await pooled.query(`SHOW statement_timeout`), [{ statement_timeout: "300ms" }]);
    assert.deepEqual(await adminRuns(new URL(url).pathname.slice(1), `SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(5)%' AND state = 'active'`), []);
    // A transaction left open and unused is ended by the database too.
    await assert.rejects(
      pooled.transaction(async (tx) => {
        await tx.query(`SELECT 1`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        return tx.query(`SELECT 2`);
      }),
    );
    // Bringing the database up to date is not limited: a large table takes what it takes.
    await pooled.transaction((tx) => tx.query(`SELECT pg_sleep(0.7)`), { patient: true });
    // It sets its own, for as long as it lasts.
    const [left] = await pooled.transaction(
      (tx) => tx.query<{ statement: string; idle: string }>(
        `SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`,
      ),
      { patient: true },
    );
    assert.deepEqual(left, { statement: "0", idle: "0" });
    assert.deepEqual(await pooled.query(`SHOW idle_in_transaction_session_timeout`), [{ idle_in_transaction_session_timeout: "0" }]);
  } finally {
    const error = console.error;
    console.error = () => {};
    await pooled.close();
    console.error = error;
  }
});

test("a connection that fails as the pool hands it to a waiting request is heard", async (t) => {
  const url = await testDbUrl();
  if (url === "memory://") return t.skip("needs a Postgres server (TEST_DATABASE_URL)");
  // One connection, and a transaction waiting for it behind a statement.
  // When the statement is done the pool takes its own listener off the
  // connection and hands it over, and the transaction has not put its own
  // on yet. An "error" at that moment is put there by hand here, since no
  // amount of closing connections is sure to hit it. With nobody listening
  // it is thrown, inside the pool, which ends a server: so that is looked
  // at first, and the error is sent only if someone will hear it.
  type Emitter = {
    removeListener(name: string, listener: { name?: string }): unknown;
    emit(name: string, err: Error): boolean;
    listenerCount(name: string): number;
  };
  const client = pg.Client.prototype as unknown as Emitter;
  const removeListener = client.removeListener;
  let gaps = 0;
  let unheard = 0;
  let armed = false;
  client.removeListener = function (this: Emitter, name, listener) {
    const out = removeListener.call(this, name, listener);
    if (armed && name === "error" && listener.name === "idleListener") {
      gaps++;
      if (this.listenerCount("error") === 0) unheard++;
      else this.emit("error", new Error("closed between the pool and a request"));
    }
    return out;
  };
  const lost: string[] = [];
  const error = console.error;
  console.error = (line: string) => void lost.push(String(line));
  const pooled = await openDb(url, { pool: 1 });
  try {
    const first = pooled.query(`SELECT pg_sleep(0.2)`);
    const waiting = pooled.transaction((tx) => tx.query<{ n: number }>(`SELECT 1 AS n`));
    // The statement has the connection by now: the next handing over is to the transaction.
    await new Promise((resolve) => setTimeout(resolve, 50));
    armed = true;
    await first;
    assert.deepEqual(await waiting, [{ n: 1 }]);
    armed = false;
    // The moment came once, someone was listening, and what was said was heard.
    assert.equal(gaps, 1);
    assert.equal(unheard, 0, "nobody was listening to the connection: an error then ends the server");
    assert.deepEqual(lost, ["A database connection was lost: closed between the pool and a request"]);
  } finally {
    armed = false;
    client.removeListener = removeListener;
    console.error = error;
    await pooled.close();
  }
});

test("a setting that is a count is a whole number in plain digits, or is left out and said", () => {
  assert.equal(count("10"), 10);
  assert.equal(count(" 25 "), 25);
  assert.equal(count("2147483647"), 2_147_483_647);
  for (const not of [undefined, "", " ", "0", "-1", "0.5", "1.0", "1e3", "0x10", "0b11", "ten", "10 20", "2147483648", "99999999999", "Infinity"]) {
    assert.equal(count(not), undefined, String(not));
  }
  assert.deepEqual(misset({ SESSIONLY_DB_POOL: "20", SESSIONLY_DB_QUERY_SECONDS: "60" }, DB_COUNTS), []);
  assert.deepEqual(misset({ SESSIONLY_DB_POOL: "" }, DB_COUNTS), []);
  const notes = misset({ SESSIONLY_DB_POOL: "0x10", SESSIONLY_DB_QUERY_SECONDS: "1e3" }, DB_COUNTS);
  assert.equal(notes.length, 2);
  assert.match(notes[0] ?? "", /^SESSIONLY_DB_POOL is "0x10", which is not a whole number above 0/);
  assert.match(notes[1] ?? "", /^SESSIONLY_DB_QUERY_SECONDS is "1e3"/);
});

test("a limit set very high, to mean none, is a day and is said", async (t) => {
  // Two million seconds is 23 days. A fifth more, in milliseconds, is past
  // what a timer here can count, which then goes off at once; a little more
  // is past what the database takes. Every request would fail.
  assert.equal(capped({ SESSIONLY_DB_QUERY_SECONDS: "2000000" }, "SESSIONLY_DB_QUERY_SECONDS"), 86_400);
  assert.equal(capped({ SESSIONLY_DB_QUERY_SECONDS: "86400" }, "SESSIONLY_DB_QUERY_SECONDS"), 86_400);
  assert.equal(capped({ SESSIONLY_DB_QUERY_SECONDS: "45" }, "SESSIONLY_DB_QUERY_SECONDS"), 45);
  assert.equal(capped({ SESSIONLY_DB_POOL: "2000000" }, "SESSIONLY_DB_POOL"), 2_000_000);
  assert.deepEqual(misset({ SESSIONLY_DB_QUERY_SECONDS: "2000000" }, DB_COUNTS), [
    "SESSIONLY_DB_QUERY_SECONDS is 2000000, and may be 86400 at most (a day): 86400 is used.",
  ]);
  assert.deepEqual(misset({ SESSIONLY_DB_QUERY_SECONDS: "86400" }, DB_COUNTS), []);

  const url = await testDbUrl();
  if (url === "memory://") return t.skip("the rest needs a Postgres server (TEST_DATABASE_URL)");
  const set = process.env.SESSIONLY_DB_QUERY_SECONDS;
  const limits = (db: Db) =>
    db.asOrg("default", (scoped) => scoped.query<{ limit: string }>(`SELECT current_setting('statement_timeout') AS limit`));
  for (const seconds of ["2000000", "2147483647"]) {
    process.env.SESSIONLY_DB_QUERY_SECONDS = seconds;
    const pooled = await openDb(url, { pool: 1 }).finally(() => {
      if (set === undefined) delete process.env.SESSIONLY_DB_QUERY_SECONDS;
      else process.env.SESSIONLY_DB_QUERY_SECONDS = set;
    });
    try {
      // Requests are answered, in a transaction and outside one, under a limit of a day.
      assert.deepEqual(await limits(pooled), [{ limit: "1d" }]);
      assert.deepEqual(await pooled.query(`SELECT 1 AS n`), [{ n: 1 }]);
      assert.deepEqual(await pooled.query(`SHOW statement_timeout`), [{ statement_timeout: "1d" }]);
    } finally {
      await pooled.close();
    }
  }
  // The same for a limit handed to openDb directly.
  const direct = await openDb(url, { pool: 1, queryMs: 2_000_000_000 });
  try {
    assert.deepEqual(await limits(direct), [{ limit: "1d" }]);
  } finally {
    await direct.close();
  }
});

test("requests that all fail are written out a few at a time, with a count of the rest", () => {
  const said: unknown[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 1_000_000;
  const failed = failureLog({
    each: 2,
    ms: 10_000,
    say: (what) => void said.push(what),
    now: () => now,
    later: (fn, ms) => void timers.push({ fn, ms }),
  });
  const errors = Array.from({ length: 3000 }, (_, i) => new Error(`failed ${i}`));
  for (const err of errors) failed(err);
  // The first two as they are, and nothing of the other 2998 yet.
  assert.deepEqual(said, errors.slice(0, 2));
  now += 9_999;
  failed(new Error("still within the ten seconds"));
  assert.equal(said.length, 2);
  // One timer, for the end of the ten seconds, however many were left out.
  assert.deepEqual(timers.map((timer) => timer.ms), [10_000]);
  // The ten seconds end and nothing fails after them: the count is said all the same.
  now += 1;
  timers.shift()?.fn();
  assert.deepEqual(said.slice(2), ["2999 more requests failed in those 10 seconds, and are not written out."]);
  // The next failure is written out itself, and the count is not said twice.
  const next = new Error("later");
  failed(next);
  assert.deepEqual(said.slice(3), [next]);
  // Failures that go on past the ten seconds: the next one says the count,
  // and the timer that comes after it has nothing left to say.
  failed(next);
  failed(new Error("left out"));
  now += 4_000;
  failed(new Error("left out"));
  assert.deepEqual(timers.map((timer) => timer.ms), [10_000]);
  now += 6_000;
  failed(next);
  assert.deepEqual(said.slice(5), ["2 more requests failed in those 10 seconds, and are not written out.", next]);
  timers.shift()?.fn();
  assert.equal(said.length, 7);
  // A quiet stretch leaves nothing to say.
  now += 60_000;
  failed(next);
  assert.equal(said.length, 8);
  assert.equal(timers.length, 0);

  // Ten seconds that begin while the timer of the ten before is still to
  // go off: that timer finds them running, and waits for their end too.
  // Their count is said then, though nothing fails afterwards.
  failed(next);
  failed(new Error("left out of the first"));
  assert.deepEqual(timers.map((timer) => timer.ms), [10_000]);
  now += 12_000;
  for (let i = 0; i < 4; i++) failed(next);
  assert.deepEqual(said.slice(8), [next, "1 more requests failed in those 10 seconds, and are not written out.", next, next]);
  assert.equal(timers.length, 1);
  now += 3_000;
  timers.shift()?.fn();
  assert.equal(said.length, 12);
  assert.deepEqual(timers.map((timer) => timer.ms), [7_000]);
  now += 7_000;
  timers.shift()?.fn();
  assert.deepEqual(said.slice(12), ["2 more requests failed in those 10 seconds, and are not written out."]);
  assert.equal(timers.length, 0);
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
