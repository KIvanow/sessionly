// For tests, here and in the packages that build on the server.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDb, type Db } from "./db.ts";

/**
 * The address of a fresh, empty database. In memory by default. With
 * TEST_DATABASE_URL set to a Postgres server (connected as a role that may
 * create databases and roles, like the one a managed service gives), a new
 * database on that server instead, so the same tests run on the real thing.
 */
export async function testDbUrl(): Promise<string> {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) return "memory://";
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
  return url.toString();
}

/** A fresh database with the migrations run. */
export async function testDb(): Promise<Db> {
  return openDb(await testDbUrl());
}
