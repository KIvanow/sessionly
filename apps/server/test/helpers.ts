// What the tests share: a fresh database, and tokens in it.
import { createToken, DEFAULT_ORG, type Role } from "../src/auth.ts";
import type { Db } from "../src/db.ts";

export { adminRuns, renameTestDb, testDb, testDbUrl } from "../src/testing.ts";

/** An organisation beside the default one. */
export async function newOrg(db: Db, id: string, name = id): Promise<void> {
  await db.query(`INSERT INTO orgs (id, name) VALUES ($1, $2)`, [id, name]);
}

/** A new token in an organisation: the default one unless another is named. */
export async function tokenFor(
  db: Db,
  owner: { email: string; name?: string | null; role: Role },
  org: string = DEFAULT_ORG,
): Promise<string> {
  return (await tokenWithId(db, owner, org)).token;
}

export function tokenWithId(
  db: Db,
  owner: { email: string; name?: string | null; role: Role },
  org: string = DEFAULT_ORG,
): Promise<{ id: string; token: string }> {
  return db.asOrg(org, (scoped) => createToken(scoped, owner));
}

/**
 * Wait, if a minute of the database's clock is about to end, until the next
 * has begun. Rate limits are counted in windows that start on the clock (a
 * minute, an hour), so a test that counts up to a limit would see the count
 * start again were a window to end partway through it. Call this first in
 * such a test: what follows then has at least `seconds` in one window.
 */
export async function clearOfTheClock(db: Db, seconds = 10): Promise<void> {
  const [{ left }] = await db.query<{ left: number }>(
    `SELECT 60 - (extract(epoch FROM clock_timestamp())::numeric % 60)::float8 AS left`,
  );
  if (Number(left) < seconds) await new Promise((done) => setTimeout(done, Number(left) * 1000 + 50));
}
