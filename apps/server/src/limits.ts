// Saying no to too much of something. Counters are kept in the database, so
// they hold across several copies of the server.
import { isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import type { Queryable } from "./db.ts";

/** People an organisation has added in the current hour. */
export function invitesKey(orgId: string): string {
  return `invites:${orgId}`;
}

/** The last export an organisation was allowed to take. */
export function exportKey(orgId: string): string {
  return `export:${orgId}`;
}

/** Every rate counter that names an organisation. A purge deletes these with it. */
export function orgRateKeys(orgId: string): string[] {
  return [invitesKey(orgId), exportKey(orgId)];
}

/** The start of the window of `$2` seconds that now is in. */
const WINDOW = `to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int)`;

/** One that was taken: from which counter, in which window. */
export interface Taken {
  key: string;
  window: string;
}

/**
 * Take one of the `max` that `key` has in the current window of `seconds`,
 * if one is left: null if none is. What is refused is not counted, so the
 * count is of what was let through.
 */
export async function take(db: Queryable, key: string, seconds: number, max: number): Promise<Taken | null> {
  if (max < 1) return null;
  const [taken] = await db.query<{ at: string }>(
    `INSERT INTO rate_counters (key, window_start, n) VALUES ($1, ${WINDOW}, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET n = rate_counters.n + 1 WHERE rate_counters.n < $3
     RETURNING window_start::text AS at`,
    [key, seconds, max],
  );
  return taken ? { key, window: taken.at } : null;
}

/** `take`, for what is never given back. */
export async function allowed(db: Queryable, key: string, seconds: number, max: number): Promise<boolean> {
  return (await take(db, key, seconds, max)) !== null;
}

/**
 * Let `key` through once every `seconds`, counted from the last time it was
 * let through. A window that starts on the clock would let two through, one
 * at each end of it. Call this inside a transaction: the wait and the record
 * are one lock, so two at once cannot both pass. Exactly `seconds` since the
 * last one is enough. What is refused is not recorded, and an older record of
 * the same key is replaced by this one.
 */
export async function onceEvery(db: Queryable, key: string, seconds: number): Promise<boolean> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rate:${key}`]);
  const [recent] = await db.query<{ recent: boolean }>(
    `SELECT true AS recent FROM rate_counters
     WHERE key = $1 AND window_start > clock_timestamp() - make_interval(secs => $2::int)
     LIMIT 1`,
    [key, seconds],
  );
  if (recent) return false;
  await db.query(`DELETE FROM rate_counters WHERE key = $1`, [key]);
  await db.query(`INSERT INTO rate_counters (key, window_start, n) VALUES ($1, clock_timestamp(), 1)`, [key]);
  return true;
}

/**
 * Give back one that was taken for something that then did not happen: a
 * message that was not sent after all is not one of the messages counted.
 * It goes back to the window it came from. By the time a message has
 * failed, the hour it was counted in may be over, and the next hour's count
 * is of other messages.
 */
export async function giveBack(db: Queryable, taken: Taken): Promise<void> {
  await db.query(`UPDATE rate_counters SET n = n - 1 WHERE key = $1 AND window_start = $2::timestamptz AND n > 0`, [
    taken.key,
    taken.window,
  ]);
}

/** Forget windows that have passed, and sign-ins that were not finished in time. */
export async function tidy(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '2 hours'`);
  await db.query(`DELETE FROM sign_in_codes WHERE expires_at < now()`);
  await db.query(`DELETE FROM sign_in_states WHERE expires_at < now()`);
}

/** The groups of an IPv6 address, written out; null for anything else. */
function groupsOf(address: string): string[] | null {
  if (!isIPv6(address)) return null;
  const [head = "", tail] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
}

/** An address as it is compared: no brackets or zone, and an IPv4 address written as IPv6 as IPv4. */
function plainAddress(address: string): string {
  const plain = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)?.[1];
  return mapped && isIPv4(mapped) ? mapped : plain;
}

/**
 * What to count an address under. One IPv4 address is one caller. An IPv6
 * caller usually has a whole /64 to pick addresses from, so its network is
 * what is counted.
 */
export function network(address: string): string {
  const plain = plainAddress(address);
  const groups = groupsOf(plain);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : plain;
}

/**
 * The wider network an address is in, for what is counted by the hour: a /24
 * of IPv4, and the /48 a site is usually given of IPv6.
 */
export function widerNetwork(address: string): string {
  const plain = plainAddress(address);
  const groups = groupsOf(plain);
  if (groups) return `${groups.slice(0, 3).join(":")}::/48`;
  return isIPv4(plain) ? `${plain.split(".").slice(0, 3).join(".")}.0/24` : plain;
}

/** Who is asking, as far as it can be told: for counting, not for trusting. */
export function callerOf(c: Context, trustProxy: boolean | undefined): string {
  if (trustProxy) {
    // The last hop is the one the proxy added itself.
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim());
    const last = hops.filter(Boolean).at(-1);
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
