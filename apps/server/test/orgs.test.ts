// Organisations: what one stores, another must never see, change or be told of.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hono } from "hono";
import { ApiError, createApp, type Env } from "../src/app.ts";
import { createToken } from "../src/auth.ts";
import { FIRST_ORG_MIGRATION, openDb, type Db } from "../src/db.ts";
import { hostedProblems } from "../src/run.ts";
import { newOrg, testDb, testDbUrl, tokenFor, tokenWithId } from "./helpers.ts";

let db: Db;
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
  db = await testDb();
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
  assert.deepEqual(
    (await call(b.admin, "GET", "/tokens")).body.tokens.map((t: any) => t.email).sort(),
    ["ann@b.example", "boss@b.example", "ci@b.example", "cloud@b.example"],
  );
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
  const unset = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE sessionly_app`);
    return tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM sessions`);
  });
  assert.equal(Number(unset[0]?.n), 0);
  // And the role does not outlive its transaction.
  const [after] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM sessions`);
  assert.ok(Number(after?.n) >= 4);
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

test("a database from before organisations lands in the default one", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sessionly-upgrade-")), "db");
  // As a server before this one left it, with a token, a session and a pull request.
  const old = await openDb(`file:${dir}`, { migrations: FIRST_ORG_MIGRATION });
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

  const upgraded = await openDb(`file:${dir}`);
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
  await (await openDb(`file:${dir}`)).close();
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

test("a hosted service refuses what only a single install may have", () => {
  const postgres = "postgres://app@db.internal/sessionly";
  assert.deepEqual(hostedProblems({ DATABASE_URL: postgres }), []);
  assert.match(hostedProblems({ DATABASE_URL: postgres, SESSIONLY_ADMIN_TOKEN: "x" }).join(), /no admin of every organisation/);
  assert.match(hostedProblems({}).join(), /postgres:\/\//);
  assert.match(hostedProblems({ DATABASE_URL: "file:/data" }).join(), /postgres:\/\//);
});
