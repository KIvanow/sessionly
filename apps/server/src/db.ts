// Database access. The server speaks Postgres. Without a DATABASE_URL it runs
// on PGlite (Postgres compiled to WebAssembly, stored in a local folder), so a
// single process is enough to try it or to self-host for a small team.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** Anything a statement can be sent to. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * The database as one organisation sees it. Every statement runs as the
 * database's app role (see `APP_ROLE`), for which row-level security hides
 * and refuses the rows of any other organisation. This is what request
 * handlers get.
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
  /**
   * Run `fn` as the app role with row-level security set to `orgId`, in one
   * transaction. With `snapshot`, every statement of it sees the database as
   * it was when the first one ran: for a request that only reads, and reads
   * in several statements what has to agree.
   */
  asOrg<T>(orgId: string, fn: (db: OrgDb) => Promise<T>, options?: { snapshot?: boolean }): Promise<T>;
  /**
   * Run `fn` in one transaction, as the owner. `patient` is for bringing the
   * database up to date: no limit on how long a statement may take, since a
   * large table takes as long as it takes, and the copies that wait for the
   * one that is doing it wait as long.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: { patient?: boolean; snapshot?: boolean }): Promise<T>;
  close(): Promise<void>;
}

/**
 * The name of the role requests run as, as SQL. Each database has its own:
 * roles belong to the whole cluster, and one shared name would let the user
 * of another database on it (a staging copy, say) take this one's role too.
 *
 * The name is made from a hash of the database's name, so it is 30 bytes
 * whatever the database is called (Postgres cuts names at 63 bytes, not
 * characters), and two long names that begin alike do not end up sharing one.
 */
export const APP_ROLE = `('sessionly_app_' || left(encode(sha256(convert_to(current_database(), 'UTF8')), 'hex'), 16))`;

/** The same name, worked out here for the database called `database`. */
export function appRoleOf(database: string): string {
  return `sessionly_app_${createHash("sha256").update(database, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Makes the role if it is missing, and lets this user switch to it if it may
 * not yet. A user who may create roles does both for itself. One who may not
 * (the kind a managed database's panel creates) needs `roleSetup` run by the
 * database's admin; after that there is nothing left for this to do.
 */
const ROLE_STEP = `DO $$
   DECLARE app text := ${APP_ROLE};
   BEGIN
     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app) THEN
       EXECUTE format('CREATE ROLE %I NOLOGIN', app);
     END IF;
     IF NOT pg_has_role(current_user::name, app::name, 'SET') THEN
       EXECUTE format('GRANT %I TO %I', app, current_user);
     END IF;
   END $$`;

/**
 * What the admin of a database runs, connected to that database, when its
 * user `user` may not create roles. It works out the role's name itself, so
 * it is the same text for every database, and it can be run again (after the
 * database was renamed or restored under another name, say).
 */
export function roleSetup(user: string): string {
  return [
    `DO $$`,
    `DECLARE app text := 'sessionly_app_' || left(encode(sha256(convert_to(current_database(), 'UTF8')), 'hex'), 16);`,
    `BEGIN`,
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app) THEN`,
    `    EXECUTE format('CREATE ROLE %I NOLOGIN', app);`,
    `  END IF;`,
    `  EXECUTE format('GRANT %I TO %I', app, '${user.replace(/'/g, "''")}');`,
    `END $$;`,
  ].join("\n");
}

/** The oldest Postgres this runs on. */
const OLDEST_POSTGRES = 16;

/**
 * Why a server of this version (`server_version_num`) will not do, if it
 * will not. Before 16 a user who may create roles can grant itself any role
 * of the cluster, another database's app role included, and "may switch to
 * a role" cannot be granted apart from "is a member of it".
 */
export function versionProblem(num: number): string | null {
  if (num >= OLDEST_POSTGRES * 10000) return null;
  const version = num >= 100000 ? `${Math.floor(num / 10000)}.${num % 10000}` : String(num);
  return `Sessionly needs Postgres ${OLDEST_POSTGRES} or later; this server is ${version}.`;
}

/** What `toApp` granted, by the statement it made: what a start checks is still in place. */
const GRANTS = new Map<string, Grant>();
interface Grant {
  privileges: string[];
  /** Tables, or one schema. */
  on: string[];
  schema: boolean;
}

/** A name as SQL may spell it, whatever is in it. */
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A transaction all of whose statements see what the first one saw. */
const SNAPSHOT = " ISOLATION LEVEL REPEATABLE READ";

/** What turns a transaction into one organisation's view. `SET LOCAL` ends with it. */
async function enter(tx: Queryable, role: string, orgId: string): Promise<OrgDb> {
  await tx.query(`SET LOCAL ROLE ${quoted(role)}`);
  await tx.query(`SELECT set_config('sessionly.org_id', $1, true)`, [orgId]);
  return { orgId, query: tx.query };
}

/**
 * A setting that is a count: a whole number above 0 in plain digits, no
 * larger than the database's integers go. Undefined if it is not set, or set
 * to anything else: "0.5", "1e3" and "0x10" are not taken for a number that
 * whoever wrote them may not have meant.
 */
export function count(value: string | undefined): number | undefined {
  const text = value?.trim() ?? "";
  const n = /^[0-9]{1,10}$/.test(text) ? Number(text) : 0;
  return n > 0 && n <= 2_147_483_647 ? n : undefined;
}

/** The settings of the connections to Postgres, each a count. */
export const DB_COUNTS = ["SESSIONLY_DB_POOL", "SESSIONLY_DB_QUERY_SECONDS"] as const;

/**
 * The most a setting that is a length of time may be: a day, in seconds. A
 * very large number, written to mean "no limit", is not one: past 24 days a
 * timer here goes off at once, and a little further the database refuses the
 * number. Either way every request would fail.
 */
const DAY_SECONDS = 86_400;
const AT_MOST: Record<string, number> = { SESSIONLY_DB_QUERY_SECONDS: DAY_SECONDS };

/** A setting that is a count, no larger than it may be. */
export function capped(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const n = count(env[name]);
  return n === undefined ? undefined : Math.min(n, AT_MOST[name] ?? n);
}

