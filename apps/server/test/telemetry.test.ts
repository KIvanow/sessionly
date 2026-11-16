import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db.ts";
import { POSTHOG, telemetryFrom } from "../src/telemetry.ts";
import { testDb } from "./helpers.ts";

let db: Db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.close();
});

test("the dashboard counts its pages unless whoever runs the server says not to", () => {
  assert.deepEqual(telemetryFrom({}), { ...POSTHOG, hosted: false });
  assert.deepEqual(telemetryFrom({ SESSIONLY_HOSTED: "true" }), { ...POSTHOG, hosted: true });
  for (const off of ["off", "OFF", " false ", "0", "no"]) {
    assert.equal(telemetryFrom({ SESSIONLY_TELEMETRY: off }), null, off);
  }
  assert.deepEqual(telemetryFrom({ SESSIONLY_TELEMETRY: "on" }), { ...POSTHOG, hosted: false });
  // DO_NOT_TRACK set to anything but a "no" turns it off too.
  assert.equal(telemetryFrom({ DO_NOT_TRACK: "1" }), null);
  assert.equal(telemetryFrom({ DO_NOT_TRACK: "true" }), null);
  assert.deepEqual(telemetryFrom({ DO_NOT_TRACK: "0" }), { ...POSTHOG, hosted: false });
});

test("the dashboard is told whether to count, and may reach PostHog only then", async () => {
  const webRoot = mkdtempSync(join(tmpdir(), "sessionly-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Sessionly</title>");
  const telemetry = telemetryFrom({});
  const counting = createApp(db, { webRoot, telemetry });
  assert.deepEqual(await (await counting.request("/api/v1/telemetry")).json(), telemetry);
  const policy = (await counting.request("/")).headers.get("content-security-policy") ?? "";
  assert.match(policy, /connect-src 'self' https:\/\/eu\.i\.posthog\.com(;|$)/);
  assert.match(policy, /script-src 'self'(;|$)/);

  const quiet = createApp(db, { webRoot, telemetry: telemetryFrom({ SESSIONLY_TELEMETRY: "off" }) });
  const asked = await quiet.request("/api/v1/telemetry");
  assert.equal(asked.status, 200);
  assert.equal(await asked.json(), null);
  assert.match((await quiet.request("/")).headers.get("content-security-policy") ?? "", /connect-src 'self'(;|$)/);
});
