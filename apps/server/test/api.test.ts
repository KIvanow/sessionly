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

test("what later commits did 1, 7 and 30 days after a session ended is kept as checkpoints are, and summed", async () => {
  const repo = "github.com/acme/later";
  const ended = "2026-11-10T10:30:00Z";
  const days = (n: number) => new Date(Date.parse(ended) + n * 86_400_000).toISOString();
  /** An age's count taken `age` days after the session ended, which it did `from` days after it first had. */
  const at = (checkpoint: string, counts: Record<string, unknown>, age: number, from = 0) => ({
    checkpoint,
    lines_tracked: 40,
    fix_commits: 0,
    likely_fix_commits: 0,
    lines_fixed: 0,
    rework_commits: 0,
    lines_reworked: 0,
    revert_commits: 0,
    lines_reverted: 0,
    relanded: false,
    computed_at: days(from + age),
    age_seconds: age * 86_400,
    ended_at: days(from),
    late: false,
    scope: "head_and_default",
    ...counts,
  });
  const send = async (token: string, id: string, outcomes: unknown[] | undefined, overrides: Record<string, unknown> = {}) => {
    const body = upload(id, { repo: { root: "~/src/later", remote: repo }, ...overrides });
    assert.equal((await put(token, { ...body, outcomes } as Upload)).status, 200);
  };
  const kept = async (id: string, source = "claude-code") =>
    ((await get(tokens.admin, `/sessions/machine-1/${source}/${id}`)).body.upload.outcomes ?? []).map((o: any) => [
      o.checkpoint,
      o.fix_commits,
      o.age_seconds / 86_400,
    ]);
  const byTool = async () => (await get(tokens.admin, `/summary?by=tool&repo_is=${encodeURIComponent(repo)}`)).body;

  // As an older sessionly sends it: none.
  await send(tokens.ann, "o1", undefined);
  assert.deepEqual(await kept("o1"), []);
  assert.equal((await byTool()).total.outcomes_7d.sessions_reached, 0);

  const cursorFixed = { source: "cursor", fix_commits: 1, likely_fix_commits: 1, lines_fixed: 2, revert_commits: 0, lines_reverted: 0, rework_commits: 0, lines_reworked: 0 };
  await send(tokens.ann, "o1", [
    at("1d", {}, 1),
    at(
      "7d",
      {
        fix_commits: 2,
        likely_fix_commits: 5,
        lines_fixed: 3.5,
        // Another agent's commits: no more of them between them than of all, one entry for each agent, and an agent by a name only.
        by_agent: [{ ...cursorFixed, fix_commits: 3, likely_fix_commits: 9 }, { ...cursorFixed, fix_commits: 2 }, { ...cursorFixed, source: "SECRET name/" }, { ...cursorFixed, source: "codex", fix_commits: 1, lines_fixed: 1 }],
      },
      8,
    ),
  ]);
  assert.deepEqual(await kept("o1"), [["1d", 0, 1], ["7d", 2, 8]]);
  // One kept is not replaced; a lost ledger sends none and takes none away; one counted too early is not taken.
  await send(tokens.ann, "o1", [at("7d", { fix_commits: 9 }, 9), at("30d", {}, 29)]);
  await send(tokens.ann, "o1", undefined);
  assert.deepEqual(await kept("o1"), [["1d", 0, 1], ["7d", 2, 8]]);
  // Counts, times and the scope are kept, and nothing else sent with one.
  await send(tokens.ann, "o1", [{ ...at("30d", { revert_commits: 1, lines_reverted: 40, scope: "SECRET" }, 31), sha: "SECRETSHA", subject: "SECRET subject" }]);
  const [stored] = await db.query<{ payload: unknown; outcomes: unknown }>(`SELECT payload, outcomes FROM sessions WHERE session_id = 'o1'`);
  assert.doesNotMatch(JSON.stringify(stored), /SECRET/);

  // Another agent's session, reverted and relanded by day 30; and one not yet a week old.
  await send(tokens.bob, "o2", [at("7d", { rework_commits: 1, lines_reworked: 2, by_agent: [{ ...cursorFixed, fix_commits: 0, likely_fix_commits: 0, lines_fixed: 0, rework_commits: 1, lines_reworked: 2 }] }, 7), at("30d", { revert_commits: 1, relanded: true }, 30)], {
    source: "cursor",
  });
  await send(tokens.ann, "o3", [at("1d", {}, 1)]);
  const summary = await byTool();
  const tool = (key: string) => summary.groups.find((g: any) => g.key === key);
  assert.deepEqual(tool("claude-code").outcomes_7d, {
    sessions_reached: 1,
    sessions_total: 2,
    lines_tracked: 40,
    sessions_with_fix: 1,
    fix_commits: 2,
    // No more likely fixes than fixes.
    likely_fix_commits: 2,
    lines_fixed: 3.5,
    sessions_reverted: 0,
    revert_commits: 0,
    lines_reverted: 0,
    rework_commits: 0,
    lines_reworked: 0,
    by_agent: [
      { ...cursorFixed, source: "codex", fix_commits: 0, likely_fix_commits: 0, lines_fixed: 1 },
      { ...cursorFixed, fix_commits: 2, likely_fix_commits: 2 },
    ],
  });
  assert.equal(tool("claude-code").outcomes_30d.sessions_reverted, 1);
  // Relanded within the age: reverted, and not counted as a reverted session.
  assert.deepEqual([tool("cursor").outcomes_30d.revert_commits, tool("cursor").outcomes_30d.sessions_reverted], [1, 0]);
  assert.deepEqual(
    [summary.total.outcomes_7d.sessions_reached, summary.total.outcomes_7d.sessions_total, summary.total.outcomes_7d.rework_commits],
    [2, 3, 1],
  );
  // Summed over the groups, of the same agent.
  assert.deepEqual(
    summary.total.outcomes_7d.by_agent.map((b: any) => [b.source, b.fix_commits, b.rework_commits]),
    [["codex", 0, 0], ["cursor", 2, 1]],
  );

  // A count is a number, none below nothing, none past what can be summed; and no more agents than there are.
  await send(tokens.ann, "o4", [
    at("7d", { lines_tracked: 1.7e308, fix_commits: 2, lines_fixed: -5, by_agent: Array.from({ length: 40 }, (_, i) => ({ ...cursorFixed, source: `agent${i}` })) }, 8),
  ]);
  const [o4] = await db.query<{ outcomes: any }>(`SELECT outcomes FROM sessions WHERE session_id = 'o4'`);
  const week = (typeof o4!.outcomes === "string" ? JSON.parse(o4!.outcomes) : o4!.outcomes)["7d"];
  assert.deepEqual([week.lines_tracked, week.lines_fixed, week.by_agent.length], [1e12, 0, 16]);
  assert.equal(week.by_agent.reduce((n: number, b: any) => n + b.fix_commits, 0), 2);
  assert.ok(week.by_agent.every((b: any) => b.lines_fixed === 0));
  assert.equal((await get(tokens.admin, `/summary?by=tool&repo_is=${encodeURIComponent(repo)}`)).status, 200);
  // A session with outcomes and no rewrite measurement is of those they are out of.
  const before = (await byTool()).total.outcomes_7d;
  const bare = { ...upload("o5", { repo: { root: "~/src/later", remote: repo } }), rewrite: null, outcomes: [at("7d", {}, 8)] } as Upload;
  assert.equal((await put(tokens.ann, bare)).status, 200);
  const after = (await byTool()).total.outcomes_7d;
  assert.deepEqual([after.sessions_reached - before.sessions_reached, after.sessions_total - before.sessions_total], [1, 1]);

  // The session went on: what was counted from its first end goes.
  await send(tokens.ann, "o1", [at("1d", {}, 2, 10)], { ended_at: days(10) });
  assert.deepEqual(await kept("o1"), [["1d", 0, 2]]);
});

