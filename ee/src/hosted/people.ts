// Adding people to an organisation of the hosted service, who then sign in
// with an account that has the address they were added under.
import { USER_COLUMNS, userInfo, UserProblem, type OrgDb, type Principal, type UserInfo } from "@sessionly/server";

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
         RETURNING ${USER_COLUMNS}`,
        [db.orgId, existing.id, role, invitedBy, invitedVia],
      )
    : await db.query(
        `INSERT INTO users (id, org_id, email, role, invited_by, invited_via, invited_at) VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING ${USER_COLUMNS}`,
        [id, db.orgId, address, role, invitedBy, invitedVia],
      );
  return userInfo(rows[0] ?? {});
}
