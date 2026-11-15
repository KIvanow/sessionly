// Counting which pages of the dashboard are opened, with PostHog, if the
// server says to. What is sent is the page's name and what PostHog knows of
// the browser (its kind, the screen's size): never the address it was opened
// at, an organisation, a person, a session or anything a page shows. Nothing
// is kept in the browser, so there is no cookie and no id that lasts.
import type { Telemetry } from "@sessionly/schema";

/** The pages there are, by the first part of the address after `#/`. */
const PAGES = new Set(["", "sessions", "session", "team", "connect", "pulls"]);

/** A page's name from the address's `#` part: one of PAGES, or "other". Ids and the rest are left out. */
export function pageOf(hash: string): string {
  const first = hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  if (!PAGES.has(first)) return "other";
  return first || "overview";
}

/** What the dashboard tells PostHog the page is, in place of where it really is. */
const PLACE = "https://dashboard.sessionly.invalid";

/** Properties that would say where the dashboard runs or where someone came from. */
const WHERE = [
  "$host",
  "$referrer",
  "$referring_domain",
  "$initial_referrer",
  "$initial_referring_domain",
  "$initial_current_url",
  "$initial_host",
  "$initial_pathname",
  "$session_entry_url",
  "$session_entry_host",
  "$session_entry_pathname",
  "$session_entry_referrer",
  "$session_entry_referring_domain",
  "$prev_pageview_pathname",
];

/** An event's properties with the address replaced by the page's name, and where it came from left out. */
export function scrub(properties: Record<string, unknown>, page: string): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    // Campaign parameters (`utm_…`, `gclid`…) come from the address too.
    if (WHERE.includes(name) || /^\$?(initial_)?(utm_|gclid|fbclid|msclkid)/.test(name)) continue;
    kept[name] = value;
  }
  kept.$current_url = `${PLACE}/${page}`;
  kept.$pathname = `/${page}`;
  return kept;
}

/**
 * Asks the server whether to count, and from then on counts each page as it
 * is opened. Anything that goes wrong here leaves the dashboard as it is.
 */
export async function startTelemetry(): Promise<void> {
  try {
    const response = await fetch("/api/v1/telemetry", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const telemetry = (await response.json()) as Telemetry | null;
    if (!telemetry?.key) return;
    // The build without its own loader: nothing is ever fetched from PostHog's servers to run here.
    const { posthog } = await import("posthog-js/dist/module.slim.no-external");
    let page = pageOf(window.location.hash);
    posthog.init(telemetry.key, {
      api_host: telemetry.host,
      persistence: "memory",
      person_profiles: "never",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: false,
      rageclick: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      save_referrer: false,
      respect_dnt: true,
      ip: false,
      before_send: (event) => (event ? { ...event, properties: scrub(event.properties, page) } : null),
    });
    posthog.register({ deployment: telemetry.hosted ? "hosted" : "self-hosted" });
    const count = () => {
      page = pageOf(window.location.hash);
      posthog.capture("$pageview");
    };
    count();
    window.addEventListener("hashchange", () => {
      if (pageOf(window.location.hash) !== page) count();
    });
  } catch {
    // no counting, and nothing else changes
  }
}
