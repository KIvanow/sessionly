// Database access. The server speaks Postgres. Without a DATABASE_URL it runs
// on PGlite (Postgres compiled to WebAssembly, stored in a local folder), so a
// single process is enough to try it or to self-host for a small team.
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
    const lite = url === "memory://" ? new PGlite() : new PGlite(url.replace(/^file:/, ""));
    db = {
      query: async (text, params) => (await lite.query(text, params as unknown[])).rows as never[],
      close: () => lite.close(),
    };
  }
  await migrate(db);
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
];

async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS migrations (id integer PRIMARY KEY)`);
  const done = new Set((await db.query<{ id: number }>(`SELECT id FROM migrations`)).map((r) => r.id));
  for (const [id, sql] of MIGRATIONS.entries()) {
    if (!done.has(id)) {
      await db.query(sql);
      await db.query(`INSERT INTO migrations (id) VALUES ($1)`, [id]);
    }
  }
}
