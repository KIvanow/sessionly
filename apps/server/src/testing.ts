// For tests, here and in the packages that build on the server.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDb, type Db } from "./db.ts";

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
