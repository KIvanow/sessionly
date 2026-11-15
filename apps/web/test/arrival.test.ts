// Coming back from Google or GitHub: what the dashboard reads from the
// address, what it asks the server, and when it goes in without asking.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Arrival, Membership, SignedIn } from "@sessionly/schema";
import { arrive, doors, landingOf, problemText, signedInHere, straightIn } from "../src/arrival.ts";

// What a browser keeps, for the tests to fill: nothing at the start of each.
const kept = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  },
});
beforeEach(() => kept.clear());
/** A browser signed in with a token it is using, with a session it has kept, or with neither. */
const browser = (how: "token" | "session" | "nothing") => {
  kept.clear();
  if (how === "token") kept.set("sessionly.token", "sl_in_use");
  if (how === "session") kept.set("sessionly.sessions", JSON.stringify([{ org: "other-1", name: "Other", token: "sl_kept" }]));
};

const place = (over: Partial<Membership> = {}): Membership => ({
  user_id: "usr_1",
  org_id: "acme-x7k2p9",
  org_name: "Acme",
  email: "ann@acme.example",
  first_time: false,
  invited_by: null,
  invited_via: null,
  other_account: null,
  ...over,
});
const arrival = (orgs: Membership[], over: Partial<Arrival> = {}): Arrival => ({
  provider: "google",
  emails: ["ann@acme.example"],
  create: false,
  orgs,
  more: 0,
  ...over,
});
const signed: SignedIn = {
  token: "sl_session",
  org: { id: "acme-x7k2p9", name: "Acme" },
  email: "ann@acme.example",
  role: "admin",
  expires_at: "2026-12-01T00:00:00.000Z",
  created: false,
};

test("the address says that someone is back, and nothing of who", () => {
  assert.deepEqual(landingOf("#signed-in"), { arrived: true });
  assert.deepEqual(landingOf("#problem=refused"), { arrived: false, problem: problemText("refused") });
  // The pages of the dashboard, and anything else, are not a landing.
  for (const hash of ["", "#", "#/", "#/sessions", "#/connect", "#signed-in=abc", "#signed-in/x", "#problem=", "#problem=a b", "#problem"]) {
    assert.equal(landingOf(hash), null, hash);
  }
  // What an older server sent people back with carried the sign-in in the
  // address. It is not read: a link like it does nothing here.
  for (const hash of ["#login=Zm9vYmFy", "#create=Zm9vYmFy", "#login=", "#code=abc"]) assert.equal(landingOf(hash), null, hash);
});

test("every problem has words, whatever word the address carries", () => {
  for (const word of ["refused", "not_started", "provider", "setup", "no_address", "busy"]) {
    assert.ok(problemText(word).length > 20, word);
  }
  assert.notEqual(problemText("setup"), problemText("provider"));
  assert.match(problemText("setup"), /not set up right/);
  // A word this page does not know, the names every object has among them:
  // said as the service not answering, and never something that is not text.
  for (const word of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "nonsense"]) {
    assert.equal(problemText(word), problemText("provider"), word);
    assert.deepEqual(landingOf(`#problem=${word}`), { arrived: false, problem: problemText("provider") });
  }
  assert.equal(typeof problemText("__proto__"), "string");
});

test("straight in only to the one organisation someone has signed in to before, and never when signed in already", () => {
  assert.equal(straightIn(arrival([place()]), false), "usr_1");
  // Signed in somewhere in this browser: whoever is at it is asked, always.
  assert.equal(straightIn(arrival([place()]), true), null);
  // Nowhere, two places, a place not signed in to before, one kept for
  // another account, more that are not listed, or come to create one.
  assert.equal(straightIn(arrival([]), false), null);
  assert.equal(straightIn(arrival([place(), place({ user_id: "usr_2", org_id: "other-1" })]), false), null);
  assert.equal(straightIn(arrival([place({ first_time: true, invited_via: "sign_in", invited_by: "eve@attack.example" })]), false), null);
  assert.equal(straightIn(arrival([place({ other_account: "github" })]), false), null);
  assert.equal(straightIn(arrival([place()], { more: 3 }), false), null);
  assert.equal(straightIn(arrival([place()], { create: true }), false), null);
});

test("a browser is signed in if it has a token in use or a session it kept", () => {
  browser("nothing");
  assert.equal(signedInHere(), false);
  browser("token");
  assert.equal(signedInHere(), true);
  browser("session");
  assert.equal(signedInHere(), true);
  // A list of sessions that is empty, or is not a list, is no session.
  kept.clear();
  kept.set("sessionly.sessions", "[]");
  assert.equal(signedInHere(), false);
  kept.set("sessionly.sessions", "not json");
  assert.equal(signedInHere(), false);
});

