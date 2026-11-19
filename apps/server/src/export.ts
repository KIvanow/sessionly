// One organisation's data, as JSON lines, a page at a time. The caller opens
// a fresh transaction for each page: the embedded database has one
// connection, and holding it for a whole organisation would stop every
// other request.
//
// What leaves is the catalogue below. A table that belongs to an organisation
// is either in it or named in `OMITTED_FROM_EXPORT`. A test fails when a new
// one is neither.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrgDb } from "./db.ts";

/** How many rows one transaction reads. Full session payloads are the large ones. */
const PAGE = 50;

/** The server's own version, from its package, for the first line of an export. */
function serverVersion(): string {
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

// People, without the account ids a provider uses. Those stay on the server.
const USERS = `id, email, role, created_at, invited_at, removed_at, confirmed_at, invited_by, invited_via`;
// Tokens, without the hash. The secret was never stored; the hash must not leave either.
const TOKENS = `id, email, name, role, created_at, last_used_at, revoked_at, expires_at`;

/**
 * One table an export walks, in `order`, a page at a time. `columns` is what
 * is written: `*` is the whole row, and a list is how a secret is left out.
 * `afterSql` is true for rows after the cursor. `$1` is the organisation.
 * The cursor values follow it, and are null on the first page.
 */
interface TableExport {
  type: string;
  table: string;
  columns: string;
  order: string;
  afterSql: string;
  /** The cursor `afterSql` reads, null for each value on the first page. */
  blank: null[];
  cursorOf: (row: Record<string, unknown>) => unknown[];
}

const text = (value: unknown) => String(value);

/**
 * Every table an export copies, in the order its lines are written. The
 * organisation itself is the line before these, and is not one of them.
 */
const EXPORTED: TableExport[] = [
  {
    type: "user",
    table: "users",
    columns: USERS,
    order: "id",
    afterSql: "$2::text IS NULL OR id > $2",
    blank: [null],
    cursorOf: (row) => [text(row.id)],
  },
  {
    type: "session",
    table: "sessions",
    columns: "*",
    order: "machine_id, source, session_id",
    afterSql: "$2::text IS NULL OR (machine_id, source, session_id) > ($2, $3, $4)",
    blank: [null, null, null],
    cursorOf: (row) => [text(row.machine_id), text(row.source), text(row.session_id)],
  },
  {
    type: "pull_request",
    table: "pull_requests",
    columns: "*",
    order: "repo, number",
    afterSql: "$2::text IS NULL OR (repo, number) > ($2, $3::integer)",
    blank: [null, null],
    cursorOf: (row) => [text(row.repo), Number(row.number)],
  },
  {
    // Which of a session's lines a pull request kept, and how many they count as.
    type: "pull_session",
    table: "pull_sessions",
    columns: "*",
    order: "repo, number, machine_id, source, session_id",
    afterSql:
      "$2::text IS NULL OR (repo, number, machine_id, source, session_id) > ($2, $3::integer, $4, $5, $6)",
    blank: [null, null, null, null, null],
    cursorOf: (row) => [
      text(row.repo),
      Number(row.number),
      text(row.machine_id),
      text(row.source),
      text(row.session_id),
    ],
  },
  {
    // The figures a pull request had each time they moved.
    type: "pull_request_report",
    table: "pull_request_reports",
    columns: "*",
    order: "id",
    afterSql: "$2::bigint IS NULL OR id > $2::bigint",
    blank: [null],
    cursorOf: (row) => [text(row.id)],
  },
  {
    type: "repo_exclusion",
    table: "repo_exclusions",
    columns: "org_id, owner_email, repo, created_at",
    order: "owner_email, repo",
    afterSql: "$2::text IS NULL OR (owner_email, repo) > ($2, $3)",
    blank: [null, null],
    cursorOf: (row) => [text(row.owner_email), text(row.repo)],
  },
  {
    type: "token",
    table: "tokens",
    columns: TOKENS,
    order: "id",
    afterSql: "$2::text IS NULL OR id > $2",
    blank: [null],
    cursorOf: (row) => [text(row.id)],
  },
];

/** The tables `EXPORTED` copies. */
export const EXPORTED_TABLES: readonly string[] = EXPORTED.map((spec) => spec.table);

/**
 * Tables that belong to an organisation and are not a copy of its data.
 * `repos_allowed_again` is a counter a machine compares with the one it saw.
 * `shown_sessions` is the server's own note of which sessions it copied into
 * an organisation a repository is shown in, and when: the sessions are exported.
 */
export const OMITTED_FROM_EXPORT: readonly string[] = ["repos_allowed_again", "shown_sessions"];

async function* tableLines(
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  spec: TableExport,
): AsyncGenerator<Record<string, unknown>> {
  let after: unknown[] | null = null;
  for (;;) {
    const cursor = after ?? spec.blank;
    const rows = await each((db) =>
      db.query<Record<string, unknown>>(
        `SELECT ${spec.columns} FROM ${spec.table} WHERE org_id = $1 AND (${spec.afterSql}) ORDER BY ${spec.order} LIMIT ${PAGE}`,
        [db.orgId, ...cursor],
      ),
    );
    for (const row of rows) yield line(spec.type, row);
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) return;
    const next = spec.cursorOf(last);
    if (next.length !== spec.blank.length) throw new Error(`${spec.table}: the cursor does not match the page`);
    // A cursor that does not move would read the same page forever.
    if (JSON.stringify(next) === JSON.stringify(after)) return;
    after = next;
  }
}

/** The organisation itself: first, and the only line that is not a page of a table. */
async function orgLine(db: OrgDb, version: string, exportedAt: string): Promise<Record<string, unknown>> {
  const [org] = await db.query<Record<string, unknown>>(`SELECT id, name, created_at FROM orgs WHERE id = $1`, [db.orgId]);
  if (!org) throw new Error("the organisation is not there");
  return line("org", { ...org, exported_at: exportedAt, version });
}

/**
 * Every line of the export, one page at a time. The next page is read only
 * when the caller asks for the line after this one, so a slow reader does
 * not queue the rest of the organisation. `each` runs one page in its own
 * transaction and must not keep it afterwards.
 */
export async function* exportLines(
  each: <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>,
  exportedAt: string,
): AsyncGenerator<Record<string, unknown>> {
  const version = serverVersion();
  yield await each(async (db) => orgLine(db, version, exportedAt));
  for (const spec of EXPORTED) yield* tableLines(each, spec);
}
