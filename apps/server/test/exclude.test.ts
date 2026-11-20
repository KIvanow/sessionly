// Stopping a repository: a person's sessions from it are deleted, and a later
// upload of it is not stored. Other people's sessions are left as they are.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseRepo, repoCovered, sessionCovered, type Upload } from "@sessionly/schema";
import { createApp } from "../src/app.ts";
import { DEFAULT_ORG, type Principal } from "../src/auth.ts";
import type { Db, OrgDb } from "../src/db.ts";
import { matchedBy } from "../src/pulls.ts";
import { excludeRepo, storeUpload } from "../src/sessions.ts";
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
  assert.equal(repoCovered("~/Documents", "~/"), true);
  for (const rule of ["", " ", "/"]) assert.equal(repoCovered("~/Documents", rule), false, rule);

  // As the CLI checks a name: any control character, and length in characters.
  assert.equal(parseRepo("has\u0085a control").ok, false);
  assert.equal(parseRepo("😀".repeat(1024)).ok, true);
  assert.equal(parseRepo("😀".repeat(1025)).ok, false);

  // A stopped folder covers a clone inside it, which is filed under its remote.
  const clone = { repo: "github.com/acme/client-x", root: "~/Documents/client-x", cwd: "~/Documents/client-x/app" };
  assert.equal(sessionCovered(clone, "~/Documents"), true);
  assert.equal(sessionCovered(clone, "~/Documents/client-x/app"), true);
  assert.equal(sessionCovered(clone, "github.com/acme/client-x"), true);
  assert.equal(sessionCovered(clone, "~/Docs"), false);
  assert.equal(sessionCovered({ repo: "github.com/acme/web", root: "github.com/acme/other" }, "github.com/acme/other"), false);
  assert.equal(sessionCovered({ repo: null, root: null, cwd: null }, "~"), false);
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
  for (const body of [{}, null, 4, "~/Documents", ["~/Documents"]]) {
    assert.equal((await call(tokens.ann, "PUT", "/repos/excluded", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(tokens.ann, "GET", "/sessions/held")).status, 400);
  for (const token of [tokens.ci, tokens.env]) {
    assert.equal((await call(token, "GET", "/sessions/held?machine=m1")).status, 403);
    assert.equal((await call(token, "GET", "/repos/excluded")).status, 403);
    assert.equal((await call(token, "PUT", "/repos/excluded", { repo: "~/Documents" })).status, 403);
    assert.equal((await call(token, "DELETE", "/repos/excluded?repo=~/Documents")).status, 403);
  }
});

test("a stopped folder covers a clone inside it that is filed under its remote", async () => {
  const cat = await tokenFor(db, { email: "cat@example.com", role: "member" });
  const clone = { root: "~/Work/client-x", remote: "github.com/acme/client-x" };
  assert.deepEqual((await put(cat, upload("clone", clone))).body, { stored: true });
  assert.deepEqual((await put(cat, upload("beside", { root: "~/Work-old/y", remote: "github.com/acme/y" }))).body, { stored: true });
  const inside = upload("ran-inside", { root: "/srv/mono", remote: "github.com/acme/mono" });
  inside.session!.cwd = "~/Work/scratch";
  assert.deepEqual((await put(cat, inside)).body, { stored: true });
  // The same clone, submitted by someone else, is not this person's.
  assert.deepEqual((await put(tokens.bob, upload("bob-clone", clone))).body, { stored: true });

  const stopped = await call(cat, "PUT", "/repos/excluded", { repo: "~/Work" });
  assert.equal(stopped.body.sessions_removed, 2);
  assert.deepEqual(await ids(cat), ["beside"]);
  assert.ok((await ids(tokens.bob)).includes("bob-clone"));
  assert.deepEqual((await put(cat, upload("clone-2", clone))).body, { stored: false, excluded: true });
  assert.deepEqual((await put(cat, upload("elsewhere-2", { root: "~/Other/z", remote: "github.com/acme/client-x" }))).body, {
    stored: true,
  });
});

