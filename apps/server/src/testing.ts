// For tests, here and in the packages that build on the server.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { appRoleOf, openDb, roleSetup, type Db } from "./db.ts";

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The Postgres server the tests run on, as its admin if one is named, else as the tests' own user. */
async function onServer<T>(database: string | null, fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? "");
  if (database !== null) url.pathname = `/${encodeURIComponent(database)}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

const userOf = (url: string) => decodeURIComponent(new URL(url).username);
const databaseOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));

/** Every database the tests make is written down, so that the end of the run can drop them. */
function remember(database: string): void {
  const list = process.env.SESSIONLY_TEST_DATABASES;
  if (list) appendFileSync(list, `${JSON.stringify(database)}\n`);
}

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
 *   user and, unless `provision` is false, runs what such a database's admin
 *   has to run once (`roleSetup`).
 *
 * `prefix` begins the database's name, for the tests of odd names.
 */
export async function testDbUrl(options: { provision?: boolean; prefix?: string } = {}): Promise<string> {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) return "memory://";
  const name = `${options.prefix ?? "t_"}${randomBytes(6).toString("hex")}`;
  remember(name);
  const managed = !process.env.TEST_DATABASE_ADMIN_URL;
  await onServer(null, (admin) =>
    admin.query(`CREATE DATABASE ${quoted(name)}${managed ? "" : ` OWNER ${quoted(userOf(server))}`}`),
  );
  if (!managed && options.provision !== false) await adminRuns(name, roleSetup(userOf(server)));
  const url = new URL(server);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

/** Run a statement on the server's database `database`, as the admin if the tests have one. Its rows. */
export async function adminRuns<T = unknown>(database: string, sql: string): Promise<T[]> {
  return onServer(database, async (admin) => (await admin.query(sql)).rows as T[]);
}

/** Give the database at `url` (no one connected to it) another name. Its new address. */
export async function renameTestDb(url: string): Promise<string> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  remember(name);
  await onServer(null, (admin) => admin.query(`ALTER DATABASE ${quoted(databaseOf(url))} RENAME TO ${quoted(name)}`));
  const renamed = new URL(url);
  renamed.pathname = `/${name}`;
  return renamed.toString();
}

/** A fresh database with the migrations run. */
export async function testDb(): Promise<Db> {
  return openDb(await testDbUrl());
}

// For `node --test --test-global-setup`: the databases and roles a run made
// on a Postgres server are dropped when it ends.
let scratch: string | undefined;

export function globalSetup(): void {
  if (!process.env.TEST_DATABASE_URL) return;
  scratch = mkdtempSync(join(tmpdir(), "sessionly-test-run-"));
  process.env.SESSIONLY_TEST_DATABASES = join(scratch, "databases");
}

export async function globalTeardown(): Promise<void> {
  if (!scratch) return;
  let names: string[] = [];
  try {
    const lines = readFileSync(join(scratch, "databases"), "utf8").split("\n");
    names = lines.filter(Boolean).map((line) => JSON.parse(line) as string);
  } catch {
    // no test made a database
  }
  rmSync(scratch, { recursive: true, force: true });
  await onServer(null, async (admin) => {
    // Every database first: a role cannot go while one still grants it something.
    const drops = [
      ...names.map((name) => `DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`),
      ...names.map((name) => `DROP ROLE IF EXISTS ${quoted(appRoleOf(name))}`),
    ];
    for (const drop of drops) {
      await admin.query(drop).catch((err: Error) => console.error(`${drop}: ${err.message}`));
    }
  });
}
