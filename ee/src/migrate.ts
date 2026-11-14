import { rowLevelSecurity, runMigrations, toApp, type Db } from "@sessionly/server";

// Tables of the Business / Enterprise features, tracked apart from the core's migrations.
// Add to the end; never edit an entry that has shipped.
const MIGRATIONS: string[] = [
  `CREATE TABLE ee_licenses (
     id           text PRIMARY KEY,
     org          text NOT NULL,
     raw          text NOT NULL,
     expires_at   timestamptz NOT NULL,
     installed_by text NOT NULL,
     installed_at timestamptz NOT NULL
   )`,
  // One row: what the organisation asks uploads to contain.
  `CREATE TABLE ee_content_policy (
     id         integer PRIMARY KEY CHECK (id = 1),
     content    text NOT NULL,
     updated_by text NOT NULL,
     updated_at timestamptz NOT NULL
   )`,
  // Both belong to an organisation, like everything else. What was there is
  // the one organisation's of a self-hosted install.
  `ALTER TABLE ee_licenses ADD COLUMN org_id text NOT NULL DEFAULT 'default' REFERENCES orgs ON DELETE CASCADE`,
  `ALTER TABLE ee_licenses ALTER COLUMN org_id DROP DEFAULT`,
  `ALTER TABLE ee_licenses DROP CONSTRAINT ee_licenses_pkey`,
  `ALTER TABLE ee_licenses ADD PRIMARY KEY (org_id, id)`,
  `ALTER TABLE ee_content_policy ADD COLUMN org_id text NOT NULL DEFAULT 'default' REFERENCES orgs ON DELETE CASCADE`,
  `ALTER TABLE ee_content_policy ALTER COLUMN org_id DROP DEFAULT`,
  `ALTER TABLE ee_content_policy DROP CONSTRAINT ee_content_policy_pkey`,
  // The one row had id 1; now there is one row per organisation.
  `ALTER TABLE ee_content_policy DROP COLUMN id`,
  `ALTER TABLE ee_content_policy ADD PRIMARY KEY (org_id)`,
  toApp(`SELECT, INSERT, UPDATE, DELETE ON ee_licenses, ee_content_policy`),
  ...rowLevelSecurity("ee_licenses"),
  ...rowLevelSecurity("ee_content_policy"),
];

/** `upTo` stops short of the newest entries: how a test gets the tables as an older server left them. */
export async function migrateEe(db: Db, upTo?: number): Promise<void> {
  await runMigrations(db, "migrations_ee", MIGRATIONS.slice(0, upTo));
}

/** Where the entries that brought organisations begin. */
export const FIRST_EE_ORG_MIGRATION = MIGRATIONS.findIndex((sql) => sql.includes("ee_licenses ADD COLUMN org_id"));
