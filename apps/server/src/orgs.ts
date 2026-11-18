// Deleting an organisation's rows, and restoring one during the seven days
// before that. Both run as the database's owner: once an organisation is
// marked deleted, a request's token is refused, and the rate counters have
// no organisation to set. The default organisation of a self-hosted server
// is never removed.
import type { Db } from "./db.ts";

/** Clear a deletion that has not been purged. False when there is nothing to restore. */
export async function restoreOrg(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(`UPDATE orgs SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [
    id,
  ]);
  return rows.length > 0;
}

/**
 * Remove organisations marked deleted more than 7 days ago, and the rate
 * counters that name them. One replica does it: the others find the lock
 * taken and leave it. The lock ends with the transaction.
 */
export async function purgeDeletedOrgs(db: Db): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [lock] = await tx.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('sessionly-org-purge')) AS ok`,
    );
    if (!lock?.ok) return [];
    const gone = await tx.query<{ id: string }>(
      `DELETE FROM orgs
       WHERE id <> 'default' AND deleted_at IS NOT NULL AND deleted_at < now() - interval '7 days'
       RETURNING id`,
    );
    const ids = gone.map((row) => row.id);
    if (ids.length) {
      await tx.query(`DELETE FROM rate_counters WHERE key = ANY($1::text[])`, [
        ids.flatMap((id) => [`invites:${id}`, `export:${id}`]),
      ]);
    }
    return ids;
  });
}
