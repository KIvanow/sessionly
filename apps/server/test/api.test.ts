import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Upload } from "@sessionly/schema";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/auth.ts";
import { openDb, type Db } from "../src/db.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const tokens = { admin: "", ann: "", bob: "" };

before(async () => {
  db = await openDb("memory://");
  app = createApp(db, { bootstrap: { token: "bootstrap-secret", email: "root@example.com" } });
  tokens.admin = (await createToken(db, { email: "boss@example.com", role: "admin" })).token;
  tokens.ann = (await createToken(db, { email: "Ann@Example.com", name: "Ann", role: "member" })).token;
  tokens.bob = (await createToken(db, { email: "bob@example.com", role: "member" })).token;
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
  assert.deepEqual(ping, { status: 200, body: { ok: true, email: "ann@example.com", name: "Ann", role: "member" } });
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
