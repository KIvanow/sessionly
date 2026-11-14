// Database access. The server speaks Postgres. Without a DATABASE_URL it runs
// on PGlite (Postgres compiled to WebAssembly, stored in a local folder), so a
// single process is enough to try it or to self-host for a small team.
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** Anything a statement can be sent to. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * The database as one organisation sees it. Every statement runs as the role
 * `sessionly_app`, for which row-level security hides and refuses the rows
 * of any other organisation. This is what request handlers get.
 */
export interface OrgDb extends Queryable {
  readonly orgId: string;
}

/**
 * The database as its owner sees it: every organisation's rows. Only the few
 * places that run before an organisation is known use it (finding a token,
 * signing up, the command line); `scripts/check-unscoped.mjs` keeps that
 * list short.
 */
export interface Db extends Queryable {
  /** Run `fn` as `sessionly_app` with row-level security set to `orgId`, in one transaction. */
  asOrg<T>(orgId: string, fn: (db: OrgDb) => Promise<T>): Promise<T>;
  /** Run `fn` in one transaction, as the owner. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Run `fn` while no other process connected to this database runs one under the same `key`. */
  locked<T>(key: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** What turns a transaction into one organisation's view. `SET LOCAL` ends with it. */
async function enter(tx: Queryable, orgId: string): Promise<OrgDb> {
  await tx.query(`SET LOCAL ROLE sessionly_app`);
  await tx.query(`SELECT set_config('sessionly.org_id', $1, true)`, [orgId]);
  return { orgId, query: tx.query };
}

/**
 * `postgres://…` connects to a Postgres server. `memory://` is an in-memory
 * database for tests. Anything else is a folder for an embedded database.
 */
export async function openDb(url: string): Promise<Db> {
  let db: Db;
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.SESSIONLY_DB_POOL ?? 10) });
    const transaction: Db["transaction"] = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: async (text, params) => (await client.query(text, params as unknown[])).rows });
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };
    db = {
      query: async (text, params) => (await pool.query(text, params as unknown[])).rows,
      transaction,
      asOrg: (orgId, fn) => transaction(async (tx) => fn(await enter(tx, orgId))),
      // An advisory lock belongs to a connection, so it gets one of its own:
      // the pool could send the unlock down another.
      locked: async (key, fn) => {
        const client = await pool.connect();
        try {
          await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [key]);
          try {
            return await fn();
          } finally {
            await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]);
          }
        } finally {
          client.release();
        }
      },
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
    const transaction: Db["transaction"] = (fn) =>
      lite.transaction((tx) =>
        fn({ query: async (text, params) => (await tx.query(text, params as unknown[])).rows as never[] }),
      ) as Promise<never>;
    db = {
      query: async (text, params) => (await lite.query(text, params as unknown[])).rows as never[],
      transaction,
      asOrg: (orgId, fn) => transaction(async (tx) => fn(await enter(tx, orgId))),
      // One process has the embedded database to itself.
      locked: (_key, fn) => fn(),
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
  // Sessions that ran in the cloud, and a kind of token for where they run.
  `ALTER TABLE sessions ADD COLUMN runtime text`,
  `ALTER TABLE sessions ADD COLUMN runtime_id text`,
  `ALTER TABLE tokens DROP CONSTRAINT tokens_role_check`,
  `ALTER TABLE tokens ADD CONSTRAINT tokens_role_check CHECK (role IN ('admin', 'member', 'ci', 'env'))`,
  // Organisations. Every row belongs to one, and every key starts with it.
  // A self-hosted install has the one made here.
  `CREATE TABLE orgs (
     id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
     name       text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     -- set when its owner asks for it to be deleted; the rows go later
     deleted_at timestamptz
   )`,
  `INSERT INTO orgs (id, name) VALUES ('default', 'Default')`,
  `ALTER TABLE tokens ADD COLUMN org_id text NOT NULL DEFAULT 'default' REFERENCES orgs ON DELETE CASCADE`,
  `ALTER TABLE sessions ADD COLUMN org_id text NOT NULL DEFAULT 'default' REFERENCES orgs ON DELETE CASCADE`,
  `ALTER TABLE pull_requests ADD COLUMN org_id text NOT NULL DEFAULT 'default' REFERENCES orgs ON DELETE CASCADE`,
  `ALTER TABLE tokens ALTER COLUMN org_id DROP DEFAULT`,
  `ALTER TABLE sessions ALTER COLUMN org_id DROP DEFAULT`,
  `ALTER TABLE pull_requests ALTER COLUMN org_id DROP DEFAULT`,
  `ALTER TABLE sessions DROP CONSTRAINT sessions_pkey`,
  `ALTER TABLE sessions ADD PRIMARY KEY (org_id, machine_id, source, session_id)`,
  `ALTER TABLE pull_requests DROP CONSTRAINT pull_requests_pkey`,
  `ALTER TABLE pull_requests ADD PRIMARY KEY (org_id, repo, number)`,
  `DROP INDEX sessions_started`,
  `CREATE INDEX sessions_started ON sessions (org_id, started_at DESC)`,
  `DROP INDEX sessions_owner`,
  `CREATE INDEX sessions_owner ON sessions (org_id, owner_email)`,
  `DROP INDEX sessions_repo`,
  `CREATE INDEX sessions_repo ON sessions (org_id, repo)`,
  `CREATE INDEX tokens_org ON tokens (org_id)`,
  // A token from signing in by email lasts a week.
  `ALTER TABLE tokens ADD COLUMN expires_at timestamptz`,
  // Row-level security. Requests run as sessionly_app, which sees and writes
  // only the rows of the organisation set for its transaction; with none
  // set, no rows at all. The owner of the tables (who runs these migrations)
  // is not subject to the policies. Roles belong to the whole cluster, so
  // another database in it may have made this one already.
  `DO $$ BEGIN
     CREATE ROLE sessionly_app NOLOGIN;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  `GRANT sessionly_app TO CURRENT_USER`,
  `GRANT USAGE ON SCHEMA public TO sessionly_app`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON tokens, sessions, pull_requests TO sessionly_app`,
  `GRANT SELECT ON orgs TO sessionly_app`,
  ...["tokens", "sessions", "pull_requests"].flatMap((table) => rowLevelSecurity(table)),
  ...rowLevelSecurity("orgs", "id"),
];

/**
 * The statements that confine a table to the organisation of the transaction.
 * Every table with an org column must get these in the migration that makes
 * it; a test fails for one that has not.
 */
export function rowLevelSecurity(table: string, column = "org_id"): string[] {
  const org = `current_setting('sessionly.org_id', true)`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY org_only ON ${table} USING (${column} = ${org}) WITH CHECK (${column} = ${org})`,
  ];
}

/**
 * Run the statements in `list` that `table` doesn't record yet, in order.
 * The core uses the table "migrations"; anything that adds its own tables
 * keeps its own list under its own table name.
 */
export async function runMigrations(db: Db, table: string, list: string[]): Promise<void> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("migration table names are lower-case words");
  // Several copies of the server may start at once: one migrates, the rest
  // wait and then find nothing left to do.
  await db.locked(table, async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY)`);
    const done = new Set((await db.query<{ id: number }>(`SELECT id FROM ${table}`)).map((r) => r.id));
    for (const [id, sql] of list.entries()) {
      if (done.has(id)) continue;
      // An entry and the note that it ran succeed or fail together.
      await db.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
      });
    }
  });
}
