// Saying no to too much of something. Counters are kept in the database, so
// they hold across several copies of the server.
import type { Queryable } from "./db.ts";

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
