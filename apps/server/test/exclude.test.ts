// Stopping a repository: a person's sessions from it are deleted, and a later
// upload of it is not stored. Other people's sessions are left as they are.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseRepo, repoCovered, type Upload } from "@sessionly/schema";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { newOrg, testDb, tokenFor } from "./helpers.ts";

test("a repository name and what it covers", () => {
  assert.deepEqual(parseRepo(" ~/Downloads/ "), { ok: true, name: { repo: "~/Downloads", coversFolders: true } });
  assert.deepEqual(parseRepo("~\\Downloads\\"), { ok: true, name: { repo: "~/Downloads", coversFolders: true } });
  assert.deepEqual(parseRepo("~/"), { ok: true, name: { repo: "~", coversFolders: true } });
  assert.deepEqual(parseRepo("/tmp/notes"), { ok: true, name: { repo: "/tmp/notes", coversFolders: true } });
  assert.deepEqual(parseRepo("github.com/acme/web"), {
    ok: true,
    name: { repo: "github.com/acme/web", coversFolders: false },
  });
  for (const bad of ["", "   ", "/", 4, null]) assert.equal(parseRepo(bad).ok, false);
  assert.equal(parseRepo(`${"a".repeat(1025)}`).ok, false);
  assert.equal(parseRepo("has\na line break").ok, false);

  assert.equal(repoCovered("~/Downloads", "~/Downloads"), true);
  assert.equal(repoCovered("~/Downloads/notes", "~/Downloads"), true);
  assert.equal(repoCovered("~/Downloads\\notes", "~/Downloads"), true);
  assert.equal(repoCovered("~/Downloads-backup", "~/Downloads"), false);
  assert.equal(repoCovered("~/downloads", "~/Downloads"), false);
  assert.equal(repoCovered("github.com/acme/web", "github.com/acme/web"), true);
  assert.equal(repoCovered("github.com/acme/web-ui", "github.com/acme/web"), false);
  assert.equal(repoCovered("github.com/acme/web/extra", "github.com/acme/web"), false);
  assert.equal(repoCovered("~/Documents", "~"), true);
  assert.equal(repoCovered("/tmp/x", "~"), false);
  assert.equal(repoCovered("github.com/acme/web", "~"), false);
  assert.equal(repoCovered("~/100%_done/child", "~/100%_done"), true);
  assert.equal(repoCovered("~/100XYdone/child", "~/100%_done"), false);
});

let db: Db;
let app: ReturnType<typeof createApp>;
const tokens = { admin: "", ann: "", bob: "", env: "", ci: "" };

before(async () => {
  db = await testDb();
  app = createApp(db, {});
  tokens.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" });
  tokens.ann = await tokenFor(db, { email: "Ann@Example.com", name: "Ann", role: "member" });
  tokens.bob = await tokenFor(db, { email: "bob@example.com", role: "member" });
  tokens.env = await tokenFor(db, { email: "cloud@example.com", role: "env" });
  tokens.ci = await tokenFor(db, { email: "ci@example.com", role: "ci" });
});
after(() => db.close());

