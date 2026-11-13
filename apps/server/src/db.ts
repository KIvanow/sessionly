// Database access. The server speaks Postgres. Without a DATABASE_URL it runs
// on PGlite (Postgres compiled to WebAssembly, stored in a local folder), so a
// single process is enough to try it or to self-host for a small team.
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * `postgres://…` connects to a Postgres server. `memory://` is an in-memory
 * database for tests. Anything else is a folder for an embedded database.
 */
export async function openDb(url: string): Promise<Db> {
  let db: Db;
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url });
    db = {
      query: async (text, params) => (await pool.query(text, params as unknown[])).rows,
      close: () => pool.end(),
    };
  } else {
    let lite: PGlite;
    if (url === "memory://") {
      lite = new PGlite();
    } else {
      const dir = url.replace(/^file:/, "");
      mkdirSync(dir, { recursive: true });
      lite = new PGlite(dir);
    }
    db = {
      query: async (text, params) => (await lite.query(text, params as unknown[])).rows as never[],
      close: () => lite.close(),
    };
  }
  await runMigrations(db, "migrations", MIGRATIONS);
  return db;
}

// Each entry runs once, in order. Add to the end; never edit an entry that
// has shipped.
const MIGRATIONS: string[] = [
  `CREATE TABLE tokens (
     id           text PRIMARY KEY,
     token_hash   text NOT NULL UNIQUE,
     email        text NOT NULL,
     name         text,
     role         text NOT NULL CHECK (role IN ('admin', 'member')),
     created_at   timestamptz NOT NULL DEFAULT now(),
     last_used_at timestamptz,
     revoked_at   timestamptz
   )`,
  `CREATE TABLE sessions (
     machine_id          text NOT NULL,
     source              text NOT NULL,
     session_id          text NOT NULL,
     -- who uploaded it: the owner of the token, not what the record claims
     owner_email         text NOT NULL,
     user_email          text,
     user_name           text,
     repo                text,
     branch              text,
     title               text,
     started_at          timestamptz,
     ended_at            timestamptz,
     duration_ms         double precision,
     active_ms           double precision NOT NULL DEFAULT 0,
     cost_usd            double precision,
     cost_source         text,
     unpriced_requests   double precision NOT NULL DEFAULT 0,
     primary_model       text,
     models              jsonb NOT NULL DEFAULT '[]',
     input_tokens        double precision NOT NULL DEFAULT 0,
     output_tokens       double precision NOT NULL DEFAULT 0,
     prompts             integer NOT NULL DEFAULT 0,
     tool_calls          integer NOT NULL DEFAULT 0,
     tool_failures       integer NOT NULL DEFAULT 0,
     subagents           integer NOT NULL DEFAULT 0,
     files_changed       integer NOT NULL DEFAULT 0,
     lines_added         double precision NOT NULL DEFAULT 0,
     lines_removed       double precision NOT NULL DEFAULT 0,
     content             text NOT NULL,
     captured_by         text,
     captured_from_start boolean NOT NULL DEFAULT true,
     collector_version   text,
     rw_files_measured   integer,
     rw_files_rewritten  integer,
     rw_lines_added      double precision,
     rw_lines_surviving  double precision,
     rw_measured_at      timestamptz,
     payload             jsonb NOT NULL,
     first_received_at   timestamptz NOT NULL DEFAULT now(),
     updated_at          timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (machine_id, source, session_id)
   )`,
  `CREATE INDEX sessions_started ON sessions (started_at DESC)`,
  `CREATE INDEX sessions_owner ON sessions (owner_email)`,
  // A third kind of token, for the GitHub Action.
  `ALTER TABLE tokens DROP CONSTRAINT tokens_role_check`,
  `ALTER TABLE tokens ADD CONSTRAINT tokens_role_check CHECK (role IN ('admin', 'member', 'ci'))`,
  `CREATE TABLE pull_requests (
     repo                text NOT NULL,
     number              integer NOT NULL,
     head_repo           text,
     title               text,
     url                 text,
     author              text NOT NULL,
     state               text NOT NULL,
     draft               boolean NOT NULL DEFAULT false,
     head_ref            text,
     base_ref            text,
     created_at          timestamptz,
     merged_at           timestamptz,
     closed_at           timestamptz,
     first_event         text NOT NULL,
     last_event          text NOT NULL,
     commits             integer NOT NULL DEFAULT 0,
     reviews             integer NOT NULL DEFAULT 0,
     changes_requested   integer NOT NULL DEFAULT 0,
     review_comments     integer NOT NULL DEFAULT 0,
     bot_review_comments integer NOT NULL DEFAULT 0,
     review_rounds       integer NOT NULL DEFAULT 0,
     files_without_diff  integer NOT NULL DEFAULT 0,
     -- added lines per file, as hashes: when first reported, and now
     first_files         jsonb NOT NULL,
     last_files          jsonb NOT NULL,
     attribution         jsonb NOT NULL,
     first_seen_at       timestamptz NOT NULL DEFAULT now(),
     updated_at          timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (repo, number)
   )`,
  `CREATE INDEX sessions_repo ON sessions (repo)`,
];

/**
 * Run the statements in `list` that `table` doesn't record yet, in order.
 * The core uses the table "migrations"; anything that adds its own tables
 * keeps its own list under its own table name.
 */
export async function runMigrations(db: Db, table: string, list: string[]): Promise<void> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("migration table names are lower-case words");
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY)`);
  const done = new Set((await db.query<{ id: number }>(`SELECT id FROM ${table}`)).map((r) => r.id));
  for (const [id, sql] of list.entries()) {
    if (!done.has(id)) {
      await db.query(sql);
      await db.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
    }
  }
}
