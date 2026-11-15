// Saying no to too much of something. Counters are kept in the database, so
// they hold across several copies of the server.
import type { Queryable } from "./db.ts";

/** The start of the window of `$2` seconds that now is in. */
const WINDOW = `to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int)`;

/**
 * Take one of the `max` that `key` has in the current window of `seconds`,
 * if one is left. What is refused is not counted, so the count is of what
 * was let through.
 */
export async function allowed(db: Queryable, key: string, seconds: number, max: number): Promise<boolean> {
  if (max < 1) return false;
  const taken = await db.query(
    `INSERT INTO rate_counters (key, window_start, n) VALUES ($1, ${WINDOW}, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET n = rate_counters.n + 1 WHERE rate_counters.n < $3
     RETURNING n`,
    [key, seconds, max],
  );
  return taken.length > 0;
}

/**
 * Give back one that was taken for something that then did not happen: a
 * message that was not sent after all is not one of the messages counted.
 */
export async function giveBack(db: Queryable, key: string, seconds: number): Promise<void> {
  await db.query(`UPDATE rate_counters SET n = n - 1 WHERE key = $1 AND window_start = ${WINDOW} AND n > 0`, [key, seconds]);
}

/** Forget windows that have passed, and links that have run out. */
export async function tidy(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '2 hours'`);
  await db.query(`DELETE FROM login_codes WHERE expires_at < now()`);
}