test("outcomes a server from before them kept in the payload are kept from there after the upgrade", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { migrationAt, keepOutcomesFromPayloads } = await import("../src/db.ts");
  const { testDbUrl } = await import("./helpers.ts");
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-outcomes-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const url = folder ? `file:${join(folder, "db")}` : fresh;
  const old = await openDb(url, { migrations: migrationAt("ALTER TABLE sessions ADD COLUMN outcomes") });
  const ended = "2026-11-10T10:30:00Z";
  const at = (checkpoint: string, extra: Record<string, unknown> = {}) => ({
    checkpoint, lines_tracked: 40, fix_commits: 1, likely_fix_commits: 1, lines_fixed: 2, rework_commits: 0, lines_reworked: 0,
    revert_commits: 0, lines_reverted: 0, relanded: false, computed_at: "2026-11-18T10:30:00Z", age_seconds: 8 * 86_400,
    ended_at: ended, late: false, scope: "head_and_default", ...extra,
  });
  const payload = (outcomes: unknown) => JSON.stringify({ session: { ended_at: ended }, outcomes });
  await old.query(
    `INSERT INTO sessions (org_id, machine_id, source, session_id, owner_email, content, rw_lines_added, payload) VALUES
       ('default', 'm1', 'claude-code', 'with', 'ann@example.com', 'metadata', 20, $1::jsonb),
       ('default', 'm1', 'claude-code', 'early', 'ann@example.com', 'metadata', 20, $2::jsonb),
       ('default', 'm1', 'claude-code', 'odd', 'ann@example.com', 'metadata', 20, '{"session":{},"outcomes":"none"}'),
       ('default', 'm1', 'claude-code', 'nulls', 'ann@example.com', 'metadata', 20, $3::jsonb)`,
    [payload([at("7d", { sha: "SECRET" }), at("1d"), at("90d")]), payload([at("30d")]), payload([null, 5, at("7d", { by_agent: [null, { source: "cursor", fix_commits: 1 }] })])],
  );
  await old.close();
  const now = await openDb(url);
  t.after(() => now.close());
  // An entry that is no count, or a list that is none, is none: and the rest are kept.
  assert.deepEqual(await keepOutcomesFromPayloads(now, 1), { kept: 4, failed: 0 });
  // Once kept, not looked at again.
  assert.deepEqual(await keepOutcomesFromPayloads(now), { kept: 0, failed: 0 });
  const rows = await now.query<{ session_id: string; outcomes: any; payload: any }>(`SELECT session_id, outcomes, payload FROM sessions ORDER BY session_id`);
  const of = (id: string) => rows.find((r) => r.session_id === id)!;
  const json = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  assert.deepEqual(Object.keys(json(of("with").outcomes)).sort(), ["1d", "7d"]);
  assert.deepEqual(json(of("with").payload).outcomes.map((o: any) => o.checkpoint), ["1d", "7d"]);
  assert.doesNotMatch(JSON.stringify(json(of("with").payload)), /SECRET/);
  // Counted before the session was 30 days old: not taken, and not looked at again.
  assert.deepEqual([json(of("early").outcomes), json(of("early").payload).outcomes], [{}, []]);
  assert.deepEqual([json(of("odd").outcomes), json(of("odd").payload).outcomes], [{}, []]);
  assert.deepEqual(Object.keys(json(of("nulls").outcomes)), ["7d"]);
  assert.deepEqual(json(of("nulls").outcomes)["7d"].by_agent.map((b: any) => b.source), ["cursor"]);
  const upgraded = createApp(now, {});
  const token = await tokenFor(now, { email: "boss@example.com", role: "admin" });
  const total = ((await (await upgraded.request("/api/v1/summary?by=tool", { headers: auth(token) })).json()) as any).total;
  assert.deepEqual([total.outcomes_7d.sessions_reached, total.outcomes_7d.fix_commits], [2, 2]);
});