test("arriving: asked first, then in or shown what there is", async () => {
  const calls: string[] = [];
  const at = (found: Arrival | Error, entered: SignedIn | Error = signed) => ({
    check: async () => {
      calls.push("check");
      if (found instanceof Error) throw found;
      return found;
    },
    enter: async (where: object) => {
      calls.push(`enter ${JSON.stringify(where)}`);
      if (entered instanceof Error) throw entered;
      return entered;
    },
  });
  const back = { arrived: true } as const;
  // One organisation, known, and nobody signed in here: in, with nothing asked.
  browser("nothing");
  assert.deepEqual(await arrive(back, at(arrival([place()]))), { kind: "entered", signed });
  assert.deepEqual(calls.splice(0), ["check", 'enter {"user_id":"usr_1"}']);
  // The same with someone signed in here already, as when a link to this
  // page is opened in a browser that is in use: shown, asked, and nothing
  // used. Whether they are is what the browser has kept, and the page that
  // calls this has no say in it.
  const shown = arrival([place()]);
  for (const how of ["token", "session"] as const) {
    browser(how);
    assert.deepEqual(await arrive(back, at(shown)), { kind: "ask", arrival: shown }, how);
    assert.deepEqual(calls.splice(0), ["check"], how);
  }
  // Added somewhere by someone else: asked, signed in here or not.
  const added = arrival([place({ first_time: true, invited_via: "sign_in", invited_by: "eve@attack.example" })]);
  for (const how of ["nothing", "token"] as const) {
    browser(how);
    assert.deepEqual(await arrive(back, at(added)), { kind: "ask", arrival: added });
  }
  assert.deepEqual(calls.splice(0), ["check", "check"]);
  // No sign-in of this browser's is waiting (the link was someone else's,
  // or it ran out). Someone signed in is told nothing and stays where they
  // are; someone who is not is told why.
  const none = new Error("that sign-in has run out or was used already; sign in again");
  browser("token");
  assert.deepEqual(await arrive(back, at(none)), { kind: "nothing" });
  browser("nothing");
  assert.deepEqual(await arrive(back, at(none)), { kind: "problem", text: none.message });
  assert.deepEqual(calls.splice(0), ["check", "check"]);
  // Going in can still be refused.
  assert.deepEqual(await arrive(back, at(arrival([place()]), new Error("too many requests; try again in a minute"))), {
    kind: "problem",
    text: "too many requests; try again in a minute",
  });
  calls.length = 0;
  // A problem the server sent them back with is said, and the server is asked nothing.
  assert.deepEqual(await arrive({ arrived: false, problem: "why" }, at(arrival([place()]))), { kind: "problem", text: "why" });
  assert.deepEqual(calls, []);
});

const fetching = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetching;
});

test("what the server is asked carries no sign-in: that is in the browser's cookie", async () => {
  const sent: { url: string; method?: string; body: unknown; credentials?: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method, body: JSON.parse(String(init.body)), credentials: init.credentials });
    return new Response(JSON.stringify(url.endsWith("/check") ? arrival([place()]) : url.endsWith("/verify") ? signed : { ok: true }));
  }) as typeof fetch;
  assert.deepEqual(await arrive({ arrived: true }), { kind: "entered", signed });
  await doors.check(10);
  await doors.enter({ org_name: "Acme", invite_code: "welcome" });
  await doors.cancel();
  assert.deepEqual(sent, [
    { url: "/api/v1/auth/check", method: "POST", body: { shown: 0 }, credentials: "same-origin" },
    { url: "/api/v1/auth/verify", method: "POST", body: { user_id: "usr_1" }, credentials: "same-origin" },
    { url: "/api/v1/auth/check", method: "POST", body: { shown: 10 }, credentials: "same-origin" },
    { url: "/api/v1/auth/verify", method: "POST", body: { org_name: "Acme", invite_code: "welcome" }, credentials: "same-origin" },
    { url: "/api/v1/auth/cancel", method: "POST", body: {}, credentials: "same-origin" },
  ]);
  // The server's refusal is what is said.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "that sign-in has run out or was used already; sign in again", code: "invalid_code" }), { status: 400 })) as typeof fetch;
  assert.deepEqual(await arrive({ arrived: true }), {
    kind: "problem",
    text: "that sign-in has run out or was used already; sign in again",
  });
  browser("session");
  assert.deepEqual(await arrive({ arrived: true }), { kind: "nothing" });
});
