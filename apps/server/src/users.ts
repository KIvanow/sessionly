// The people of an organisation: who may sign in to it, and with what role.
import type { OrgDb } from "./db.ts";
import type { Principal } from "./auth.ts";
import type { ProviderName } from "./oauth.ts";
import { forgetLines, holdUploads } from "./sessions.ts";

export interface UserInfo {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  created_at: string;
  removed_at: string | null;
  /**
   * Whose account they sign in with here: Google's or GitHub's. Null until
   * they have signed in, and again after their account was forgotten.
   */
  signed_in_with: ProviderName | null;
}

export class UserProblem extends Error {
  status: 400 | 403 | 404 | 409;
  code: string;
  constructor(status: 400 | 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const iso = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

const info = (row: Record<string, unknown>): UserInfo => ({
  id: String(row.id),
  email: String(row.email),
  role: row.role as UserInfo["role"],
  created_at: iso(row.created_at) ?? "",
  removed_at: iso(row.removed_at),
  signed_in_with: (row.sign_in_provider as ProviderName | null) ?? null,
});

const COLUMNS = `id, email, role, created_at, removed_at, sign_in_provider`;

/** Everyone who is or was a user of the organisation, owners first. */
export async function listUsers(db: OrgDb): Promise<UserInfo[]> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM users WHERE org_id = $1
     ORDER BY removed_at IS NOT NULL, role <> 'owner', role <> 'admin', email`,
    [db.orgId],
  );
  return rows.map(info);
}

/** The organisation's name, for the messages it sends. */
export async function orgName(db: OrgDb): Promise<string> {
  const [org] = await db.query<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [db.orgId]);
  return org?.name ?? db.orgId;
}

/**
 * Add a person, or bring back one who was removed. Their history was never
 * taken away: sessions are kept under the address they were filed under.
 */
export async function addUser(
  db: OrgDb,
  id: string,
  email: string,
  role: "admin" | "member",
  by: Principal,
): Promise<UserInfo> {
  const address = email.trim().toLowerCase();
  const [existing] = await db.query<{ id: string; removed_at: unknown }>(
    `SELECT id, removed_at FROM users WHERE org_id = $1 AND email = $2`,
    [db.orgId, address],
  );
  if (existing && existing.removed_at == null) {
    throw new UserProblem(409, "already_a_user", `${address} is already in this organisation`);
  }
  // Who added them is kept, for the page that asks them before they first
  // sign in here: but only an
  // address that is known to be the adder's own. A token's address is what
  // an admin typed when making it, and anyone can be an admin of an
  // organisation they made.
  const invitedBy = by.signedIn ? by.email : null;
  const invitedVia = by.signedIn ? "sign_in" : "token";
  // Someone brought back is added anew: asked before they sign in here
  // again, and let in with whichever account they then come with. That is
  // how an admin lets a person in who has changed accounts.
  const rows = existing
    ? await db.query(
        `UPDATE users SET removed_at = NULL, role = $3, invited_by = $4, invited_via = $5, invited_at = now(),
                          confirmed_at = NULL, sign_in_provider = NULL, sign_in_account = NULL
         WHERE org_id = $1 AND id = $2
         RETURNING ${COLUMNS}`,
        [db.orgId, existing.id, role, invitedBy, invitedVia],
      )
    : await db.query(
        `INSERT INTO users (id, org_id, email, role, invited_by, invited_via, invited_at) VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING ${COLUMNS}`,
        [id, db.orgId, address, role, invitedBy, invitedVia],
      );
  return info(rows[0] ?? {});
}

/**
 * Remove a person: they can no longer sign in, and every token of theirs
 * stops working, the ones for their machines included.
 */
export async function removeUser(db: OrgDb, id: string, by: Principal, options?: { data?: boolean }): Promise<void> {
  const [user] = await db.query<{ id: string; email: string; role: string }>(
    `SELECT id, email, role FROM users WHERE org_id = $1 AND id = $2 AND removed_at IS NULL`,
    [db.orgId, id],
  );
  if (!user) throw new UserProblem(404, "no_such_user", "there is no such person in this organisation");
  if (user.role === "owner") {
    throw new UserProblem(409, "owner_stays", "the owner of an organisation cannot be removed");
  }
  if (user.id === by.userId) throw new UserProblem(409, "not_yourself", "you cannot remove yourself");
  await db.query(`UPDATE users SET removed_at = now() WHERE org_id = $1 AND id = $2`, [db.orgId, id]);
  // By person, and by address for tokens made before they were a user here.
  await db.query(
    `UPDATE tokens SET revoked_at = now()
     WHERE org_id = $1 AND revoked_at IS NULL AND role IN ('admin', 'member')
       AND (user_id = $2 OR email = $3)`,
    [db.orgId, id, user.email],
  );
  // Asked for: their sessions go too, and so does what they stopped. Pull
  // requests stay. The figures were worked out from those sessions and the
  // page says a session is gone. Without this, nothing here is deleted.
  // Wait for an upload that is storing one of theirs. It then commits, and
  // the delete below removes it. An upload that waits sees them removed.
  // The lines a pull request kept of those sessions go with them. The pull
  // request stays, and says a session of it was deleted since.
  if (!options?.data) return;
  await holdUploads(db, user.email);
  const removed = await db.query(
    `DELETE FROM sessions WHERE org_id = $1 AND owner_email = $2 RETURNING machine_id, source, session_id`,
    [db.orgId, user.email],
  );
  await forgetLines(db, removed);
  await db.query(`DELETE FROM repo_exclusions WHERE org_id = $1 AND owner_email = $2`, [db.orgId, user.email]);
  await db.query(`DELETE FROM repos_allowed_again WHERE org_id = $1 AND owner_email = $2`, [db.orgId, user.email]);
}

/**
 * Forget which account a person signs in with here, so that they can come
 * with another: the one they had is gone, or it was never theirs. Anyone
 * may be let in anew this way, the owner too, who cannot be removed and
 * added again. They are then as someone who was just added: whoever next
 * signs in under their address is asked first, and that account is theirs
 * from then on. So this is for someone else to do, who knows why: `by` is
 * who, or null from the command line. The sessions they had are ended; the
 * tokens of their machines are not, and uploads go on.
 */
export async function forgetAccount(db: OrgDb, who: { id: string } | { email: string }, by: Principal | null): Promise<UserInfo> {
  const [user] = await db.query<{ id: string; email: string; role: string }>(
    `SELECT id, email, role FROM users WHERE org_id = $1 AND removed_at IS NULL AND ${"id" in who ? "id" : "email"} = $2`,
    [db.orgId, "id" in who ? who.id : who.email.trim().toLowerCase()],
  );
  if (!user) throw new UserProblem(404, "no_such_user", "there is no such person in this organisation");
  if (by && user.id === by.userId) {
    throw new UserProblem(409, "not_yourself", "someone else has to do this for you: another admin, or whoever runs this server");
  }
  // The owner's place is the one worth taking, and whoever is let in under
  // their address next has it. A token says nothing of who holds it, so for
  // an owner this takes an admin who has signed in, and is known by an
  // account, or the command line.
  if (by && !by.signedIn && user.role === "owner") {
    throw new UserProblem(
      403,
      "sign_in_needed",
      "an owner is let in with another account by an admin who has signed in, or from the command line: not with a token",
    );
  }
  const rows = await db.query(
    `UPDATE users SET confirmed_at = NULL, sign_in_provider = NULL, sign_in_account = NULL,
                      invited_by = $3, invited_via = $4, invited_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [db.orgId, user.id, by?.signedIn ? by.email : null, by ? (by.signedIn ? "sign_in" : "token") : null],
  );
  await db.query(
    `UPDATE tokens SET revoked_at = now() WHERE org_id = $1 AND user_id = $2 AND sign_in IS NOT NULL AND revoked_at IS NULL`,
    [db.orgId, user.id],
  );
  // Written down: it decides who a person is from here on, and there is no
  // other record of who decided it.
  const doer = by ? `${by.email}, ${by.signedIn ? "signed in" : "with a token"}` : "the command line";
  console.log(`"${db.orgId}": the account of ${user.email} (${user.role}) was forgotten by ${doer}; whoever signs in under that address next is that person`);
  return info(rows[0] ?? {});
}