test("a cloud session filed under the environment's address goes when its person has stopped the repository", async () => {
  const dan = await tokenFor(db, { email: "dan@example.com", role: "member" });
  const cloud = (email?: string) => {
    const body = upload("c-dan", { root: "/workspace", remote: "github.com/acme/quiet" }, email);
    body.session!.machine_id = "cloud";
    body.session!.runtime = { kind: "cloud", id: "cse_c-dan" };
    if (!email) body.session!.user = undefined;
    return body;
  };
  await call(dan, "PUT", "/repos/excluded", { repo: "github.com/acme/quiet" });
  // Nobody is named yet, so it is the environment's own.
  assert.deepEqual((await put(tokens.env, cloud())).body, { stored: true });
  assert.equal((await call(tokens.admin, "GET", "/sessions/cloud/claude-code/c-dan")).body.owner_email, "cloud@example.com");
  // Now it names its person, who stopped the repository: nothing of it stays.
  assert.deepEqual((await put(tokens.env, cloud("dan@example.com"))).body, { stored: false, excluded: true });
  assert.equal((await call(tokens.admin, "GET", "/sessions/cloud/claude-code/c-dan")).status, 404);
  // Someone else's session with that address is not the environment's to remove.
  const other = upload("c-dan", { root: "/workspace", remote: "github.com/acme/quiet" }, "dan@example.com");
  other.session!.machine_id = "bob-machine";
  assert.deepEqual((await put(tokens.bob, { ...other, session: { ...other.session!, user: undefined } })).body, { stored: true });
  other.session!.runtime = { kind: "cloud", id: "cse_c-dan" };
  assert.deepEqual((await put(tokens.env, other)).body, { stored: false, excluded: true });
  assert.equal((await call(tokens.bob, "GET", "/sessions/bob-machine/claude-code/c-dan")).status, 200);
});

test("allowing a repository again tells each machine to ask what the server still has", async () => {
  const eve = await tokenFor(db, { email: "eve@example.com", role: "member" });
  const held = async (token: string, machine: string) =>
    ((await call(token, "GET", `/sessions/held?machine=${machine}`)).body.sessions as { session_id: string }[]).map(
      (s) => s.session_id,
    );
  const elsewhere = upload("e-laptop", { root: "~/Notes" });
  elsewhere.session!.machine_id = "laptop";
  await put(eve, upload("e-notes", { root: "~/Notes" }));
  await put(eve, upload("e-code", { root: "~/Code" }));
  await put(eve, elsewhere);
  assert.deepEqual((await call(eve, "GET", "/repos/excluded")).body, { repos: [], allowed_again: 0 });
  assert.deepEqual(await held(eve, "m1"), ["e-code", "e-notes"]);
  assert.deepEqual(await held(eve, "laptop"), ["e-laptop"]);

  await call(eve, "PUT", "/repos/excluded", { repo: "~/Notes" });
  // Stopping changes nothing a machine must act on: the rule keeps the sessions back.
  assert.deepEqual((await call(eve, "GET", "/repos/excluded")).body, { repos: ["~/Notes"], allowed_again: 0 });
  await call(eve, "DELETE", "/repos/excluded?repo=~/Notes");
  assert.deepEqual((await call(eve, "GET", "/repos/excluded")).body, { repos: [], allowed_again: 1 });
  assert.deepEqual(await held(eve, "m1"), ["e-code"]);
  assert.deepEqual(await held(eve, "laptop"), []);
  // Allowing what was not stopped changes nothing.
  assert.equal((await call(eve, "DELETE", "/repos/excluded?repo=~/Notes")).status, 404);
  assert.equal((await call(eve, "GET", "/repos/excluded")).body.allowed_again, 1);

  await call(eve, "PUT", "/repos/excluded", { repo: "~/Code" });
  await call(eve, "DELETE", "/repos/excluded?repo=~/Code");
  assert.equal((await call(eve, "GET", "/repos/excluded")).body.allowed_again, 2);
  // Each person has their own number, and is told only of their own sessions.
  assert.equal((await call(tokens.bob, "GET", "/repos/excluded")).body.allowed_again, 0);
  assert.ok(!(await held(tokens.admin, "m1")).includes("bob-dl"));
  assert.ok((await held(tokens.bob, "m1")).includes("bob-dl"));
});