/**
 * What to say of each of `names` that will not be used as it is set: one
 * that `count` does not take, and one above what it may be.
 */
export function misset(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.flatMap((name) => {
    if (!env[name]?.trim()) return [];
    const n = count(env[name]);
    if (n === undefined) {
      return [`${name} is "${env[name]}", which is not a whole number above 0: it is left out, and the default applies.`];
    }
    const most = AT_MOST[name];
    return most !== undefined && n > most ? [`${name} is ${n}, and may be ${most} at most (a day): ${most} is used.`] : [];
  });
}

/**
 * How long a request waits for a connection: for the server to answer a new
 * one, or for one of the pool's to come free. Without a limit, a host that
 * never answers hangs the start, and a pool with every connection taken
 * holds its requests for good.
 */
const CONNECT_MS = 10_000;

/**
 * How long a statement may take, in seconds, unless SESSIONLY_DB_QUERY_SECONDS
 * says otherwise. A database that fails over can leave its old connections
 * open and silent: nothing sent on one is answered or refused. Without a
 * limit every request that gets such a connection waits for good, and holds
 * the connection while it does.
 */
const QUERY_SECONDS = 30;

/**
 * How long a connection may sit silent before the system asks the other end
 * whether it is still there, which is how one that nobody is using is found
 * to be gone.
 */
const KEEP_ALIVE_MS = 10_000;

/** A statement with this side's limit on how long its answer may take, which pg's types leave out. */
const within = (text: string, values: unknown[] | undefined, ms: number | undefined) =>
  ({ text, values, query_timeout: ms }) as pg.QueryConfig;

/** Where a Postgres address points, without the user or the password. */
function hostOf(url: string): string {
  try {
    const { hostname, port } = new URL(url);
    return `${hostname || "localhost"}:${port || 5432}`;
  } catch {
    return "its address";
  }
}

/**
 * `postgres://…` connects to a Postgres server. `memory://` is an in-memory
 * database for tests. Anything else is a folder for an embedded database.
 */
