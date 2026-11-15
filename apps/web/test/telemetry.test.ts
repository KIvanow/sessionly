import assert from "node:assert/strict";
import { test } from "node:test";
import { pageOf, scrub } from "../src/telemetry.ts";

test("a page is counted by its name, never by what is in its address", () => {
  assert.equal(pageOf(""), "overview");
  assert.equal(pageOf("#/"), "overview");
  assert.equal(pageOf("#/sessions"), "sessions");
  assert.equal(pageOf("#/sessions?user=ann@example.com"), "sessions");
  assert.equal(pageOf("#/session/acme/ann@example.com/0193-abcd"), "session");
  assert.equal(pageOf("#/team"), "team");
  assert.equal(pageOf("#signed-in"), "other");
  assert.equal(pageOf("#/ann@example.com"), "other");
});

test("an event says nothing of where the dashboard runs or where someone came from", () => {
  const kept = scrub(
    {
      $current_url: "https://sessionly.internal.acme.com/#/session/acme/ann@acme.com/1",
      $host: "sessionly.internal.acme.com",
      $pathname: "/",
      $referrer: "https://wiki.acme.com/page",
      $referring_domain: "wiki.acme.com",
      $initial_referrer: "https://wiki.acme.com/page",
      $session_entry_url: "https://sessionly.internal.acme.com/",
      utm_source: "newsletter",
      $initial_utm_campaign: "launch",
      gclid: "x",
      $browser: "Firefox",
      $screen_width: 1440,
      deployment: "self-hosted",
    },
    "session",
  );
  assert.deepEqual(kept, {
    $current_url: "https://dashboard.sessionly.invalid/session",
    $pathname: "/session",
    $browser: "Firefox",
    $screen_width: 1440,
    deployment: "self-hosted",
  });
  assert.doesNotMatch(JSON.stringify(kept), /acme/);
});
