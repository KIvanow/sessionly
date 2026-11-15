// The people of an organisation: who may sign in to it, and with what role.
import type { OrgDb } from "./db.ts";
import type { Principal } from "./auth.ts";

export interface UserInfo {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  created_at: string;
  removed_at: string | null;
}

export class UserProblem extends Error {
  status: 400 | 404 | 409;
  code: string;
  constructor(status: 400 | 404 | 409, code: string, message: string) {
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
});

/** Everyone who is or was a user of the organisation, owners first. */
export async function listUsers(db: OrgDb): Promise<UserInfo[]> {
  const rows = await db.query(
    `SELECT id, email, role, created_at, removed_at FROM users WHERE org_id = $1
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
  // Who added them is kept, for the page their link opens: but only an
  // address that is known to be the adder's own. A token's address is what
  // an admin typed when making it, and anyone can be an admin of an
  // organisation they made.
  const invitedBy = by.viaEmail ? by.email : null;
  const invitedVia = by.viaEmail ? "sign_in" : "token";
  const rows = existing
    ? await db.query(
        `UPDATE users SET removed_at = NULL, role = $3, invited_by = $4, invited_via = $5 WHERE org_id = $1 AND id = $2
         RETURNING id, email, role, created_at, removed_at`,
        [db.orgId, existing.id, role, invitedBy, invitedVia],
      )
    : await db.query(
        `INSERT INTO users (id, org_id, email, role, invited_by, invited_via) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, role, created_at, removed_at`,
        [id, db.orgId, address, role, invitedBy, invitedVia],
      );
  return info(rows[0] ?? {});
}

/**
 * Remove a person: they can no longer sign in, and every token of theirs
 * stops working, the ones for their machines included.
 */
export async function removeUser(db: OrgDb, id: string, by: Principal): Promise<void> {
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
}