export async function openDb(
  url: string,
  options: {
    /** Stop short of the newest migrations: how a test gets a database as an older server left it. */
    migrations?: number;
    /** Connections kept at most (Postgres only). Default: SESSIONLY_DB_POOL, or 10. */
    pool?: number;
    /** How long to wait for a connection, in milliseconds (Postgres only). Default: ten seconds. */
    connectMs?: number;
    /** How long a statement may take, in milliseconds (Postgres only). Default: SESSIONLY_DB_QUERY_SECONDS, or 30 seconds. */
    queryMs?: number;
  } = {},
): Promise<Db> {
  let db: Db;
  // Known once the migrations have run.
  let appRole = "";
  // An error of opening the database, said so that it can be acted on.
  let named = (err: unknown) => err;
  if (/^postgres(ql)?:\/\//.test(url)) {
    const max = options.pool ?? count(process.env.SESSIONLY_DB_POOL) ?? 10;
    const connectMs = options.connectMs ?? CONNECT_MS;
    const queryMs = Math.min(
      options.queryMs ?? (capped(process.env, "SESSIONLY_DB_QUERY_SECONDS") ?? QUERY_SECONDS) * 1000,
      DAY_SECONDS * 1000,
    );
    // The database is told the limit and ends a statement that passes it,
    // which leaves the connection usable. This side waits a little longer
    // than that before it gives up itself: by then the database is not
    // answering at all, and the connection is thrown away.
    const giveUpMs = Math.ceil(queryMs * 1.2);
    const pool = new pg.Pool({
      connectionString: url,
      max,
      connectionTimeoutMillis: connectMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEP_ALIVE_MS,
      // The limit for a statement on its own, outside a transaction: the
      // database then ends it too, and does not go on with it after this
      // side has given up. Set on each connection before anyone is handed
      // it. Through a pooler that hands out a connection per transaction it
      // may land on another connection, where it is the same limit anyway.
      // If the database will not have it set, this side's limit still holds.
      onConnect: async (client: pg.ClientBase): Promise<void> => {
        try {
          await client.query(within(`SET statement_timeout = ${queryMs}`, undefined, giveUpMs));
        } catch (err) {
          if (!(err instanceof pg.DatabaseError)) throw err;
        }
      },
    });
    // A connection the database closes (a failover, a restart, an admin)
    // says so with an event, and an event nobody hears ends the process.
    // The pool hears it only while the connection sits unused, and a
    // connection passes between a request and the pool at moments when
    // neither a request nor the pool is listening yet. So each connection
    // gets a listener of its own for as long as it lives.
    const said = new WeakSet<object>();
    // A connection closing says so more than once: said here once.
    const lost = (client: object, err: Error) => {
      if (said.has(client)) return;
      said.add(client);
      console.error(`A database connection was lost: ${err.message}`);
    };
    pool.on("connect", (client) => client.on("error", (err) => lost(client, err)));
    // What the pool says of a connection it dropped while unused, which
    // must be heard as well.
    pool.on("error", (err, client) => lost(client, err));
    const transaction: Db["transaction"] = async (fn, { patient = false, snapshot = false } = {}) => {
      const client = await pool.connect();
      // Set if the connection may still be inside the transaction: it is
      // then thrown away, not handed to the next request with a role and an
      // organisation still set on it.
      let unsure: Error | undefined;
      // A connection lost while a request has it is one of those: whatever
      // statement comes next fails for that request, and no other.
      const mine = (err: Error) => {
        unsure ??= err;
      };
      client.on("error", mine);
      const run = async (text: string, params?: unknown[]) => {
        try {
          return await client.query(within(text, params, patient ? undefined : giveUpMs));
        } catch (err) {
          // The database saying no (a row that breaks a rule, a statement
          // that took too long) leaves the connection as it was. Anything
          // else is the connection itself: no answer in time, or gone.
          if (!(err instanceof pg.DatabaseError)) mine(err as Error);
          throw err;
        }
      };
      try {
        // The limits end with the transaction, so they hold through a
        // pooler that hands out a connection per transaction, and cost no
        // exchange of their own. The second is for a transaction whose
        // server went away in the middle of it: the rows it had locked are
        // let go, and not kept until the system notices.
        const limit = patient ? 0 : queryMs;
        await run(
          `BEGIN${snapshot ? SNAPSHOT : ""}; SET LOCAL statement_timeout = ${limit}; SET LOCAL idle_in_transaction_session_timeout = ${limit}`,
        );
        const out = await fn({ query: async (text, params) => (await run(text, params)).rows });
        try {
          await run("COMMIT");
        } catch (err) {
          unsure = err as Error;
          throw err;
        }
        return out;
      } catch (err) {
        if (!unsure) {
          await run("ROLLBACK").catch((failed: Error) => {
            unsure = failed;
          });
        }
        throw err;
      } finally {
        client.removeListener("error", mine);
        client.release(unsure);
      }
    };
    db = {
      // One statement on its own has the connection's limit (see above) and
      // this side's. The pool throws away a connection whose statement
      // failed, whatever the reason.
      query: async (text, params) => (await pool.query(within(text, params, giveUpMs))).rows,
      transaction,
      asOrg: (orgId, fn, options) => transaction(async (tx) => fn(await enter(tx, appRole, orgId)), options),
      close: () => pool.end(),
    };
    // A host that takes the connection and says nothing is named, with how
    // long it was given: "timeout" alone says neither.
    named = (err) =>
      err instanceof Error && /timeout.*connect|connect.*timeout/i.test(err.message)
        ? new Error(`The database at ${hostOf(url)} did not answer within ${connectMs / 1000} seconds (${err.message}).`)
        : err;
  } else {
    let lite: PGlite;
    if (url === "memory://") {
      lite = new PGlite();
    } else {
      const dir = url.replace(/^file:/, "");
      mkdirSync(dir, { recursive: true });
      lite = new PGlite(dir);
    }
    const transaction: Db["transaction"] = (fn, { snapshot = false } = {}) =>
      lite.transaction(async (tx) => {
        if (snapshot) await tx.query(`SET TRANSACTION${SNAPSHOT}`);
        return fn({ query: async (text, params) => (await tx.query(text, params as unknown[])).rows as never[] });
      }) as Promise<never>;
    db = {
      query: async (text, params) => (await lite.query(text, params as unknown[])).rows as never[],
      transaction,
      asOrg: (orgId, fn, options) => transaction(async (tx) => fn(await enter(tx, appRole, orgId)), options),
      close: () => lite.close(),
    };
  }
  try {
    const [version] = await db.query<{ num: string }>(`SELECT current_setting('server_version_num') AS num`);
    const problem = versionProblem(Number(version?.num));
    if (problem) throw new Error(problem);
    await runMigrations(db, "migrations", MIGRATIONS.slice(0, options.migrations));
    appRole = (await db.query<{ role: string }>(`SELECT ${APP_ROLE} AS role`))[0]?.role ?? "";
  } catch (err) {
    await db.close().catch(() => {});
    throw named(err);
  }
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
  // Row-level security. Requests run as the database's app role, which sees
  // and writes only the rows of the organisation set for its transaction;
  // with none set, no rows at all. The owner of the tables (who runs these
  // migrations) is not subject to the policies.
  ROLE_STEP,
  toApp(`USAGE ON SCHEMA public`),
  toApp(`SELECT, INSERT, UPDATE, DELETE ON tokens, sessions, pull_requests`),
  toApp(`SELECT ON orgs`),
  ...["tokens", "sessions", "pull_requests"].flatMap((table) => rowLevelSecurity(table)),
  ...rowLevelSecurity("orgs", "id"),
  // People. A person is a user of an organisation; one address can be a user
  // of several. Tokens made by signing in, or for a person's machines, are
  // tied to the user, so removing someone stops them.
  `CREATE TABLE users (
     id         text PRIMARY KEY,
     org_id     text NOT NULL REFERENCES orgs ON DELETE CASCADE,
     email      text NOT NULL,
     role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
     created_at timestamptz NOT NULL DEFAULT now(),
     removed_at timestamptz
   )`,
  `CREATE UNIQUE INDEX users_org_email ON users (org_id, email)`,
  // signing in looks an address up across organisations
  `CREATE INDEX users_email ON users (email)`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON users`),
  ...rowLevelSecurity("users"),
  `ALTER TABLE tokens ADD COLUMN user_id text REFERENCES users ON DELETE CASCADE`,
  `ALTER TABLE tokens ADD COLUMN sign_in text CHECK (sign_in IN ('email'))`,
  // Links sent by email: to sign in, or to finish signing up. Only a hash is
  // kept, and a link works once. No organisation and no row-level security:
  // these are read before anyone is known, by the owner alone. A request may
  // add one (an invitation) and nothing more.
  `CREATE TABLE login_codes (
     code_hash  text PRIMARY KEY,
     purpose    text NOT NULL CHECK (purpose IN ('sign_in', 'signup')),
     user_id    text REFERENCES users ON DELETE CASCADE,
     -- for signing up, before there is a user or an organisation
     email      text,
     org_name   text,
     expires_at timestamptz NOT NULL
   )`,
  toApp(`INSERT ON login_codes`),
  // How often something was asked for lately, to say no to too much of it.
  `CREATE TABLE rate_counters (
     key          text NOT NULL,
     window_start timestamptz NOT NULL,
     n            integer NOT NULL,
     PRIMARY KEY (key, window_start)
   )`,
  // Who added a person, and when they first used a link of this
  // organisation's. Until they have, its name is not put in a message to them.
  `ALTER TABLE users ADD COLUMN invited_by text`,
  `ALTER TABLE users ADD COLUMN confirmed_at timestamptz`,
  // A link someone was sent on being added, apart from one they asked for.
  `ALTER TABLE login_codes DROP CONSTRAINT login_codes_purpose_check`,
  `ALTER TABLE login_codes ADD CONSTRAINT login_codes_purpose_check CHECK (purpose IN ('sign_in', 'signup', 'invite'))`,
  `CREATE INDEX login_codes_user ON login_codes (user_id)`,
  // How a person was added: by someone who had signed in, whose address is
  // then known to be theirs, or with a token, whose address is whatever its
  // maker typed. Only the first is shown to the person as who added them.
  `ALTER TABLE users ADD COLUMN invited_via text CHECK (invited_via IN ('sign_in', 'token'))`,
  // People from before sign-ins were noted have signed in if a session of
  // theirs was ever made, or if they are the owner, who signed up by a link.
  `UPDATE users u
   SET confirmed_at = coalesce(
     (SELECT min(t.created_at) FROM tokens t WHERE t.user_id = u.id AND t.sign_in = 'email'),
     CASE WHEN u.role = 'owner' THEN u.created_at END)
   WHERE u.confirmed_at IS NULL`,
  // Signing in is with Google or GitHub now, and no link is sent to anyone.
  // What a provider says of someone who has just come back from it (the
  // addresses it vouches for, the main one first) is kept for the few
  // minutes they take to choose an organisation or name a new one. Like the
  // links before it, it is read by the owner alone; a request can do
  // nothing with it.
  `DROP TABLE login_codes`,
  `CREATE TABLE sign_in_codes (
     code_hash  text PRIMARY KEY,
     provider   text NOT NULL CHECK (provider IN ('google', 'github')),
     emails     text[] NOT NULL CHECK (cardinality(emails) > 0),
     expires_at timestamptz NOT NULL
   )`,
  // A session says which of them it was made with. Sessions from links
  // ('email') stay as they are until they run out.
  `ALTER TABLE tokens DROP CONSTRAINT tokens_sign_in_check`,
  `ALTER TABLE tokens ADD CONSTRAINT tokens_sign_in_check CHECK (sign_in IN ('email', 'google', 'github'))`,
  // Which account a provider said someone is, by the provider's own number
  // for it, beside the addresses. A sign-in that was waiting for its
  // organisation to be chosen when this is added is started again.
  `DELETE FROM sign_in_codes`,
  `ALTER TABLE sign_in_codes ADD COLUMN account text NOT NULL`,
  // The account a person first signed in to an organisation with. From then
  // on only that account gets in as them: a provider goes on vouching for
  // an address after its mailbox has passed to someone else.
  `ALTER TABLE users ADD COLUMN sign_in_provider text CHECK (sign_in_provider IN ('google', 'github'))`,
  `ALTER TABLE users ADD COLUMN sign_in_account text`,
  `ALTER TABLE users ADD CONSTRAINT users_sign_in_account_check CHECK ((sign_in_provider IS NULL) = (sign_in_account IS NULL))`,
  // how many organisations an account owns is counted when it makes another
  `CREATE INDEX users_sign_in_account ON users (sign_in_provider, sign_in_account) WHERE sign_in_account IS NOT NULL`,
  // A sign-in that has come back from its provider, so that the same one
  // does not come back twice. Like the codes, no request reaches it.
  `CREATE TABLE sign_in_states (
     state_hash text PRIMARY KEY,
     expires_at timestamptz NOT NULL
   )`,
  // When a person was last added, or let in anew: what the list of places
  // someone was added to is ordered by. `created_at` stays when they first were.
  `ALTER TABLE users ADD COLUMN invited_at timestamptz`,
  // Having signed in means with an account that is kept. People who signed
  // in before one was kept have none, and would be whoever came first under
  // their address, taken straight in. They are as people who were added and
  // have not signed in: asked, and shown that they have not been here
  // before, and the account they then come with is theirs. (Nothing but
  // trial databases has such people: no release kept sign-ins without it.)
  `UPDATE users SET confirmed_at = NULL WHERE confirmed_at IS NOT NULL AND sign_in_account IS NULL`,
  `ALTER TABLE users ADD CONSTRAINT users_confirmed_with_account CHECK (confirmed_at IS NULL OR sign_in_account IS NOT NULL)`,
  // A pull request's page: per file, the lines an agent wrote, and which
  // sessions wrote them; and its reviews and comments, as who, when, where
  // and a link to GitHub, never their text. Null on a pull request last
  // reported before these were kept.
  `ALTER TABLE pull_requests ADD COLUMN detail jsonb`,
  `ALTER TABLE pull_requests ADD COLUMN feedback jsonb`,
  // How many reviews and comments there are, when that is more than are kept.
  `ALTER TABLE pull_requests ADD COLUMN feedback_total integer`,
  // A person can stop a repository. Sessions of theirs already submitted from
  // it are deleted, and a later upload of it is not stored. The name is the
  // one a session is filed under (its remote, or its path). A path also
  // covers directories inside it; a remote is only itself.
  `CREATE TABLE repo_exclusions (
     org_id      text NOT NULL REFERENCES orgs ON DELETE CASCADE,
     owner_email text NOT NULL,
     repo        text NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (org_id, owner_email, repo)
   )`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON repo_exclusions`),
  ...rowLevelSecurity("repo_exclusions"),
  // How many times a person allowed a repository again. What stopping it
  // deleted can be sent again from then on, and a machine cannot know that
  // by itself: it compares this number with the one it saw last.
  `CREATE TABLE repos_allowed_again (
     org_id      text NOT NULL REFERENCES orgs ON DELETE CASCADE,
     owner_email text NOT NULL,
     times       integer NOT NULL,
     PRIMARY KEY (org_id, owner_email)
   )`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON repos_allowed_again`),
  ...rowLevelSecurity("repos_allowed_again"),
  // Where a session ran, beside the name it is filed under: a stopped folder
  // also covers a clone inside it that is filed under its remote.
  `ALTER TABLE sessions ADD COLUMN repo_root text`,
  `ALTER TABLE sessions ADD COLUMN cwd text`,
  `UPDATE sessions SET repo_root = payload #>> '{session,repo,root}', cwd = payload #>> '{session,cwd}'`,
  // What a pull request's lines are matched by, beside what was kept
  // already: whose sessions count, and the other names of its repository.
  // With them its lines can be matched again without a new report, when
  // sessions arrive after the last one. Whose sessions count is kept as a
  // hash of each address its commits were made with, never the address: it
  // only has to be told which of the people with sessions here they are.
  // Null on a pull request last reported before they were kept: that one
  // waits for its next report.
  `ALTER TABLE pull_requests ADD COLUMN committers jsonb`,
  `ALTER TABLE pull_requests ADD COLUMN aliases jsonb`,
  // When its lines were last matched: by a report, or again since.
  `ALTER TABLE pull_requests ADD COLUMN matched_at timestamptz DEFAULT now()`,
  `UPDATE pull_requests SET matched_at = updated_at`,
  // Which version of the Action last reported a pull request. Null when the
  // report named none, which an Action from before it said does.
  `ALTER TABLE pull_requests ADD COLUMN reporter_version text`,
  // Who sent the report. The version above is kept only when this is
  // `sessionly-action` and the version can be read. A name whose version
  // cannot is kept, and is not read as an older Action. Null, with no
  // version, is an Action from before this was sent: the report named no
  // reporter. A reporter that was present but did not fit is stored as
  // `unknown`, another client, and is not judged. Another client's name
  // is kept so that report is not read as one.
  `ALTER TABLE pull_requests ADD COLUMN reporter_name text`,
  // Rows stored before a report said who sent it. An empty name is not a
  // client: one has to be at least one character, so a later report cannot
  // send this. These rows are not judged. A report that names no one still
  // stores null, and is.
  `UPDATE pull_requests SET reporter_name = '' WHERE reporter_name IS NULL`,
  // How many line hashes a session uploaded: what its lines in a pull
  // request are a share of, for what it cost there. Kept beside the payload
  // so that reading it does not open the payload, and by the database
  // itself whenever a payload is stored, so that a server from before this,
  // still running beside a newer one, keeps it too. Sessions already here
  // are counted after the server has started, some at a time
  // (`countHashedLines`): null until then, and counted from the payload.
  `ALTER TABLE sessions ADD COLUMN hashed_lines integer`,
  `CREATE INDEX sessions_uncounted ON sessions (org_id) WHERE hashed_lines IS NULL`,
  `CREATE FUNCTION sessions_hashed_lines() RETURNS trigger LANGUAGE plpgsql AS $f$
   BEGIN
     NEW.hashed_lines := (
       SELECT coalesce(sum(jsonb_array_length(l->'hashes')), 0)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.payload->'lines') = 'array' THEN NEW.payload->'lines' ELSE '[]'::jsonb END) AS l
       WHERE jsonb_typeof(l->'hashes') = 'array');
     RETURN NEW;
   END $f$`,
  `CREATE TRIGGER sessions_hashed_lines BEFORE INSERT OR UPDATE OF payload ON sessions
   FOR EACH ROW EXECUTE FUNCTION sessions_hashed_lines()`,
  // The sessions with lines in a pull request, as rows, so that all the pull
  // requests a session has lines in can be found by the session: its cost is
  // split between them. `matched` is which lines, as the hashes by file;
  // `weight` is how many they count as, a line that is in several pull
  // requests being shared out between them. Null and the number of lines
  // for one from before these were kept, until it is matched again, and
  // for a session deleted since: its lines are not kept past it.
  // `opened_lines`, `opened_matched` and `opened_weight` are the same of the
  // lines the pull request was first reported with: a session all of whose
  // lines went in review stays here by them, with no lines. Null from
  // before, likewise.
  `CREATE TABLE pull_sessions (
     org_id     text NOT NULL REFERENCES orgs ON DELETE CASCADE,
     repo       text NOT NULL,
     number     integer NOT NULL,
     machine_id text NOT NULL,
     source     text NOT NULL,
     session_id text NOT NULL,
     lines      integer NOT NULL,
     weight     double precision NOT NULL,
     matched    jsonb,
     opened_lines integer,
     opened_weight double precision,
     opened_matched jsonb,
     PRIMARY KEY (org_id, repo, number, machine_id, source, session_id),
     FOREIGN KEY (org_id, repo, number) REFERENCES pull_requests ON DELETE CASCADE
   )`,
  `CREATE INDEX pull_sessions_session ON pull_sessions (org_id, machine_id, source, session_id)`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON pull_sessions`),
  ...rowLevelSecurity("pull_sessions"),
  `INSERT INTO pull_sessions (org_id, repo, number, machine_id, source, session_id, lines, weight)
   SELECT p.org_id, p.repo, p.number, s.machine_id, s.source, s.session_id, s.lines, s.lines
   FROM pull_requests p,
        jsonb_to_recordset(CASE WHEN jsonb_typeof(p.detail->'sessions') = 'array' THEN p.detail->'sessions' ELSE '[]'::jsonb END)
          AS s(machine_id text, source text, session_id text, lines integer)
   WHERE s.machine_id IS NOT NULL AND s.source IS NOT NULL AND s.session_id IS NOT NULL AND s.lines IS NOT NULL
   ON CONFLICT DO NOTHING`,
  // A short history of a pull request's figures: what they were each time
  // they moved, and which sessions accounted for them. No line hashes. A
  // pull request already stored gets one row from the figures it has now,
  // so the next change has something to be compared with. Taken from
  // `pull_sessions`, which is where those sessions are kept.
  `CREATE TABLE pull_request_reports (
     id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     org_id           text NOT NULL,
     repo             text NOT NULL,
     number           integer NOT NULL,
     at               timestamptz NOT NULL DEFAULT clock_timestamp(),
     event            text NOT NULL,
     commits          integer NOT NULL,
     lines            integer NOT NULL,
     agent_lines      integer NOT NULL,
     sessions         jsonb NOT NULL,
     reporter_version text,
     FOREIGN KEY (org_id, repo, number) REFERENCES pull_requests (org_id, repo, number) ON DELETE CASCADE
   )`,
  `CREATE INDEX pull_request_reports_pr ON pull_request_reports (org_id, repo, number, at DESC, id DESC)`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON pull_request_reports`),
  ...rowLevelSecurity("pull_request_reports"),
  `INSERT INTO pull_request_reports (org_id, repo, number, at, event, commits, lines, agent_lines, sessions, reporter_version)
   SELECT p.org_id, p.repo, p.number, coalesce(p.matched_at, p.updated_at), p.last_event, p.commits,
          coalesce((p.attribution #>> '{now,lines}')::integer, 0),
          coalesce((p.attribution #>> '{now,agent_lines}')::integer, 0),
          coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'machine_id', s.machine_id,
              'source', s.source,
              'session_id', s.session_id,
              'lines', s.lines
            ))
            FROM pull_sessions s
            WHERE s.org_id = p.org_id AND s.repo = p.repo AND s.number = p.number AND s.lines > 0
          ), '[]'::jsonb),
          p.reporter_version
   FROM pull_requests p`,
  // The owner can mark the organisation deleted. The row stays until the
  // purge, which runs as the database's owner and is what removes it.
  // After the migrations that have already shipped: a database on those
  // must still be able to take this one.
  toApp(`UPDATE ON orgs`),
  // A session copied into the organisation one repository is shown in, by
  // `importDemo` (demo.ts): only such a row is replaced or removed by the next
  // import. Any other upload of the session makes it its uploader's again.
  `ALTER TABLE sessions ADD COLUMN copied boolean NOT NULL DEFAULT false`,
  // In that organisation: by which paths not shown a pull request's files,
  // lines and comments were last taken out of (a hash, as `rulesOf` makes it).
  // One kept by others has them taken out again at the next import.
  `ALTER TABLE pull_requests ADD COLUMN shown_rules text`,
  // Anyone who signs in may join the organisation a repository is shown in
  // (demo.ts) as a viewer: they see all of it, as an admin does, and change
  // nothing (app.ts).
  `ALTER TABLE users DROP CONSTRAINT users_role_check`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin', 'member', 'viewer'))`,
  `ALTER TABLE tokens DROP CONSTRAINT tokens_role_check`,
  `ALTER TABLE tokens ADD CONSTRAINT tokens_role_check CHECK (role IN ('admin', 'member', 'ci', 'env', 'viewer'))`,
  // What a session's rewrite measurement was 1, 7 and 30 days after it ended
  // (an upload's `checkpoints`), by age: {"7d": {added, surviving,
  // measured_at, age_seconds, ended_at}}. Counts and times. Beside the payload, so that
  // a summary does not open it. One kept is not replaced by a later upload.
  `ALTER TABLE sessions ADD COLUMN checkpoints jsonb NOT NULL DEFAULT '{}'`,
  // A server from before this kept an upload's checkpoints in the payload
  // alone, where a machine updated ahead of it sent them: taken from there,
  // by the rule an upload is stored by (`mergeCheckpoints` in sessions.ts).
  // Such a session may never be uploaded again.
  `UPDATE sessions s SET checkpoints = found.kept
   FROM (
     SELECT u.org_id, u.machine_id, u.source, u.session_id, jsonb_object_agg(c->>'checkpoint', c - 'checkpoint') AS kept
     FROM sessions u, jsonb_array_elements(u.payload->'checkpoints') AS c
     WHERE jsonb_typeof(u.payload->'checkpoints') = 'array'
       AND c->>'checkpoint' IN ('1d', '7d', '30d')
       AND c->>'ended_at' IS NOT NULL AND c->>'measured_at' IS NOT NULL
       AND (c->>'ended_at')::timestamptz = (u.payload #>> '{session,ended_at}')::timestamptz
     GROUP BY u.org_id, u.machine_id, u.source, u.session_id
   ) found
   WHERE s.org_id = found.org_id AND s.machine_id = found.machine_id AND s.source = found.source AND s.session_id = found.session_id`,
  // A merged pull request's agent lines counted again on the branch it was
  // merged into, 7 and 30 days after: how many were looked for, how many
  // were there, and how old the merge was. One row for each age, written
  // once. Apart from the reports of a pull request and their history.
  `CREATE TABLE pull_after_merge (
     org_id      text NOT NULL REFERENCES orgs ON DELETE CASCADE,
     repo        text NOT NULL,
     number      integer NOT NULL,
     checkpoint  text NOT NULL CHECK (checkpoint IN ('7d', '30d')),
     agent_lines integer NOT NULL,
     surviving   integer NOT NULL,
     measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
     age_seconds integer NOT NULL,
     PRIMARY KEY (org_id, repo, number, checkpoint),
     FOREIGN KEY (org_id, repo, number) REFERENCES pull_requests (org_id, repo, number) ON DELETE CASCADE
   )`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON pull_after_merge`),
  ...rowLevelSecurity("pull_after_merge"),
  // From when an organisation's pull requests are counted after merging. An
  // age one reached before that was not counted then, and is not made up
  // later. For the organisations already here that is now.
  `ALTER TABLE orgs ADD COLUMN after_merge_since timestamptz NOT NULL DEFAULT now()`,
  // Of what a session's lines a pull request was opened with count as, what
  // those still there, in any of its pull requests, count as (see `weighKept`
  // in pulls.ts). Null from before, until the pull request is matched again.
  `ALTER TABLE pull_sessions ADD COLUMN opened_kept double precision`,
  // And how many of those lines are still in that pull request itself, a line
  // as often as both have it: what a session from before these were kept is
  // taken not to have, of the lines that survived there.
  `ALTER TABLE pull_sessions ADD COLUMN opened_here integer`,
  // What a session contributed to a pull request at any time: the lines it
  // has there now, those the pull request was first reported with, and those
  // it had at a report between that are gone since, as the hashes by file.
  // It only grows (see `contributedAfter` in contributed.ts): what the session is
  // charged there (`charged_usd`, see `charge`) is split by it, so review
  // taking lines out does not make a pull request cheaper.
  // `contributed_lines` is null from before, until the server has charged
  // the sessions it held (run.ts); `contributed` is null for one whose lines
  // were not kept, and past a session that was deleted, with its charge.
  `ALTER TABLE pull_sessions ADD COLUMN contributed jsonb`,
  `ALTER TABLE pull_sessions ADD COLUMN contributed_lines integer`,
  `ALTER TABLE pull_sessions ADD COLUMN charged_usd double precision`,
  // Which of the lines it had in the pull request went from its files since:
  // they stay the session's whatever is matched after (see `contributedAfter`).
  // Null from before, and with `contributed`.
  `ALTER TABLE pull_sessions ADD COLUMN gone jsonb`,
];

/**
 * Count the line hashes of the sessions stored before the count was kept,
 * some at a time so that nothing waits on it for long. Run after the server
 * has started, and again while any are left; several copies doing it at
 * once count each session once. Those with lines in a pull request come
 * first: until one is counted, a pull request says its share is not known.
 * A batch that fails (payloads can be large) is tried again as a smaller
 * one, down to one session; a session that fails alone is passed over, and
 * is among the `failed`, to be tried the next time.
 *
 * It waits for no session another transaction holds: that one may be
 * deleting several sessions, in an order of its own (stopping a
 * repository), and the two could each wait for the other. A session held is
 * passed over and is among the `failed` too.
 */
export async function countHashedLines(db: Db, atOnce = 50): Promise<{ counted: number; failed: number }> {
  const inPulls = `AND EXISTS (SELECT 1 FROM pull_sessions p WHERE p.org_id = u.org_id AND p.machine_id = u.machine_id
                               AND p.source = u.source AND p.session_id = u.session_id)`;
  type Key = { org_id: string; machine_id: string; source: string; session_id: string };
  let counted = 0;
  let failed = 0;
  for (const which of [inPulls, ""]) {
    let some = atOnce;
    // The last session looked at: the next ones are those after it, so one that fails is not met again.
    let last: Key | undefined;
    for (;;) {
      const keys = await db.query<Key>(
        `SELECT u.org_id, u.machine_id, u.source, u.session_id FROM sessions u
         WHERE u.hashed_lines IS NULL ${which}
           AND ($1::jsonb IS NULL OR (u.org_id, u.machine_id, u.source, u.session_id) >
                 ($1::jsonb->>'org_id', $1::jsonb->>'machine_id', $1::jsonb->>'source', $1::jsonb->>'session_id'))
         ORDER BY u.org_id, u.machine_id, u.source, u.session_id LIMIT $2`,
        [last ? JSON.stringify(last) : null, some],
      );
      if (keys.length === 0) break;
      try {
        const { rows, held } = await db.transaction(async (tx) => {
          // The ones no other transaction holds, held now, in the order they were chosen in.
          const free = await tx.query(
            `SELECT s.org_id, s.machine_id, s.source, s.session_id FROM sessions s
             JOIN jsonb_to_recordset($1::jsonb) AS k(org_id text, machine_id text, source text, session_id text)
               ON s.org_id = k.org_id AND s.machine_id = k.machine_id AND s.source = k.source AND s.session_id = k.session_id
             ORDER BY s.org_id, s.machine_id, s.source, s.session_id
             FOR UPDATE OF s SKIP LOCKED`,
            [JSON.stringify(keys)],
          );
          const rows = await tx.query(
            `UPDATE sessions s SET hashed_lines =
               (SELECT coalesce(sum(jsonb_array_length(l->'hashes')), 0)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload->'lines') = 'array' THEN s.payload->'lines' ELSE '[]'::jsonb END) AS l
                WHERE jsonb_typeof(l->'hashes') = 'array')
             FROM jsonb_to_recordset($1::jsonb) AS k(org_id text, machine_id text, source text, session_id text)
             WHERE s.org_id = k.org_id AND s.machine_id = k.machine_id AND s.source = k.source
               AND s.session_id = k.session_id AND s.hashed_lines IS NULL
             RETURNING 1`,
            [JSON.stringify(free)],
          );
          // One deleted meanwhile is counted with them: the next time, it is not there to try.
          return { rows, held: keys.length - free.length };
        }, PATIENT);
        counted += rows.length;
        failed += held;
        last = keys[keys.length - 1];
        some = Math.min(atOnce, some * 2);
      } catch (err) {
        if (keys.length > 1) {
          some = Math.max(1, Math.floor(keys.length / 2));
          continue;
        }
        console.error(`The line hashes of session ${keys[0]!.session_id} could not be counted:`, err);
        failed += 1;
        last = keys[0];
      }
    }
  }
  return { counted, failed };
}

/**
 * A statement granting `privileges` (as `SELECT, INSERT ON a, b`, or
 * `USAGE ON SCHEMA public`) to the database's app role. A table requests
 * must reach gets this in the migration that makes it; a test fails for one
 * that has not.
 */
export function toApp(privileges: string): string {
  const parts = /^([A-Z, ]+) ON (SCHEMA )?([a-z0-9_, ]+)$/.exec(privileges);
  if (!parts) throw new Error(`toApp: "${privileges}" is not "PRIVILEGE, … ON table, …"`);
  const sql = `DO $$ BEGIN EXECUTE format('GRANT ${privileges} TO %I', ${APP_ROLE}); END $$`;
  const list = (text: string) => text.split(",").map((word) => word.trim());
  GRANTS.set(sql, { privileges: list(parts[1]!), on: list(parts[3]!), schema: Boolean(parts[2]) });
  return sql;
}

/** Run the role step, and say what the database's admin has to do if this user may not. */
async function roleStep(tx: Queryable): Promise<void> {
  const [who] = await tx.query<{ app: string; me: string; name: string; made: boolean }>(
    `SELECT r.app, current_user AS me, current_database() AS name,
            EXISTS (SELECT FROM pg_roles WHERE rolname = r.app) AS made
     FROM (SELECT ${APP_ROLE} AS app) r`,
  );
  try {
    await tx.query(ROLE_STEP);
  } catch (err) {
    if ((err as { code?: string }).code !== "42501" || !who) throw err;
    const missing = who.made
      ? `The database user ${quoted(who.me)} has not been granted the role requests run as, ${quoted(who.app)}.`
      : `The role requests run as, ${quoted(who.app)}, does not exist, and the database user ${quoted(who.me)} may not create roles.`;
    throw new Error(
      `${missing}\n` +
        `Have the database's admin run this, connected to the database ${quoted(who.name)}, then start again.\n` +
        `It does only what is missing, so running it twice is safe:\n\n${roleSetup(who.me)}\n`,
      { cause: err },
    );
  }
}