test("storing a session and stopping its repository at the same moment: the session does not stay", async () => {
  const person = (email: string): Principal => ({
    orgId: DEFAULT_ORG,
    email,
    name: null,
    role: "member",
    tokenId: null,
    userId: null,
    signedIn: false,
    owner: false,
  });
  const left = async (email: string) => {
    const [row] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM sessions WHERE owner_email = $1`, [email]);
    return Number(row?.n);
  };
  // `first` does its work and keeps its transaction open while `second`
  // starts. Each must see what the other wrote, whichever came first.
  // (The embedded database runs one transaction at a time, so there the
  // second simply waits. On Postgres the two really overlap.)
  async function overlapped<A, B>(first: (tx: OrgDb) => Promise<A>, second: (tx: OrgDb) => Promise<B>): Promise<[A, B]> {
    let finish = () => {};
    const open = new Promise<void>((resolve) => (finish = resolve));
    let began = () => {};
    const working = new Promise<void>((resolve) => (began = resolve));
    const one = db.asOrg(DEFAULT_ORG, async (tx) => {
      const result = await first(tx);
      began();
      await open;
      return result;
    });
    await working;
    const two = db.asOrg(DEFAULT_ORG, second);
    await new Promise((resolve) => setTimeout(resolve, 300));
    finish();
    return [await one, await two];
  }

  // The upload is not finished when the repository is stopped: stopping finds it.
  const fay = person("fay@example.com");
  const [stored, stopped] = await overlapped(
    (tx) => storeUpload(tx, upload("raced-1", { root: "~/Raced" }), fay),
    (tx) => excludeRepo(tx, fay.email, "~/Raced"),
  );
  assert.deepEqual(stored, { stored: true, changed: true, spent: true });
  assert.equal(stopped.sessions_removed, 1);
  assert.equal(await left(fay.email), 0);

  // The stop is not finished when the upload arrives: the upload is refused.
  const gus = person("gus@example.com");
  const [stopping, refused] = await overlapped(
    (tx) => excludeRepo(tx, gus.email, "~/Raced"),
    (tx) => storeUpload(tx, upload("raced-2", { root: "~/Raced/inside" }), gus),
  );
  assert.equal(stopping.sessions_removed, 0);
  assert.deepEqual(refused, { stored: false, excluded: true });
  assert.equal(await left(gus.email), 0);

  // Two uploads of one person do not wait for each other.
  const hal = person("hal@example.com");
  const both = await overlapped(
    (tx) => storeUpload(tx, upload("raced-3", { root: "~/Fine" }), hal),
    (tx) => storeUpload(tx, upload("raced-4", { root: "~/Fine" }), hal),
  );
  assert.deepEqual(both, [{ stored: true, changed: true, spent: true }, { stored: true, changed: true, spent: true }]);

  // Two uploads of one session already stored: the second waits for the first, and says whether it
  // changed what that one left. Put back as it was before both, it did: the first had changed it.
  await db.asOrg(DEFAULT_ORG, (tx) => storeUpload(tx, upload("raced-5", { root: "~/Fine" }), hal));
  const back = await overlapped(
    (tx) => storeUpload(tx, upload("raced-5", { root: "~/Fine/elsewhere" }), hal),
    (tx) => storeUpload(tx, upload("raced-5", { root: "~/Fine" }), hal),
  );
  assert.deepEqual(back, [{ stored: true, changed: true, spent: false }, { stored: true, changed: true, spent: false }]);
  const same = await overlapped(
    (tx) => storeUpload(tx, upload("raced-5", { root: "~/Fine" }), hal),
    (tx) => storeUpload(tx, upload("raced-5", { root: "~/Fine" }), hal),
  );
  assert.deepEqual(same, [{ stored: true, changed: false, spent: false }, { stored: true, changed: false, spent: false }]);

  // What tells a change keeps each value in its place: one moved to an empty field next to it is a change.
  const fingerprint = (set: string) =>
    db.asOrg(DEFAULT_ORG, async (tx) => {
      const [row] = await tx.query<{ machine_id: string; source: string }>(
        `UPDATE sessions SET ${set} WHERE org_id = $1 AND session_id = 'raced-5' RETURNING machine_id, source`,
        [tx.orgId],
      );
      return matchedBy(tx, { machine_id: row!.machine_id, source: row!.source, session_id: "raced-5" });
    });
  assert.notEqual(await fingerprint("repo = 'x', branch = NULL"), await fingerprint("repo = NULL, branch = 'x'"));
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
