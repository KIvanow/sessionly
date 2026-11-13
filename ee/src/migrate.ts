import { runMigrations, type Db } from "@sessionly/server";

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
];

export async function migrateEe(db: Db): Promise<void> {
  await runMigrations(db, "migrations_ee", MIGRATIONS);
}
