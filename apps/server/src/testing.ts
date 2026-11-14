// For tests, here and in the packages that build on the server.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDb, type Db } from "./db.ts";

/**
 * The address of a fresh, empty database. In memory by default.
 *
 * With TEST_DATABASE_URL set to a Postgres server, a new database on that
 * server instead, so the same tests run on the real thing. Two kinds of user
 * are tried that way:
 *
 * - One that may create databases and roles: it sets everything up itself.
 * - One that may not, like the user a managed database's panel creates. Then
 *   TEST_DATABASE_ADMIN_URL names an admin, who makes the database for that
 *   user and, unless `provision` is false, the role its requests run as:
 *   the one-time step such a database needs.
 */
export async function testDbUrl(options: { provision?: boolean } = {}): Promise<string> {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) return "memory://";
  const name = `t_${randomBytes(6).toString("hex")}`;
  const url = new URL(server);
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const admin = new pg.Client({ connectionString: adminUrl ?? server });
  await admin.connect();
  try {
    if (adminUrl) {
      const user = `"${decodeURIComponent(url.username).replace(/"/g, '""')}"`;
      await admin.query(`CREATE DATABASE ${name} OWNER ${user}`);
      if (options.provision !== false) {
        await admin.query(`CREATE ROLE "sessionly_app_${name}" NOLOGIN`);
        await admin.query(`GRANT "sessionly_app_${name}" TO ${user}`);
      }
    } else {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/** A fresh database with the migrations run. */
export async function testDb(): Promise<Db> {
  return openDb(await testDbUrl());
}
