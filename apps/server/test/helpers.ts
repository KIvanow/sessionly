// What the tests share: a fresh database, and tokens in it.
import { createToken, DEFAULT_ORG, type Role } from "../src/auth.ts";
import type { Db } from "../src/db.ts";

export { testDb, testDbUrl } from "../src/testing.ts";

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
