// Marking an organisation deleted, restoring that during the seven days
// before its rows go, and removing those rows. Marking it deleted is a
// request, as the organisation. Restoring and removing run as the database's
// owner: once it is marked deleted, a request's token is refused, and the
// rate counters have no organisation to set. The default organisation of a
// self-hosted server is never removed.
import type { Db, OrgDb } from "./db.ts";
import { orgRateKeys } from "./limits.ts";

/** The name typed to delete an organisation was missing or wrong. The route says 400. */
export class OrgNameError extends Error {}

/**
 * Mark an organisation deleted. The row stays until the purge. `name` is what
 * the owner typed, and it has to be this organisation's name.
 */
export async function deleteOrg(db: OrgDb, name: string): Promise<void> {
  const typed = name.trim();
  if (!typed) throw new OrgNameError("type the organisation's name");
  const [org] = await db.query<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [db.orgId]);
  if (org?.name !== typed) throw new OrgNameError("that is not this organisation's name");
  await db.query(`UPDATE orgs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [db.orgId]);
}

/** Clear a deletion that has not been purged. False when there is nothing to restore. */
export async function restoreOrg(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(`UPDATE orgs SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [
    id,
  ]);
  return rows.length > 0;
}

/**
 * Remove organisations marked deleted more than 7 days ago, and the rate
 * counters that name them. One organisation at a time, and not under the
 * limit a request has: its rows can take longer than that, and one that
 * fails must not put the others back. A second replica finds the lock taken
 * and leaves the rest of this pass.
 */
export async function purgeDeletedOrgs(db: Db): Promise<string[]> {
  const due = await db.query<{ id: string }>(
    `SELECT id FROM orgs
     WHERE id <> 'default' AND deleted_at IS NOT NULL AND deleted_at < now() - interval '7 days'
     ORDER BY id`,
  );
  const removed: string[] = [];
  for (const { id } of due) {
    const outcome = await db.transaction(async (tx) => {
      const [lock] = await tx.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('sessionly-org-purge')) AS ok`,
      );
      if (!lock?.ok) return "busy" as const;
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM orgs
         WHERE id = $1 AND id <> 'default' AND deleted_at IS NOT NULL AND deleted_at < now() - interval '7 days'
         RETURNING id`,
        [id],
      );
      if (!rows[0]) return "gone" as const;
      await tx.query(`DELETE FROM rate_counters WHERE key = ANY($1::text[])`, [orgRateKeys(id)]);
      return "removed" as const;
    }, { patient: true });
    if (outcome === "busy") break;
    if (outcome === "removed") removed.push(id);
  }
  return removed;
}