/**
 * The role belongs to the database's name, and what it was granted was
 * granted by migrations that ran once. A database that was renamed, copied
 * or restored under another name has neither for its new name, and every
 * request would fail. So each start checks that the role is there, that
 * this user may switch to it, and that it holds everything in `grants`; if
 * anything is missing, the role step and the grants run again. The role of
 * the name the database had before loses what it held here.
 */
async function sameRoleStill(tx: Queryable, grants: Grant[]): Promise<void> {
  const [role] = await tx.query<{ app: string; made: boolean }>(
    `SELECT r.app, EXISTS (SELECT FROM pg_roles WHERE rolname = r.app) AS made FROM (SELECT ${APP_ROLE} AS app) r`,
  );
  if (!role) return;
  const wanted = grants.flatMap((grant) =>
    grant.on.flatMap((on) => grant.privileges.map((privilege) => ({ on, privilege, schema: grant.schema }))),
  );
  if (role.made) {
    // A table that a later migration dropped is not one to hold anything on.
    const [found] = await tx.query<{ may: boolean; missing: unknown }>(
      `SELECT pg_has_role(current_user::name, $1::name, 'SET') AS may,
              (SELECT count(*) FROM unnest($2::text[], $3::text[], $4::boolean[]) AS g(obj, privilege, is_schema)
               WHERE CASE WHEN g.is_schema THEN NOT has_schema_privilege($1::name, g.obj, g.privilege)
                          ELSE to_regclass(g.obj) IS NOT NULL
                               AND NOT has_table_privilege($1::name, to_regclass(g.obj)::oid, g.privilege) END) AS missing`,
      [role.app, wanted.map((w) => w.on), wanted.map((w) => w.privilege), wanted.map((w) => w.schema)],
    );
    if (found?.may && Number(found.missing) === 0) return;
  }
  await roleStep(tx);
  for (const grant of grants) {
    const privileges = grant.privileges.join(", ");
    for (const on of grant.on) {
      await tx.query(
        grant.schema
          ? `DO $$ BEGIN EXECUTE format('GRANT ${privileges} ON SCHEMA ${on} TO %I', ${APP_ROLE}); END $$`
          : `DO $$ BEGIN IF to_regclass('${on}') IS NOT NULL THEN
               EXECUTE format('GRANT ${privileges} ON ${on} TO %I', ${APP_ROLE});
             END IF; END $$`,
      );
    }
  }
  await tx.query(
    `DO $$
     DECLARE app text := ${APP_ROLE}; stale record;
     BEGIN
       FOR stale IN
         SELECT DISTINCT c.oid::regclass AS tbl, r.rolname AS role
         FROM pg_class c
              CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
              JOIN pg_roles r ON r.oid = acl.grantee
         WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
           AND r.rolname ~ '^sessionly_app_' AND r.rolname <> app
       LOOP
         EXECUTE format('REVOKE ALL ON %s FROM %I', stale.tbl, stale.role);
       END LOOP;
       FOR stale IN
         SELECT DISTINCT r.rolname AS role
         FROM pg_namespace n
              CROSS JOIN LATERAL aclexplode(n.nspacl) AS acl
              JOIN pg_roles r ON r.oid = acl.grantee
         WHERE n.nspname = current_schema() AND r.rolname ~ '^sessionly_app_' AND r.rolname <> app
       LOOP
         EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', current_schema(), stale.role);
       END LOOP;
     END $$`,
  );
}

