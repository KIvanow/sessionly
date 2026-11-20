import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Upload } from "@sessionly/schema";
import { createApp } from "../src/app.ts";
import { openDb, type Db } from "../src/db.ts";
import { testDb, tokenFor } from "./helpers.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const tokens = { admin: "", ann: "", bob: "" };

before(async () => {
  db = await testDb();
  app = createApp(db, { bootstrap: { token: "bootstrap-secret", email: "root@example.com" } });
  tokens.admin = await tokenFor(db, { email: "boss@example.com", role: "admin" });
  tokens.ann = await tokenFor(db, { email: "Ann@Example.com", name: "Ann", role: "member" });
  tokens.bob = await tokenFor(db, { email: "bob@example.com", role: "member" });
});
after(() => db.close());

function upload(id: string, overrides: Record<string, unknown> = {}): Upload {
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      source: "claude-code",
      collector_version: "0.1.0",
      machine_id: "machine-1",
      captured_by: "hooks",
      content: "metadata",
      session_id: id,
      title: null,
      user: { name: "Someone Else", email: "spoofed@example.com" },
      started_at: "2026-11-10T10:00:00Z",
      ended_at: "2026-11-10T10:30:00Z",
      duration_ms: 1_800_000,
      active_ms: 600_000,
      captured_from_start: true,
      repo: { root: "~/src/web", remote: "github.com/acme/web", branch: "main" },
      models: ["claude-opus-5-5"],
      cost: { total_usd: 2, source: "recorded", transcript_estimate_usd: 2, unpriced_requests: 0, untracked_usd: 0 },
      usage: [{ model: "claude-opus-5-5", requests: 3, input_tokens: 10, output_tokens: 500 }],
      counts: { prompts: 2, tool_calls: 10, tool_failures: 1, files_changed: 2, lines_added: 30, lines_removed: 5 },
      prompts: [{ prompt_id: "p1", text: { sha256: "", chars: 20, preview: "" }, outcome: "completed" }],
      tool_calls: [{ tool_use_id: "t1", tool: "Edit", status: "ok", file_path: "src/app.ts" }],
      files: [{ path: "src/app.ts", writes: 1, lines_added: 30, lines_removed: 5 }],
      ...overrides,
    },
    rewrite: {
      measured_at: "2026-11-12T00:00:00Z",
      files_measured: 2,
      files_rewritten: 1,
      lines_added: 20,
      lines_surviving: 12,
      files: [],
    },
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function put(token: string, body: Upload | string, address?: string) {
  const s = typeof body === "string" ? undefined : body.session;
  const path = address ?? `/api/v1/sessions/${s?.machine_id}/${s?.source}/${s?.session_id}`;
  return app.request(path, {
    method: "PUT",
    headers: { ...auth(token), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function get(token: string, path: string) {
  const response = await app.request(`/api/v1${path}`, { headers: auth(token) });
  return { status: response.status, body: (await response.json()) as any };
}

test("every endpoint needs a known token", async () => {
  assert.equal((await app.request("/api/v1/ping")).status, 401);
  assert.equal((await get("nope", "/ping")).status, 401);
  assert.equal((await app.request("/api/v1/summary", { headers: { authorization: "Basic x" } })).status, 401);
  const ping = await get(tokens.ann, "/ping");
  assert.deepEqual(ping, { status: 200, body: { ok: true, org: "default", email: "ann@example.com", name: "Ann", role: "member" } });
  // the bootstrap token from the environment is an admin
  assert.equal((await get("bootstrap-secret", "/me")).body.role, "admin");
  assert.equal((await app.request("/api/v2/ping")).status, 404);
});

test("an upload is stored under the token's owner and can be replaced", async () => {
  assert.equal((await put(tokens.ann, upload("s-ann-1"))).status, 200);
  const stored = await get(tokens.ann, "/sessions/machine-1/claude-code/s-ann-1");
  assert.equal(stored.status, 200);
  // the uploader is who the token says, not what the record claims
  assert.equal(stored.body.owner_email, "ann@example.com");
  assert.equal(stored.body.upload.session.user.email, "spoofed@example.com");
  assert.equal(stored.body.upload.rewrite.lines_surviving, 12);

  // the same session again, changed: replaced, not duplicated
  const changed = upload("s-ann-1", { cost: { total_usd: 5, source: "estimated" } });
  assert.equal((await put(tokens.ann, changed)).status, 200);
  const list = await get(tokens.ann, "/sessions");
  assert.equal(list.body.total, 1);
  assert.equal(list.body.sessions[0].cost_usd, 5);
  assert.equal(list.body.sessions[0].cost_source, "estimated");
  assert.deepEqual(list.body.sessions[0].rewrite, {
    files_measured: 2, files_rewritten: 1, lines_added: 20, lines_surviving: 12,
  });

  // someone else cannot overwrite it
  assert.equal((await put(tokens.bob, upload("s-ann-1"))).status, 409);
});

test("an uploader can take a session back, and nobody else can", async () => {
  const address = "/api/v1/sessions/machine-1/claude-code/s-ann-gone";
  const remove = (token: string) => app.request(address, { method: "DELETE", headers: auth(token) });
  assert.equal((await put(tokens.ann, upload("s-ann-gone"))).status, 200);
  const before = (await get(tokens.ann, "/sessions")).body.total;

  const answer = async (token: string) => {
    const response = await remove(token);
    return [response.status, await response.json()];
  };
  // not Bob's: he has none to take back, and is told so
  assert.deepEqual(await answer(tokens.bob), [200, { removed: false }]);
  assert.equal((await get(tokens.ann, "/sessions")).body.total, before);

  assert.deepEqual(await answer(tokens.ann), [200, { removed: true }]);
  assert.equal((await get(tokens.ann, "/sessions")).body.total, before - 1);
  assert.equal((await get(tokens.ann, "/sessions/machine-1/claude-code/s-ann-gone")).status, 404);
  // again: there is none
  assert.deepEqual(await answer(tokens.ann), [200, { removed: false }]);
});

test("bad uploads are refused with a reason", async () => {
  const refuse = async (response: Response, status: number, text: RegExp) => {
    assert.equal(response.status, status);
    assert.match(JSON.stringify(await response.json()), text);
  };
  await refuse(await put(tokens.ann, "{ not json", "/api/v1/sessions/m/s/x"), 400, /not JSON/);
  await refuse(await put(tokens.ann, upload("a"), "/api/v1/sessions/machine-1/claude-code/b"), 422, /does not match the session/);
  await refuse(await put(tokens.ann, upload("local-1", { content: "local" })), 422, /not for upload/);
  const wrongType = upload("typed");
  (wrongType.session as any).counts.prompts = "many";
  await refuse(await put(tokens.ann, wrongType), 422, /counts\/prompts/);
  const noId = upload("");
  await refuse(await put(tokens.ann, noId, "/api/v1/sessions/machine-1/claude-code/x"), 422, /required/);
  const big = "x".repeat(33 * 1024 * 1024);
  await refuse(await put(tokens.ann, big, "/api/v1/sessions/m/s/x"), 413, /too large/);
});

test("values and fields from a newer binary are accepted", async () => {
  const future = upload("future-1", { captured_by: "telepathy", brand_new_field: { a: 1 } });
  (future.session as any).tool_calls[0].status = "paused";
  (future.session as any).cost.source = "audited";
  assert.equal((await put(tokens.ann, future)).status, 200);
  const stored = await get(tokens.ann, "/sessions/machine-1/claude-code/future-1");
  assert.equal(stored.body.upload.session.brand_new_field.a, 1);
});

test("members see their own sessions, admins see everyone's", async () => {
  await put(tokens.bob, upload("s-bob-1", {
    started_at: "2026-11-11T09:00:00Z",
    repo: { root: "~/src/api", remote: "github.com/acme/api", branch: "dev" },
    models: ["claude-haiku-5-5", "claude-opus-5-5"],
    cost: null,
    title: "Fix 100% of the billing_bug",
  }));
  const ids = (r: any) => r.body.sessions.map((s: any) => s.session_id).sort();
  assert.deepEqual(ids(await get(tokens.bob, "/sessions")), ["s-bob-1"]);
  assert.ok(!ids(await get(tokens.ann, "/sessions")).includes("s-bob-1"));
  assert.ok(ids(await get(tokens.admin, "/sessions")).includes("s-bob-1"));
  assert.ok(ids(await get(tokens.admin, "/sessions")).includes("s-ann-1"));
  assert.equal((await get(tokens.ann, "/sessions/machine-1/claude-code/s-bob-1")).status, 404);
  assert.equal((await get(tokens.admin, "/sessions/machine-1/claude-code/s-bob-1")).status, 200);

  // filters
  const admin = (query: string) => get(tokens.admin, `/sessions?${query}`);
  assert.deepEqual(ids(await admin("user=BOB")), ["s-bob-1"]);
  // `user` contains the text, so one address counts another. `user_is` is that person only.
  assert.deepEqual(ids(await admin("user=example.com")), ["future-1", "s-ann-1", "s-bob-1"]);
  assert.deepEqual(ids(await admin("user_is=ann@example.com")), ["future-1", "s-ann-1"]);
  assert.deepEqual(ids(await admin("user_is=ann")), []);
  assert.equal((await admin("user_is=ann@example.com&limit=1")).body.total, 2);
  assert.deepEqual(ids(await admin("repo=acme/api")), ["s-bob-1"]);
  assert.deepEqual(ids(await admin("model=haiku")), ["s-bob-1"]);
  assert.deepEqual(ids(await admin("q=billing_bug")), ["s-bob-1"]);
  assert.deepEqual(ids(await admin("q=100%25")), ["s-bob-1"]);
  assert.deepEqual(ids(await admin("q=billing%25bug")), []);
  assert.deepEqual(ids(await admin("q=src/app.ts&user=ann")), ["future-1", "s-ann-1"]);
  assert.deepEqual(ids(await admin("since=2026-11-11&until=2026-11-12")), ["s-bob-1"]);
  assert.equal((await admin("limit=1")).body.sessions.length, 1);
  assert.equal((await admin("limit=1")).body.total, 3);
  assert.equal((await admin("limit=1&offset=5")).body.sessions.length, 0);
  assert.equal((await admin("since=yesterday-ish")).status, 400);
  assert.equal((await admin("limit=-1")).status, 400);

  const options = await get(tokens.admin, "/filters");
  assert.deepEqual(options.body.users, ["ann@example.com", "bob@example.com"]);
  assert.deepEqual(options.body.repos, ["github.com/acme/api", "github.com/acme/web"]);
  assert.deepEqual((await get(tokens.bob, "/filters")).body.users, ["bob@example.com"]);
});

test("summary totals per group and overall", async () => {
  const byUser = await get(tokens.admin, "/summary?by=user");
  assert.equal(byUser.status, 200);
  const ann = byUser.body.groups.find((g: any) => g.key === "ann@example.com");
  assert.equal(ann.sessions, 2);
  assert.equal(ann.cost_usd, 7);
  // one estimated, and one with a source this server doesn't know: neither is "recorded"
  assert.equal(ann.sessions_with_estimated_cost, 2);
  assert.equal(ann.active_ms, 1_200_000);
  assert.equal(ann.prompts, 4);
  assert.deepEqual(ann.rewrite, { files_measured: 4, files_rewritten: 2, lines_added: 40, lines_surviving: 24 });
  const bob = byUser.body.groups.find((g: any) => g.key === "bob@example.com");
  assert.equal(bob.cost_usd, 0);
  assert.equal(bob.sessions_without_cost, 1);
  assert.equal(byUser.body.total.sessions, 3);
  assert.equal(byUser.body.total.cost_usd, 7);
  // groups are ordered by cost
  assert.equal(byUser.body.groups[0].key, "ann@example.com");

  const keys = async (by: string, token = tokens.admin) =>
    (await get(token, `/summary?by=${by}`)).body.groups.map((g: any) => g.key);
  assert.deepEqual(await keys("repo"), ["github.com/acme/web", "github.com/acme/api"]);
  assert.deepEqual(await keys("model"), ["claude-opus-5-5", "claude-haiku-5-5"]);
  assert.deepEqual(await keys("day"), ["2026-11-10", "2026-11-11"]);
  assert.deepEqual(await keys("user", tokens.bob), ["bob@example.com"]);
  assert.equal((await get(tokens.admin, "/summary?by=planet")).status, 400);

  const none = await get(tokens.admin, "/summary?user=nobody");
  assert.deepEqual(none.body.groups, []);
  assert.equal(none.body.total.sessions, 0);
  assert.equal(none.body.total.cost_usd, 0);
});

test("files agents changed, per repository", async () => {
  const withFiles = (id: string, files: unknown[], rewriteFiles: unknown[]) => {
    const u = upload(id, { files });
    u.rewrite!.files = rewriteFiles as never;
    return u;
  };
  await put(tokens.ann, withFiles("files-1",
    [{ path: "src/app.ts", writes: 2, lines_added: 30, lines_removed: 5, created: true },
     { path: "README.md", reads: 1, writes: 0 }],
    [{ path: "src/app.ts", lines_added: 20, lines_surviving: 5, exists: true }]));
  await put(tokens.ann, withFiles("files-2",
    [{ path: "src/app.ts", writes: 1, lines_added: 10, lines_removed: 0 },
     { path: "src/gone.ts", writes: 1, lines_added: 4, lines_removed: 0 }],
    [{ path: "src/app.ts", lines_added: 8, lines_surviving: 8, exists: true },
     { path: "src/gone.ts", lines_added: 4, lines_surviving: 0, exists: false }]));

  const web = await get(tokens.admin, "/files?repo_is=github.com/acme/web&q=files-");
  assert.equal(web.status, 200);
  assert.equal(web.body.total, 2);
  assert.deepEqual(web.body.files.map((f: any) => f.path), ["src/app.ts", "src/gone.ts"]);
  const app = web.body.files[0];
  assert.deepEqual(
    [app.sessions, app.lines_added, app.lines_removed, app.created],
    [2, 40, 5, true],
  );
  assert.deepEqual(app.rewrite, { lines_added: 28, lines_surviving: 13, exists: true });
  assert.equal(web.body.files[1].rewrite.exists, false);
  // a file that was only read is not listed
  assert.ok(!JSON.stringify(web.body).includes("README.md"));

  // exact repository match, the limit, and visibility
  assert.equal((await get(tokens.admin, "/files?repo_is=acme/web")).body.total, 0);
  const limited = await get(tokens.admin, "/files?repo_is=github.com/acme/web&q=files-&limit=1");
  assert.equal(limited.body.files.length, 1);
  assert.equal(limited.body.total, 2);
  assert.equal((await get(tokens.bob, "/files?repo_is=github.com/acme/web")).body.total, 0);
  // a session without a rewrite measurement still lists its files
  const api = await get(tokens.bob, "/files?repo_is=github.com/acme/api");
  assert.equal(api.body.files[0].path, "src/app.ts");
});

test("sessions from several agents are told apart", async () => {
  const before = (await get(tokens.admin, "/summary?by=tool")).body;
  assert.deepEqual(before.groups.map((g: any) => g.key), ["claude-code"]);
  assert.deepEqual(before.total.tools, ["claude-code"]);

  const files = [{ path: "src/app.ts", writes: 1, lines_added: 3, lines_removed: 1 }];
  // Cursor records no cost and no model
  await put(tokens.ann, upload("cur-1", { source: "cursor", captured_by: "transcript", models: [], cost: null, usage: [], files }));
  await put(tokens.ann, upload("grok-1", {
    source: "grok",
    captured_by: "transcript",
    models: ["grok-4.7-build"],
    cost: { total_usd: 1, source: "recorded" },
    usage: [],
    files,
  }));

  const byTool = (await get(tokens.admin, "/summary?by=tool")).body;
  const tool = (key: string) => byTool.groups.find((g: any) => g.key === key);
  assert.deepEqual(byTool.groups.map((g: any) => g.key).sort(), ["claude-code", "cursor", "grok"]);
  assert.deepEqual(
    [tool("cursor").sessions, tool("cursor").cost_usd, tool("cursor").sessions_without_cost, tool("cursor").models],
    [1, 0, 1, []],
  );
  assert.deepEqual([tool("grok").cost_usd, tool("grok").models, tool("grok").tools], [1, ["grok-4.7-build"], ["grok"]]);
  assert.equal(tool("claude-code").sessions, before.total.sessions);
  assert.deepEqual(byTool.total.tools, ["claude-code", "cursor", "grok"]);

  // which agents and models worked in a repository, and on a file
  const byRepo = (await get(tokens.admin, "/summary?by=repo")).body;
  const web = byRepo.groups.find((g: any) => g.key === "github.com/acme/web");
  assert.deepEqual(web.tools, ["claude-code", "cursor", "grok"]);
  assert.deepEqual(web.models, ["claude-opus-5-5", "grok-4.7-build"]);
  assert.deepEqual(byRepo.groups.find((g: any) => g.key === "github.com/acme/api").tools, ["claude-code"]);
  const changed = (await get(tokens.admin, "/files?repo_is=github.com/acme/web")).body.files;
  assert.deepEqual(changed.find((f: any) => f.path === "src/app.ts").tools, ["claude-code", "cursor", "grok"]);
  assert.deepEqual(changed.find((f: any) => f.path === "src/gone.ts").tools, ["claude-code"]);

  // one agent at a time
  const ids = (r: any) => r.body.sessions.map((s: any) => s.session_id);
  assert.deepEqual(ids(await get(tokens.admin, "/sessions?tool=cursor")), ["cur-1"]);
  assert.equal((await get(tokens.admin, "/sessions?tool=cursor")).body.sessions[0].source, "cursor");
  assert.deepEqual(ids(await get(tokens.admin, "/sessions?tool=curs")), []);
  assert.equal((await get(tokens.admin, "/summary?by=repo&tool=grok")).body.total.sessions, 1);
  assert.deepEqual(
    (await get(tokens.admin, "/files?tool=grok")).body.files.map((f: any) => [f.path, f.sessions]),
    [["src/app.ts", 1]],
  );
  assert.deepEqual((await get(tokens.admin, "/filters")).body.tools, ["claude-code", "cursor", "grok"]);

  // one model at a time: a session counts under its main model, exactly
  assert.deepEqual(ids(await get(tokens.admin, "/sessions?model_is=grok-4.7-build")), ["grok-1"]);
  assert.deepEqual(ids(await get(tokens.admin, "/sessions?model_is=grok-4.7")), []);
  assert.deepEqual(ids(await get(tokens.admin, "/sessions?model_is=(unknown)")), ["cur-1"]);
  // s-bob-1 used opus too, but mainly haiku
  assert.ok(!ids(await get(tokens.admin, "/sessions?model_is=claude-opus-5-5")).includes("s-bob-1"));
  assert.deepEqual(
    (await get(tokens.admin, "/summary?by=model&model_is=claude-haiku-5-5")).body.groups.map((g: any) => g.key),
    ["claude-haiku-5-5"],
  );
  assert.deepEqual((await get(tokens.bob, "/filters")).body.tools, ["claude-code"]);
  assert.equal((await get(tokens.admin, "/sessions/machine-1/cursor/cur-1")).status, 200);
});

test("the embedded database creates its folder", async (t) => {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "sessionly-db-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const dir = join(folder, "not", "there", "yet");
  const fresh = await openDb(`file:${dir}`);
  await tokenFor(fresh, { email: "a@example.com", role: "member" });
  await fresh.close();
  assert.ok(existsSync(dir));
  // and the data is still there when it is opened again
  const again = await openDb(`file:${dir}`);
  assert.equal((await again.query(`SELECT email FROM tokens`)).length, 1);
  await again.close();
});

test("admins manage tokens; a revoked token stops working", async () => {
  const post = (token: string, body: unknown) =>
    app.request("/api/v1/tokens", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post(tokens.ann, { email: "x@example.com" })).status, 403);
  assert.equal((await post(tokens.admin, { email: "not-an-email" })).status, 400);
  assert.equal((await post(tokens.admin, { email: "c@example.com", role: "owner" })).status, 400);

  const created = await post(tokens.admin, { email: "Cat@Example.com", name: "Cat" });
  assert.equal(created.status, 201);
  const cat = (await created.json()) as any;
  assert.match(cat.token, /^sly_/);
  assert.equal(cat.role, "member");
  assert.equal((await get(cat.token, "/ping")).body.email, "cat@example.com");

  const listed = await get(tokens.admin, "/tokens");
  const row = listed.body.tokens.find((t: any) => t.id === cat.id);
  assert.ok(row.last_used_at, "use is recorded");
  assert.ok(!JSON.stringify(listed.body).includes(cat.token), "tokens are never listed in clear");

  const revoke = (id: string) =>
    app.request(`/api/v1/tokens/${id}`, { method: "DELETE", headers: auth(tokens.admin) });
  assert.equal((await revoke(cat.id)).status, 200);
  assert.equal((await revoke(cat.id)).status, 404);
  assert.equal((await get(cat.token, "/ping")).status, 401);
});

test("what was still there 1, 7 and 30 days after a session ended is kept, and summed over the sessions measured then", async () => {
  const repo = "github.com/acme/kept";
  const ended = "2026-11-10T10:30:00Z";
  const days = (n: number) => new Date(Date.parse(ended) + n * 86_400_000).toISOString();
  /** A checkpoint measured `age` days after the session ended, which it did `from` days after it first had. */
  const at = (checkpoint: string, surviving: number, age: number, from = 0, more: Record<string, unknown> = {}) => ({
    checkpoint,
    added: 20,
    surviving,
    measured_at: days(from + age),
    age_seconds: age * 86_400,
    ended_at: days(from),
    ...more,
  });
  const send = async (token: string, id: string, checkpoints: unknown[] | undefined, overrides: Record<string, unknown> = {}) => {
    const body = upload(id, { repo: { root: "~/src/kept", remote: repo }, ...overrides });
    const response = await put(token, { ...body, checkpoints } as Upload);
    assert.equal(response.status, 200);
  };
  const kept = async (id: string, source = "claude-code") =>
    ((await get(tokens.admin, `/sessions/machine-1/${source}/${id}`)).body.upload.checkpoints ?? []).map((c: any) => [
      c.checkpoint,
      c.surviving,
      c.age_seconds / 86_400,
    ]);
  const byTool = async () => (await get(tokens.admin, `/summary?by=tool&repo_is=${encodeURIComponent(repo)}`)).body;

  // As an older sessionly sends it, and a session not yet a day old: no checkpoint.
  await send(tokens.ann, "k1", undefined);
  assert.deepEqual(await kept("k1"), []);
  const none = (await byTool()).total;
  assert.deepEqual(none.kept_7d, { lines_added: 0, lines_surviving: 0, sessions_reached: 0, sessions_total: 1 });

  // Day 1 was missed and measured on day 3: kept with the age it really had.
  await send(tokens.ann, "k1", [at("1d", 19, 3)]);
  assert.deepEqual(await kept("k1"), [["1d", 19, 3]]);
  // A later upload brings the next age. What it says of an age already kept is not taken.
  await send(tokens.ann, "k1", [at("7d", 15, 8), at("1d", 5, 9)]);
  assert.deepEqual(await kept("k1"), [["1d", 19, 3], ["7d", 15, 8]]);
  // A machine whose ledger was lost sends none: the ones kept stay.
  await send(tokens.ann, "k1", undefined);
  assert.deepEqual(await kept("k1"), [["1d", 19, 3], ["7d", 15, 8]]);
  // Counts and times are kept, and nothing else sent with one; an age nobody knows is not one.
  await send(tokens.ann, "k1", [at("30d", 12, 31, 0, { path: "SECRET.rs", text: "SECRET line" }), at("2d", 1, 2), at("90d", 1, 90)]);
  assert.deepEqual(await kept("k1"), [["1d", 19, 3], ["7d", 15, 8], ["30d", 12, 31]]);
  const [stored] = await db.query<{ payload: unknown; checkpoints: unknown }>(
    `SELECT payload, checkpoints FROM sessions WHERE session_id = 'k1'`,
  );
  assert.doesNotMatch(JSON.stringify(stored), /SECRET|2d|90d/);

  // Two more sessions: another agent's, measured at 7 days, and one of the same agent that is not that old.
  await send(tokens.bob, "k2", [at("7d", 4, 7)], { source: "cursor", models: ["gpt-5"] });
  await send(tokens.ann, "k3", undefined);
  const summary = await byTool();
  const tool = (key: string) => summary.groups.find((g: any) => g.key === key);
  assert.deepEqual(tool("claude-code").kept_7d, { lines_added: 20, lines_surviving: 15, sessions_reached: 1, sessions_total: 2 });
  assert.deepEqual(tool("claude-code").kept_30d, { lines_added: 20, lines_surviving: 12, sessions_reached: 1, sessions_total: 2 });
  assert.deepEqual(tool("cursor").kept_7d, { lines_added: 20, lines_surviving: 4, sessions_reached: 1, sessions_total: 1 });
  // no session of it has reached 30 days
  assert.deepEqual(tool("cursor").kept_30d, { lines_added: 0, lines_surviving: 0, sessions_reached: 0, sessions_total: 1 });
  assert.deepEqual(summary.total.kept_7d, { lines_added: 40, lines_surviving: 19, sessions_reached: 2, sessions_total: 3 });
  assert.deepEqual(summary.total.kept_1d, { lines_added: 20, lines_surviving: 19, sessions_reached: 1, sessions_total: 3 });
  // the latest measurement is beside them, as before
  assert.deepEqual(summary.total.rewrite.lines_added, 60);
  const byModel = (await get(tokens.admin, `/summary?by=model&repo_is=${encodeURIComponent(repo)}`)).body.groups;
  assert.deepEqual(
    byModel.map((g: any) => [g.key, g.kept_7d.sessions_reached, g.kept_7d.sessions_total]).sort(),
    [["claude-opus-5-5", 1, 2], ["gpt-5", 1, 1]],
  );

  // The session went on until day 10: the checkpoints counted from its first end are of a session
  // that had not ended, and go, whenever they were measured. Its ages count from the new end.
  await send(tokens.ann, "k1", [at("1d", 18, 2, 10)], { ended_at: days(10) });
  assert.deepEqual(await kept("k1"), [["1d", 18, 2]]);
  // With the end unchanged, one taken late is kept as late as it was; one that says another end is not.
  await send(tokens.ann, "k1", [at("7d", 14, 9, 10), at("30d", 9, 31, 0)], { ended_at: days(10) });
  assert.deepEqual(await kept("k1"), [["1d", 18, 2], ["7d", 14, 9]]);
  // Nor is one measured before the session was as old as the age it is for.
  await send(tokens.ann, "k1", [at("30d", 9, 29, 10)], { ended_at: days(10) });
  assert.deepEqual(await kept("k1"), [["1d", 18, 2], ["7d", 14, 9]]);

  // A day's checkpoint taken late, on day 7, and then the end is read again as day 6. The measurement
  // is a day after that end too, and is still not its checkpoint: it was counted from the other. What
  // the machine measures next, from this end, is the one kept.
  await send(tokens.ann, "k-reread", [at("1d", 19, 7)]);
  assert.deepEqual(await kept("k-reread"), [["1d", 19, 7]]);
  await send(tokens.ann, "k-reread", [at("1d", 19, 7)], { ended_at: days(6) });
  assert.deepEqual(await kept("k-reread"), []);
  await send(tokens.ann, "k-reread", [at("1d", 17, 2, 6)], { ended_at: days(6) });
  assert.deepEqual(await kept("k-reread"), [["1d", 17, 2]]);
  // A session with no end has no age, and so no checkpoint: the ones it had go, and none is taken.
  await send(tokens.ann, "k-reread", [at("1d", 17, 2, 6)], { ended_at: null });
  assert.deepEqual(await kept("k-reread"), []);

  // Two first uploads of one session at once: each brings a checkpoint, and both are kept.
  const twice = (checkpoint: unknown) => put(tokens.ann, { ...upload("k-twice", { repo: { root: "~/src/kept", remote: repo } }), checkpoints: [checkpoint] } as Upload);
  const both = await Promise.all([twice(at("1d", 19, 1)), twice(at("7d", 15, 7))]);
  assert.deepEqual(both.map((response) => response.status), [200, 200]);
  assert.deepEqual(await kept("k-twice"), [["1d", 19, 1], ["7d", 15, 7]]);
});
