// One organisation's data, as JSON lines, a page at a time. The caller opens
// a fresh transaction for each page: the embedded database has one
// connection, and holding it for a whole organisation would stop every
// other request.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrgDb } from "./db.ts";

/** How many rows one transaction reads. Full session payloads are the large ones. */
const PAGE = 50;

/** The server's own version, from its package, for the first line of an export. */
export function serverVersion(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
  return pkg.version ?? "";
}

function dated(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function line(type: string, row: Record<string, unknown>): Record<string, unknown> {
  return { type, ...dated(row) };
}

/** The organisation itself: first, and the only line that is not a page. */
export async function orgLine(db: OrgDb, version: string, exportedAt: string): Promise<Record<string, unknown>> {
  const [org] = await db.query<Record<string, unknown>>(`SELECT id, name, created_at FROM orgs WHERE id = $1`, [db.orgId]);
  if (!org) throw new Error("the organisation is not there");
  return line("org", { ...org, exported_at: exportedAt, version });
}

// People, without the account ids a provider uses. Those stay on the server.
const USERS = `id, email, role, created_at, invited_at, removed_at, confirmed_at, invited_by, invited_via`;
// Tokens, without the hash. The secret was never stored; the hash must not leave either.
const TOKENS = `id, email, name, role, created_at, last_used_at, revoked_at, expires_at`;

async function page(
  db: OrgDb,
  table: string,
  columns: string,
  order: string,
  afterSql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  return db.query(
    `SELECT ${columns} FROM ${table} WHERE org_id = $1 AND (${afterSql}) ORDER BY ${order} LIMIT ${PAGE}`,
    params,
  );
}

export function userPage(db: OrgDb, after: string | null): Promise<Record<string, unknown>[]> {
  return page(db, "users", USERS, "id", "$2::text IS NULL OR id > $2", [db.orgId, after]);
}

export function tokenPage(db: OrgDb, after: string | null): Promise<Record<string, unknown>[]> {
  return page(db, "tokens", TOKENS, "id", "$2::text IS NULL OR id > $2", [db.orgId, after]);
}

export interface SessionKey {
  machine_id: string;
  source: string;
  session_id: string;
}

export function sessionPage(db: OrgDb, after: SessionKey | null): Promise<Record<string, unknown>[]> {
  return page(
    db,
    "sessions",
    "*",
    "machine_id, source, session_id",
    "$2::text IS NULL OR (machine_id, source, session_id) > ($2, $3, $4)",
    [db.orgId, after?.machine_id ?? null, after?.source ?? null, after?.session_id ?? null],
  );
}

export interface PullKey {
  repo: string;
  number: number;
}

export function pullPage(db: OrgDb, after: PullKey | null): Promise<Record<string, unknown>[]> {
  return page(
    db,
    "pull_requests",
    "*",
    "repo, number",
    "$2::text IS NULL OR (repo, number) > ($2, $3::integer)",
    [db.orgId, after?.repo ?? null, after?.number ?? null],
  );
}

export interface ExclusionKey {
  owner_email: string;
  repo: string;
}

export function exclusionPage(db: OrgDb, after: ExclusionKey | null): Promise<Record<string, unknown>[]> {
  return page(
    db,
    "repo_exclusions",
    "org_id, owner_email, repo, created_at",
    "owner_email, repo",
    "$2::text IS NULL OR (owner_email, repo) > ($2, $3)",
    [db.orgId, after?.owner_email ?? null, after?.repo ?? null],
  );
}

async function pages<C>(
  write: (row: Record<string, unknown>) => void,
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  type: string,
  load: (db: OrgDb, after: C | null) => Promise<Record<string, unknown>[]>,
  cursorOf: (row: Record<string, unknown>) => C,
): Promise<void> {
  let after: C | null = null;
  for (;;) {
    const rows = await each((db) => load(db, after));
    for (const row of rows) write(line(type, row));
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) return;
    const next = cursorOf(last);
    // A cursor that does not move would read the same page forever.
    if (JSON.stringify(next) === JSON.stringify(after)) return;
    after = next;
  }
}

/**
 * Write every line of the export. `each` runs one page in its own
 * transaction and must not keep it afterwards.
 */
export async function writeExport(
  write: (row: Record<string, unknown>) => void,
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  exportedAt: string,
): Promise<void> {
  const version = serverVersion();
  await each(async (db) => {
    write(await orgLine(db, version, exportedAt));
  });
  await pages(write, each, "user", userPage, (row) => String(row.id));
  await pages(write, each, "session", sessionPage, (row) => ({
    machine_id: String(row.machine_id),
    source: String(row.source),
    session_id: String(row.session_id),
  }));
  await pages(write, each, "pull_request", pullPage, (row) => ({
    repo: String(row.repo),
    number: Number(row.number),
  }));
  await pages(write, each, "repo_exclusion", exclusionPage, (row) => ({
    owner_email: String(row.owner_email),
    repo: String(row.repo),
  }));
  await pages(write, each, "token", tokenPage, (row) => String(row.id));
}
