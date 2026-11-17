import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { askedNotTo, countOf, pageOf, send, startTelemetry } from "../src/telemetry.ts";

const telemetry = { key: "phc_test", host: "https://eu.i.posthog.com", hosted: false };

test("a page is counted by its name, never by what is in its address", () => {
  assert.equal(pageOf(""), "overview");
  assert.equal(pageOf("#/"), "overview");
  assert.equal(pageOf("#/sessions"), "sessions");
  assert.equal(pageOf("#/sessions?user=ann@example.com"), "sessions");
  assert.equal(pageOf("#/session/acme/ann@example.com/0193-abcd"), "session");
  assert.equal(pageOf("#/team"), "team");
  assert.equal(pageOf("#/pull/github.com%2Facme%2Fweb/7"), "pull");
  assert.equal(pageOf("#signed-in"), "other");
  assert.equal(pageOf("#/ann@example.com"), "other");
});

test("a count is the page's name, the kind of server and an id made up for the visit, and nothing else", () => {
  // The whole of it, so that anything added to it has to be added here too.
  assert.deepEqual(countOf(telemetry, "0123abcd", "session"), {
    api_key: "phc_test",
    event: "$pageview",
    distinct_id: "0123abcd",
    properties: {
      $current_url: "https://dashboard.sessionly.invalid/session",
      $pathname: "/session",
      deployment: "self-hosted",
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });
  assert.equal(countOf({ ...telemetry, hosted: true }, "x", "team").properties.deployment, "hosted");
});

/** What a browser would have to offer, for a dashboard at a team's own address, on a page that names people. */
function browser(over: { doNotTrack?: string; globalPrivacyControl?: boolean; says?: unknown; fails?: boolean } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const listeners: (() => void)[] = [];
  const location = { hash: "#/session/acme/ann@acme.com/0193-abcd", href: "https://sessionly.internal.acme.com/#/session/acme/ann@acme.com/0193-abcd" };
  const globals = globalThis as Record<string, unknown>;
  globals.window = { location, addEventListener: (_: string, fn: () => void) => void listeners.push(fn) };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { doNotTrack: over.doNotTrack ?? null, globalPrivacyControl: over.globalPrivacyControl, userAgent: "Mozilla/5.0 (Acme OS) Firefox/153.0" },
  });
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url) === "/api/v1/telemetry") {
      if (over.fails) throw new TypeError("the server could not be reached");
      return new Response(JSON.stringify("says" in over ? over.says : telemetry));
    }
    sent.push({ url: String(url), init });
    return new Response(null);
  }) as typeof fetch;
  return {
    sent,
    /** Go to another page of the dashboard. */
    go(hash: string) {
      location.hash = hash;
      for (const fn of listeners) fn();
    },
  };
}
const fetching = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetching;
  delete (globalThis as Record<string, unknown>).window;
});

/** The count in the address a request was made to. */
const countIn = (url: string) => JSON.parse(new URL(url).searchParams.get("data") ?? "null");

test("a count is sent so that the browser adds nothing of where the dashboard runs", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const count = countOf(telemetry, "0123abcd", "team");
  await send("https://eu.i.posthog.com", count, (async (url: string | URL, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return new Response(null);
  }) as typeof fetch);
  // A GET that is "no-cors", with no referrer and no credentials, is sent
  // with no `Origin`, no `Referer` and no cookie. (Tried in Chromium and in
  // Firefox: a POST made the same way still names the page's origin in
  // Chromium.) All of this, and no more: no body, and no header of its own.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.init, { method: "GET", mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  const to = new URL(sent[0]?.url ?? "");
  assert.equal(to.origin + to.pathname, "https://eu.i.posthog.com/i/v0/e/");
  assert.deepEqual([...to.searchParams.keys()], ["data"]);
  assert.deepEqual(countIn(to.href), count);
});

test("pages are counted as they are opened: once each time the page changes, and with nothing of the address", async () => {
  const at = browser();
  await startTelemetry();
  at.go("#/session/acme/bob@acme.com/0193-ffff");
  at.go("#/sessions?user=ann@acme.com");
  at.go("#/sessions?user=bob@acme.com");
  at.go("#/team");
  const counts = at.sent.map((each) => countIn(each.url));
  // Another session, or another filter, is the same page.
  assert.deepEqual(counts.map((count) => count.properties.$pathname), ["/session", "/sessions", "/team"]);
  // One id for the visit: 32 hex digits from chance, the same on each count.
  assert.match(counts[0].distinct_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(new Set(counts.map((count) => count.distinct_id)).size, 1);
  for (const each of at.sent) {
    assert.ok(each.url.startsWith("https://eu.i.posthog.com/i/v0/e/?data="), each.url);
    assert.deepEqual([each.init.method, each.init.mode, each.init.credentials, each.init.referrerPolicy], ["GET", "no-cors", "omit", "no-referrer"]);
    // Nothing of the address, the organisation, the people or the browser is in what is sent.
    assert.doesNotMatch(`${decodeURIComponent(each.url)} ${JSON.stringify(each.init)}`, /acme|ann@|bob@|0193|internal|Firefox|Mozilla/i);
  }
  assert.deepEqual(counts[1], countOf(telemetry, counts[0].distinct_id, "sessions"));
  // Another load of the dashboard is another visit.
  const again = browser();
  await startTelemetry();
  assert.notEqual(countIn(again.sent[0]?.url ?? "").distinct_id, counts[0].distinct_id);
});

test("nothing is counted when the server says not to, or the browser asks not to be", async () => {
  // The server has it turned off, or is one from before there was any counting.
  for (const says of [null, {}, { key: "", host: "https://eu.i.posthog.com", hosted: false }, { key: "phc_test", hosted: false }, { error: "not found" }]) {
    const at = browser({ says });
    await startTelemetry();
    at.go("#/team");
    assert.deepEqual(at.sent, [], JSON.stringify(says));
  }
  // The browser asks not to be: the server is not even asked whether to count.
  for (const asks of [{ doNotTrack: "1" }, { doNotTrack: "yes" }, { globalPrivacyControl: true }]) {
    const at = browser(asks);
    let asked = 0;
    const real = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => (asked++, real(...args))) as typeof fetch;
    await startTelemetry();
    at.go("#/team");
    assert.deepEqual([at.sent, asked], [[], 0], JSON.stringify(asks));
  }
  assert.deepEqual([askedNotTo({}), askedNotTo({ doNotTrack: "0" }), askedNotTo({ doNotTrack: "unspecified" }), askedNotTo({ globalPrivacyControl: false })], [false, false, false, false]);
  // The server cannot be reached: nothing is counted, and nothing is thrown.
  const down = browser({ fails: true });
  await startTelemetry();
  assert.deepEqual(down.sent, []);
});

test("a count that cannot be sent changes nothing for the dashboard", async () => {
  const at = browser();
  const real = globalThis.fetch;
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", note);
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== "/api/v1/telemetry") throw new TypeError("blocked");
    return real(url, init);
  }) as typeof fetch;
  await startTelemetry();
  at.go("#/team");
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off("unhandledRejection", note);
  assert.deepEqual(unhandled, []);
});
