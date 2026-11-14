// What the tests share: a fresh database, and tokens in it.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createToken, DEFAULT_ORG, type Role } from "../src/auth.ts";
import { openDb, type Db } from "../src/db.ts";

/**
 * A fresh database with the migrations run. In memory by default. With
 * TEST_DATABASE_URL set to a Postgres server (connected as a role that may
 * create databases and roles, like the one a managed service gives), a new
 * database on that server instead, so the same tests run on the real thing.
 */
export async function testDb(): Promise<Db> {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) return openDb("memory://");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  return openDb(url.toString());
}

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
