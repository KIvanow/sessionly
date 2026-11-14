// Saying no to too much of something. Counters are kept in the database, so
// they hold across several copies of the server.
import type { Queryable } from "./db.ts";

/**
 * Count one more of `key` in the current window of `seconds`, and say
 * whether that is still within `max`.
 */
export async function allowed(db: Queryable, key: string, seconds: number, max: number): Promise<boolean> {
  const [row] = await db.query<{ n: number }>(
    `INSERT INTO rate_counters (key, window_start, n)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET n = rate_counters.n + 1
     RETURNING n`,
    [key, seconds],
  );
  return Number(row?.n ?? 1) <= max;
}

/** Forget windows that have passed, and links that have run out. */
export async function tidy(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '2 hours'`);
  await db.query(`DELETE FROM login_codes WHERE expires_at < now()`);
}