function upload(id: string, repo: { root: string; remote?: string | null }, email?: string): Upload {
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      source: "claude-code",
      machine_id: "m1",
      content: "metadata",
      session_id: id,
      user: email ? { email } : { email: "spoofed@example.com" },
      started_at: "2026-11-10T10:00:00Z",
      repo: { root: repo.root, remote: repo.remote ?? null, branch: "main" },
      counts: { prompts: 1, tool_calls: 1 },
    },
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function put(token: string, body: Upload) {
  const s = body.session!;
  const response = await app.request(`/api/v1/sessions/${s.machine_id}/${s.source}/${s.session_id}`, {
    method: "PUT",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { stored?: boolean; excluded?: boolean; error?: string } };
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await app.request(`/api/v1${path}`, {
    method,
    headers: { ...auth(token), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const ids = async (token: string) =>
  ((await call(token, "GET", "/sessions")).body.sessions as { session_id: string }[]).map((s) => s.session_id).sort();

test("stopping a repository deletes that person's sessions and refuses later ones", async () => {
  assert.deepEqual((await put(tokens.ann, upload("docs", { root: "~/Documents" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.ann, upload("dl", { root: "~/Downloads" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.ann, upload("nested", { root: "~/Downloads/notes" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.ann, upload("slash", { root: "~/Downloads\\secret" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.ann, upload("near", { root: "~/Downloads-backup" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.ann, upload("pct", { root: "~/100%_done/child" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.ann, upload("web", { root: "/src/web", remote: "github.com/acme/web" }))).body, { stored: true });
  // The same repository name, submitted by someone else, is not this person's.
  assert.deepEqual((await put(tokens.bob, upload("bob-dl", { root: "~/Downloads" }))).body, { stored: true });
  assert.deepEqual((await put(tokens.admin, upload("boss-docs", { root: "~/Documents" }))).body, { stored: true });

  const stopped = await call(tokens.ann, "PUT", "/repos/excluded", { repo: " ~/Downloads/ " });
  assert.equal(stopped.status, 200);
  assert.deepEqual(
    { repo: stopped.body.repo, n: stopped.body.sessions_removed, folders: stopped.body.covers_folders },
    { repo: "~/Downloads", n: 3, folders: true },
  );
  assert.deepEqual(await ids(tokens.ann), ["docs", "near", "pct", "web"]);
  assert.deepEqual(await ids(tokens.bob), ["bob-dl"]);
  assert.ok((await ids(tokens.admin)).includes("boss-docs"));

  // A later upload of it, or of a directory inside it, is not stored.
  assert.deepEqual((await put(tokens.ann, upload("dl-2", { root: "~/Downloads" }))).body, { stored: false, excluded: true });
  assert.deepEqual((await put(tokens.ann, upload("deep", { root: "~/Downloads/other" }))).body, { stored: false, excluded: true });
  assert.deepEqual((await put(tokens.bob, upload("bob-dl-2", { root: "~/Downloads/other" }))).body, { stored: true });
  assert.deepEqual(await ids(tokens.ann), ["docs", "near", "pct", "web"]);

  // A name with LIKE metacharacters covers only itself.
  const odd = await call(tokens.ann, "PUT", "/repos/excluded", { repo: "~/100%_done" });
  assert.equal(odd.body.sessions_removed, 1);
  assert.deepEqual((await put(tokens.ann, upload("near-pct", { root: "~/100XYdone/child" }))).body, { stored: true });

  // A remote is only that repository. Stopping it does not touch a neighbour, or anyone else's copy.
  assert.deepEqual((await put(tokens.bob, upload("bob-web", { root: "/src/web", remote: "github.com/acme/web" }))).body, { stored: true });
  const web = await call(tokens.ann, "PUT", "/repos/excluded", { repo: "github.com/acme/web" });
  assert.equal(web.body.covers_folders, false);
  assert.equal(web.body.sessions_removed, 1);
  assert.deepEqual((await put(tokens.ann, upload("web-ui", { root: "/src/ui", remote: "github.com/acme/web-ui" }))).body, { stored: true });
  assert.ok((await ids(tokens.bob)).includes("bob-web"));

  // Doing it again deletes any that slipped in, and the list is only this person's.
  assert.equal((await call(tokens.ann, "PUT", "/repos/excluded", { repo: "~/Downloads" })).body.sessions_removed, 0);
  assert.deepEqual([...(await call(tokens.ann, "GET", "/repos/excluded")).body.repos].sort(), [
    "~/100%_done",
    "~/Downloads",
    "github.com/acme/web",
  ].sort());
  assert.deepEqual((await call(tokens.bob, "GET", "/repos/excluded")).body.repos, []);

  // Allowing it again does not bring back what was deleted, and a new upload is stored.
  const back = await call(tokens.ann, "DELETE", "/repos/excluded?repo=~%2FDownloads");
  assert.deepEqual(back.body, { repo: "~/Downloads", removed: true });
  assert.equal((await call(tokens.ann, "DELETE", "/repos/excluded?repo=~/Downloads")).status, 404);
  assert.deepEqual(await ids(tokens.ann), ["docs", "near", "near-pct", "web-ui"]);
  assert.deepEqual((await put(tokens.ann, upload("dl-3", { root: "~/Downloads" }))).body, { stored: true });

  // An admin stopping a repository removes their own sessions, not a member's.
  const adminStop = await call(tokens.admin, "PUT", "/repos/excluded", { repo: "~/Documents" });
  assert.equal(adminStop.body.sessions_removed, 1);
  assert.ok((await ids(tokens.ann)).includes("docs"));
  assert.ok(!(await ids(tokens.admin)).includes("boss-docs"));
});

test("a cloud session is filed under the person, so stopping the repository removes it", async () => {
  const cloud = upload("c-ann", { root: "/workspace", remote: "github.com/acme/private" }, "ann@example.com");
  cloud.session!.machine_id = "cloud";
  cloud.session!.runtime = { kind: "cloud", id: "cse_c-ann" };
  assert.deepEqual((await put(tokens.env, cloud)).body, { stored: true });
  assert.equal((await call(tokens.ann, "GET", "/sessions/cloud/claude-code/c-ann")).body.owner_email, "ann@example.com");

  const stopped = await call(tokens.ann, "PUT", "/repos/excluded", { repo: "github.com/acme/private" });
  assert.equal(stopped.body.sessions_removed, 1);
  assert.equal((await call(tokens.ann, "GET", "/sessions/cloud/claude-code/c-ann")).status, 404);
  const again = upload("c-ann-2", { root: "/workspace", remote: "github.com/acme/private" }, "ann@example.com");
  again.session!.machine_id = "cloud";
  again.session!.runtime = { kind: "cloud", id: "cse_c-ann-2" };
  assert.deepEqual((await put(tokens.env, again)).body, { stored: false, excluded: true });
});

test("a bad name is refused, and a token that is not a person's cannot stop a repository", async () => {
  for (const repo of ["", " ", "/", "a".repeat(1025)]) {
    assert.equal((await call(tokens.ann, "PUT", "/repos/excluded", { repo })).status, 400, repo);
  }
  assert.equal((await call(tokens.ann, "PUT", "/repos/excluded", {})).status, 400);
  for (const token of [tokens.ci, tokens.env]) {
    assert.equal((await call(token, "GET", "/repos/excluded")).status, 403);
    assert.equal((await call(token, "PUT", "/repos/excluded", { repo: "~/Documents" })).status, 403);
    assert.equal((await call(token, "DELETE", "/repos/excluded?repo=~/Documents")).status, 403);
  }
});

test("one organisation's stop does not touch another's sessions", async () => {
  await newOrg(db, "other-org", "Other");
  const there = await tokenFor(db, { email: "ann@example.com", role: "member" }, "other-org");
  assert.deepEqual((await put(there, upload("elsewhere", { root: "~/Documents" }))).body, { stored: true });
  await call(tokens.ann, "PUT", "/repos/excluded", { repo: "~/Documents" });
  assert.deepEqual(await ids(there), ["elsewhere"]);
  const [left] = await db.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM sessions WHERE org_id = 'other-org' AND session_id = 'elsewhere'`,
  );
  assert.equal(Number(left?.n), 1);
});
