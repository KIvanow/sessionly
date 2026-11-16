import type { Telemetry } from "@sessionly/schema";

/**
 * Where the dashboard counts which of its pages are opened: PostHog's EU
 * cloud. The key is a project's public key, the kind every page that uses
 * PostHog carries; it can send events, not read them.
 */
export const POSTHOG = {
  key: "phc_vVRQ38x7ujfKk9KUYaPeb5jwdken7jwxttsXrT7TCJ9B",
  host: "https://eu.i.posthog.com",
} as const;

const OFF = new Set(["off", "false", "0", "no"]);

/**
 * Whether the dashboard counts its pages, from the environment: on unless
 * `SESSIONLY_TELEMETRY` says off, or `DO_NOT_TRACK` is set (the convention
 * many tools follow, https://consoledonottrack.com).
 */
export function telemetryFrom(env: NodeJS.ProcessEnv): Telemetry | null {
  const said = env.SESSIONLY_TELEMETRY?.trim().toLowerCase();
  if (said && OFF.has(said)) return null;
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt && !OFF.has(dnt)) return null;
  return { ...POSTHOG, hosted: env.SESSIONLY_HOSTED === "true" };
}