/** Where the migrations that brought organisations begin. */
export const FIRST_ORG_MIGRATION = MIGRATIONS.findIndex((sql) => sql.startsWith("CREATE TABLE orgs"));

/** Where the migration that begins with `start` is: how a test stops just short of it. */
export function migrationAt(start: string): number {
  return MIGRATIONS.findIndex((sql) => sql.startsWith(start));
}

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

const PATIENT = { patient: true };

/** A list of migrations and the table that records which of them have run. */
export interface Migrations {
  table: string;
  list: string[];
}

/**
 * Run the statements in `list` that `table` doesn't record yet, in order.
 * The core uses the table "migrations"; anything that adds its own tables
 * keeps its own list under its own table name.
 */
export async function runMigrations(db: Db, table: string, list: string[]): Promise<void> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("migration table names are lower-case words");
  // Everything that is pending runs in one transaction: all of it lands, or
  // none. Several copies of the server may start at once, so the transaction
  // first takes a lock: one migrates, the rest wait and then find nothing
  // left to do. The lock ends with the transaction, which is what makes it
  // hold through a connection pooler that hands out a connection per
  // transaction.
  // A statement here may take as long as it takes, and so may the wait for
  // the copy that is running them.
  const migrate = () =>
    db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessionly-${table}`]);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY)`);
      const done = new Set((await tx.query<{ id: number }>(`SELECT id FROM ${table}`)).map((r) => r.id));
      // Before anything new is granted: the role everything before it was granted to.
      const granted = list.flatMap((sql, id) => (done.has(id) ? (GRANTS.get(sql) ?? []) : []));
      if (granted.length) await sameRoleStill(tx, granted);
      for (const [id, sql] of list.entries()) {
        if (done.has(id)) continue;
        if (sql === ROLE_STEP) await roleStep(tx);
        else await tx.query(sql);
        await tx.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
      }
    }, PATIENT);
  // The lock is this database's. Roles are the whole cluster's, and changing
  // them at the same moment from two databases of one cluster (as tests do)
  // can fail in one. Nothing of its transaction stays, so it starts over.
  for (let attempt = 1; ; attempt++) {
    try {
      return await migrate();
    } catch (err) {
      if (attempt >= 8 || !rolesRace(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt + Math.random() * 40));
    }
  }
}

/** Whether an error is two transactions changing the cluster's roles at once. */
function rolesRace(err: unknown): boolean {
  const e = err as { code?: string; table?: string; message?: string };
  return (
    (e.code === "23505" && /^pg_(authid|auth_members)$/.test(e.table ?? "")) ||
    /tuple concurrently updated/.test(e.message ?? "")
  );
}
