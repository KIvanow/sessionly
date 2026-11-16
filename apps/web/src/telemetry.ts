// Counting which pages of the dashboard are opened, with PostHog, if the
// server says to. A count is written out here in full (`countOf`): the
// page's name, whether the server is hosted or a team's own, and an id made
// up for this one load of the page. Nothing else is in it, and nothing is
// read from the browser to put in it.
//
// It is sent by this code and no library, in a way that leaves the browser
// nothing to add of its own (see `send`): no address of the page it is sent
// from, neither `Referer` nor `Origin`, which would name a team's own
// server, and no cookie. Nothing is kept in the browser, so there is no id
// that lasts.
import type { Telemetry } from "@sessionly/schema";

/** The pages there are, by the first part of the address after `#/`. */
const PAGES = new Set(["", "sessions", "session", "team", "connect", "pulls"]);

/** A page's name from the address's `#` part: one of PAGES, or "other". Ids and the rest are left out. */
export function pageOf(hash: string): string {
  const first = hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  if (!PAGES.has(first)) return "other";
  return first || "overview";
}

/** What PostHog is told the page is, in place of where it really is: its lists of pages go by an address. */
const PLACE = "https://dashboard.sessionly.invalid";

/** A count, as PostHog takes one: this, and all of this, is what is sent. */
export function countOf(telemetry: Telemetry, visit: string, page: string) {
  return {
    api_key: telemetry.key,
    event: "$pageview",
    distinct_id: visit,
    properties: {
      $current_url: `${PLACE}/${page}`,
      $pathname: `/${page}`,
      deployment: telemetry.hosted ? "hosted" : "self-hosted",
      // Counted as nobody's: no profile of a person is made or added to.
      $process_person_profile: false,
      // And not looked up on a map by the address it arrives from.
      $geoip_disable: true,
    },
  };
}

/**
 * Sends a count: as a GET, with the count in its address, made "no-cors"
 * with no referrer and no credentials. A browser adds neither `Origin` nor
 * `Referer` nor a cookie to such a request, whatever page it is made from,
 * so nothing it sends says where the dashboard runs.
 *
 * Not as a POST, which is the usual way. By the Fetch standard a POST made
 * like this would carry `Origin: null`, and Firefox sends that; Chromium
 * sends the page's real origin with every POST to another site. A GET has
 * no `Origin` header in either. The answer cannot be read, and is not needed.
 */
export function send(host: string, count: unknown, get: typeof fetch = fetch): Promise<unknown> {
  const to = new URL("/i/v0/e/", host);
  to.searchParams.set("data", JSON.stringify(count));
  return get(to, { method: "GET", mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
}

/** Whether the browser asks not to be counted: Do Not Track, or Global Privacy Control. */
export function askedNotTo(browser: { doNotTrack?: string | null; globalPrivacyControl?: boolean }): boolean {
  return browser.doNotTrack === "1" || browser.doNotTrack === "yes" || browser.globalPrivacyControl === true;
}

/** An id for this one load of the page, from nothing but chance. */
function madeUp(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Asks the server whether to count, and from then on counts each page as it
 * is opened. Anything that goes wrong here leaves the dashboard as it is.
 */
export async function startTelemetry(): Promise<void> {
  try {
    if (askedNotTo(navigator)) return;
    const response = await fetch("/api/v1/telemetry", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const telemetry = (await response.json()) as Telemetry | null;
    if (!telemetry?.key || !telemetry.host) return;
    const visit = madeUp();
    let page: string | undefined;
    const count = () => {
      const now = pageOf(window.location.hash);
      if (now === page) return;
      page = now;
      send(telemetry.host, countOf(telemetry, visit, now)).catch(() => {});
    };
    count();
    window.addEventListener("hashchange", count);
  } catch {
    // no counting, and nothing else changes
  }
}