test("outcomes a server from before them kept in the payload stay when the session is uploaded without them before they are kept", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { migrationAt, keepOutcomesFromPayloads } = await import("../src/db.ts");
  const { testDbUrl } = await import("./helpers.ts");
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-outcomes-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const url = folder ? `file:${join(folder, "db")}` : fresh;
  const old = await openDb(url, { migrations: migrationAt("ALTER TABLE sessions ADD COLUMN outcomes") });
  const ended = "2026-11-10T10:30:00Z";
  const at = (checkpoint: string) => ({
    checkpoint, lines_tracked: 40, fix_commits: 1, likely_fix_commits: 1, lines_fixed: 2, rework_commits: 0, lines_reworked: 0,
    revert_commits: 0, lines_reverted: 0, relanded: false, computed_at: "2026-11-18T10:30:00Z", age_seconds: 8 * 86_400,
    ended_at: ended, late: false, scope: "head_and_default",
  });
  const sessions = ["again", "went-on", "meanwhile"];
  for (const id of sessions) {
    await old.query(
      `INSERT INTO sessions (org_id, machine_id, source, session_id, owner_email, content, rw_lines_added, payload)
       VALUES ('default', 'machine-1', 'claude-code', $1, 'ann@example.com', 'metadata', 20, $2::jsonb)`,
      [id, JSON.stringify({ ...upload(id), outcomes: [at("7d")] })],
    );
  }
  await old.close();
  const now = await openDb(url);
  t.after(() => now.close());
  const upgraded = createApp(now, {});
  const ann = await tokenFor(now, { email: "ann@example.com", role: "member" });
  const send = async (body: Upload) => {
    const s = body.session!;
    const response = await upgraded.request(`/api/v1/sessions/${s.machine_id}/${s.source}/${s.session_id}`, {
      method: "PUT",
      headers: { ...auth(ann), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
  };
  const kept = async (id: string) => {
    const [row] = await now.query<{ outcomes: any; payload: any }>(`SELECT outcomes, payload FROM sessions WHERE session_id = $1`, [id]);
    const json = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
    return [Object.keys(json(row!.outcomes)), (json(row!.payload).outcomes ?? []).map((o: any) => o.checkpoint)];
  };

  // Uploaded again before the server got to it, with no outcomes (switched off since, or a ledger lost): what it has stays.
  await send(upload("again"));
  assert.deepEqual(await kept("again"), [["7d"], ["7d"]]);
  // The session went on: those counted from its first end go, as they would have once kept.
  await send(upload("went-on", { ended_at: "2026-11-12T10:30:00Z" }));
  assert.deepEqual(await kept("went-on"), [[], []]);
  // Uploaded between being read and being kept: the upload kept them, and the server, finding it changed, counts it as none it kept.
  let raced = false;
  const racing = {
    query: async (sql: string, params?: unknown[]) => {
      if (!raced && sql.trimStart().startsWith("UPDATE sessions SET outcomes")) {
        raced = true;
        await send(upload("meanwhile"));
      }
      return now.query(sql, params);
    },
  } as unknown as Db;
  assert.deepEqual(await keepOutcomesFromPayloads(racing), { kept: 0, failed: 0 });
  assert.ok(raced);
  assert.deepEqual(await kept("meanwhile"), [["7d"], ["7d"]]);
  const admin = await tokenFor(now, { email: "boss@example.com", role: "admin" });
  const total = ((await (await upgraded.request("/api/v1/summary?by=tool", { headers: auth(admin) })).json()) as any).total;
  assert.deepEqual([total.outcomes_7d.sessions_reached, total.outcomes_7d.fix_commits], [2, 2]);
});

test("outcomes a server from before them kept in the payload beside those kept already are kept too", async (t) => {
  const { keepOutcomesFromPayloads } = await import("../src/db.ts");
  const now = await testDb();
  t.after(() => now.close());
  const upgraded = createApp(now, {});
  const ann = await tokenFor(now, { email: "ann@example.com", role: "member" });
  const admin = await tokenFor(now, { email: "boss@example.com", role: "admin" });
  const ended = "2026-11-10T10:30:00Z";
  const later = "2026-11-12T10:30:00Z";
  const at = (checkpoint: string, extra: Record<string, unknown> = {}) => ({
    checkpoint, lines_tracked: 40, fix_commits: 1, likely_fix_commits: 1, lines_fixed: 2, rework_commits: 0, lines_reworked: 0,
    revert_commits: 0, lines_reverted: 0, relanded: false, computed_at: "2026-12-14T10:30:00Z", age_seconds: 34 * 86_400,
    ended_at: ended, late: false, scope: "head_and_default", ...extra,
  });
  const send = async (body: Upload) => {
    const s = body.session!;
    const response = await upgraded.request(`/api/v1/sessions/${s.machine_id}/${s.source}/${s.session_id}`, {
      method: "PUT",
      headers: { ...auth(ann), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
  };
  // A server from before outcomes, still running beside this one (a rolling
  // upgrade) or rolled back to: it stores the upload as it came, in the
  // payload, and leaves the column it does not know of as it was.
  const olderStores = async (body: Upload) => {
    await now.query(`UPDATE sessions SET payload = $2::jsonb, ended_at = $3 WHERE session_id = $1`, [
      body.session!.session_id,
      JSON.stringify(body),
      body.session!.ended_at,
    ]);
  };
  const json = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  const kept = async (id: string) => {
    const [row] = await now.query<{ outcomes: any; payload: any }>(`SELECT outcomes, payload FROM sessions WHERE session_id = $1`, [id]);
    return [Object.keys(json(row!.outcomes)), (json(row!.payload).outcomes ?? []).map((o: any) => o.checkpoint)];
  };
  const counted = async (id: string, age: string) => {
    const [row] = await now.query<{ outcomes: any }>(`SELECT outcomes FROM sessions WHERE session_id = $1`, [id]);
    return json(row!.outcomes)[age];
  };

  // 7 days kept here; 30 days, when the session was that old, went to the older server.
  for (const id of ["beside", "uploaded", "first", "raced"]) {
    await send({ ...upload(id), outcomes: [at("7d")] } as Upload);
    await olderStores({ ...upload(id), outcomes: [at("7d", { fix_commits: 5 }), at("30d")] } as Upload);
  }
  // Uploaded here again, with none (switched off since), before the server got to it: those of the payload stay too.
  await send(upload("uploaded", { counts: { prompts: 3 } }));
  assert.deepEqual(await kept("uploaded"), [["7d", "30d"], ["7d", "30d"]]);
  // It went on while the older server had it: those counted from its first end go.
  await send({ ...upload("went-on"), outcomes: [at("7d")] } as Upload);
  await olderStores(upload("went-on", { ended_at: later }));
  await send({ ...upload("went-on-counted"), outcomes: [at("7d")] } as Upload);
  await olderStores({ ...upload("went-on-counted", { ended_at: later }), outcomes: [at("7d", { ended_at: later, fix_commits: 3 })] } as Upload);
  // Uploaded between being read and being kept: what the upload kept stays, and the server counts it as none it kept.
  let raced = false;
  const racing = {
    query: async (sql: string, params?: unknown[]) => {
      if (!raced && sql.trimStart().startsWith("UPDATE sessions SET outcomes") && params?.[3] === "raced") {
        raced = true;
        await send(upload("raced", { counts: { prompts: 3 } }));
      }
      return now.query(sql, params);
    },
  } as unknown as Db;
  assert.deepEqual(await keepOutcomesFromPayloads(racing), { kept: 4, failed: 0 });
  assert.ok(raced);
  // Once kept, not looked at again.
  assert.deepEqual(await keepOutcomesFromPayloads(now), { kept: 0, failed: 0 });
  for (const id of ["beside", "uploaded", "first", "raced"]) assert.deepEqual(await kept(id), [["7d", "30d"], ["7d", "30d"]], id);
  // The first kept is the one that stays.
  assert.equal((await counted("beside", "7d")).fix_commits, 1);
  assert.deepEqual(await kept("went-on"), [[], []]);
  assert.deepEqual(await kept("went-on-counted"), [["7d"], ["7d"]]);
  assert.equal((await counted("went-on-counted", "7d")).fix_commits, 3);
  // Uploaded here again: nothing of it is lost.
  await send(upload("first", { counts: { prompts: 4 } }));
  assert.deepEqual(await kept("first"), [["7d", "30d"], ["7d", "30d"]]);
  const total = ((await (await upgraded.request("/api/v1/summary?by=tool", { headers: auth(admin) })).json()) as any).total;
  assert.deepEqual([total.outcomes_7d.sessions_reached, total.outcomes_7d.fix_commits], [5, 7]);
  assert.deepEqual([total.outcomes_30d.sessions_reached, total.outcomes_30d.fix_commits], [4, 4]);
});

test("an outcome's scope is one of those the binary sends, and any other is unknown", async () => {
  const { mergeOutcomes } = await import("../src/sessions.ts");
  const ended = "2026-11-10T10:30:00Z";
  const at = (checkpoint: string, scope: unknown) => ({ checkpoint, computed_at: "2026-12-18T10:30:00Z", ended_at: ended, scope });
  const kept = mergeOutcomes({}, {
    session: { ended_at: ended },
    outcomes: [at("1d", "head_and_default"), at("7d", "head_only"), at("30d", "every_branch")],
  } as Upload);
  assert.deepEqual(["1d", "7d", "30d"].map((age) => kept[age]!.scope), ["head_and_default", "head_only", "unknown"]);
  // None at all is not known either.
  const none = mergeOutcomes({}, { session: { ended_at: ended }, outcomes: [{ checkpoint: "7d", computed_at: "2026-11-18T10:30:00Z", ended_at: ended }] } as Upload);
  assert.equal(none["7d"]!.scope, "unknown");
});

test("an agent's likely fixes are no more than its fixes, and what it is not left takes nothing from the next", async () => {
  const { mergeOutcomes } = await import("../src/sessions.ts");
  const ended = "2026-11-10T10:30:00Z";
  const by = [
    { source: "aaa", fix_commits: 0, likely_fix_commits: 1 },
    { source: "bbb", fix_commits: 2, likely_fix_commits: 1 },
  ];
  const kept = mergeOutcomes({}, {
    session: { ended_at: ended },
    outcomes: [{ checkpoint: "7d", fix_commits: 2, likely_fix_commits: 1, computed_at: "2026-11-18T10:30:00Z", ended_at: ended, by_agent: by }],
  } as Upload);
  assert.deepEqual(kept["7d"]!.by_agent.map((b) => [b.source, b.fix_commits, b.likely_fix_commits]), [["aaa", 0, 0], ["bbb", 2, 1]]);
});

test("a name or a time an older server kept as anything but a string is none, and fails no upload", async () => {
  const { mergeOutcomes } = await import("../src/sessions.ts");
  const ended = "2026-11-10T10:30:00Z";
  const age = { checkpoint: "7d", fix_commits: 1, computed_at: "2026-11-18T10:30:00Z", ended_at: ended };
  const odd = { toString: 1 };
  const kept = mergeOutcomes({}, {
    session: { ended_at: ended },
    outcomes: [{ ...age, by_agent: [{ source: odd, fix_commits: 1 }, { source: ["cursor"], fix_commits: 1 }] }],
  } as unknown as Upload);
  assert.deepEqual([kept["7d"]!.fix_commits, kept["7d"]!.by_agent], [1, []]);
  // An age with such a time is none, kept before or brought.
  for (const at of [{ ended_at: odd }, { computed_at: odd }, { ended_at: ["2026-11-10T10:30:00Z"] }]) {
    assert.deepEqual(mergeOutcomes({}, { session: { ended_at: ended }, outcomes: [{ ...age, ...at }] } as unknown as Upload), {});
    assert.deepEqual(mergeOutcomes({ "7d": { ...age, ...at } }, { session: { ended_at: ended } } as Upload), {});
  }
  assert.deepEqual(mergeOutcomes({}, { session: { ended_at: odd }, outcomes: [age] } as unknown as Upload), {});
});

test("checkpoints a server from before them kept in the payload are summed after the upgrade", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { migrationAt } = await import("../src/db.ts");
  const { testDbUrl } = await import("./helpers.ts");
  const fresh = await testDbUrl();
  const folder = fresh === "memory://" ? mkdtempSync(join(tmpdir(), "sessionly-kept-")) : undefined;
  t.after(() => folder && rmSync(folder, { recursive: true, force: true }));
  const url = folder ? `file:${join(folder, "db")}` : fresh;
  const old = await openDb(url, { migrations: migrationAt("ALTER TABLE sessions ADD COLUMN checkpoints") });
  const ended = "2026-11-10T10:30:00Z";
  const at = (checkpoint: string, surviving: number, end = ended) => ({ checkpoint, added: 20, surviving, measured_at: "2026-12-11T10:30:00Z", age_seconds: 31 * 86_400, ended_at: end });
  const payload = (checkpoints: unknown) => JSON.stringify({ session: { ended_at: ended }, checkpoints });
  await old.query(
    `INSERT INTO sessions (org_id, machine_id, source, session_id, owner_email, content, rw_lines_added, payload) VALUES
       ('default', 'm1', 'claude-code', 'with', 'ann@example.com', 'metadata', 20, $1::jsonb),
       ('default', 'm1', 'claude-code', 'other-end', 'ann@example.com', 'metadata', 20, $2::jsonb),
       ('default', 'm1', 'claude-code', 'none', 'ann@example.com', 'metadata', 20, '{"session":{}}'),
       ('default', 'm1', 'claude-code', 'odd', 'ann@example.com', 'metadata', 20, '{"session":{},"checkpoints":"none"}')`,
    [payload([at("7d", 15), at("30d", 12), at("90d", 1)]), payload([at("7d", 9, "2026-11-01T00:00:00Z")])],
  );
  await old.close();
  const now = await openDb(url);
  t.after(() => now.close());
  const upgraded = createApp(now, {});
  const token = await tokenFor(now, { email: "boss@example.com", role: "admin" });
  const response = await upgraded.request("/api/v1/summary?by=tool", { headers: auth(token) });
  const total = ((await response.json()) as any).total;
  assert.deepEqual(total.kept_7d, { lines_added: 20, lines_surviving: 15, sessions_reached: 1, sessions_total: 4 });
  assert.deepEqual(total.kept_30d, { lines_added: 20, lines_surviving: 12, sessions_reached: 1, sessions_total: 4 });
  const [row] = await now.query<{ checkpoints: any }>(`SELECT checkpoints FROM sessions WHERE session_id = 'with'`);
  const kept = typeof row!.checkpoints === "string" ? JSON.parse(row!.checkpoints) : row!.checkpoints;
  assert.deepEqual(Object.keys(kept).sort(), ["30d", "7d"]);
  assert.deepEqual(kept["7d"], { added: 20, surviving: 15, measured_at: "2026-12-11T10:30:00Z", age_seconds: 31 * 86_400, ended_at: ended });
});
