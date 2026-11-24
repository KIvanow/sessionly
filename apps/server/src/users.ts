// The people of an organisation: who may sign in to it, and with what role.
import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import type { OrgDb } from "./db.ts";
import type { Principal, ProviderName } from "./auth.ts";
import { forgetLines, holdUploads } from "./sessions.ts";

export interface UserInfo {
  id: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
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

/** A row of `users` as it is answered. */
export const userInfo = (row: Record<string, unknown>): UserInfo => ({
  id: String(row.id),
  email: String(row.email),
  role: row.role as UserInfo["role"],
  created_at: iso(row.created_at) ?? "",
  removed_at: iso(row.removed_at),
  signed_in_with: (row.sign_in_provider as ProviderName | null) ?? null,
});

/** What `userInfo` reads. */
export const USER_COLUMNS = `id, email, role, created_at, removed_at, sign_in_provider`;

/** Everyone who is or was a user of the organisation, owners first. */
export async function listUsers(db: OrgDb): Promise<UserInfo[]> {
  const rows = await db.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE org_id = $1
     ORDER BY removed_at IS NOT NULL, role <> 'owner', role <> 'admin', email`,
    [db.orgId],
  );
  return rows.map(userInfo);
}

/** The organisation's name, for the messages it sends. */
export async function orgName(db: OrgDb): Promise<string> {
  const [org] = await db.query<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [db.orgId]);
  return org?.name ?? db.orgId;
}

/**
 * An address as it is kept and compared, or null if it is not one this
 * takes. Lower case, and the domain in its plain form (`domainToASCII`), so
 * that one domain is one however it is written. The part before the @ is
 * the letters, digits and signs of an ordinary address: no quotes, no
 * spaces, nothing invisible, and no letters from beyond ASCII, each of which
 * is a way to write one mailbox as many addresses.
 */
export function emailFrom(typed: unknown): string | null {
  if (typeof typed !== "string") return null;
  const text = typed.trim();
  const at = text.lastIndexOf("@");
  if (at < 1) return null;
  const local = text.slice(0, at).toLowerCase();
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || /^\.|\.$|\.\./.test(local)) return null;
  const labels = domainToASCII(text.slice(at + 1).replace(/\.$/, "")).toLowerCase().split(".");
  // A domain as the DNS has them: two labels or more, each of 63 characters
  // at most with no hyphen at either end, and the last not a number (which
  // would be an IP address, or nothing).
  if (labels.length < 2 || !labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
  const domain = labels.join(".");
  const email = `${local}@${domain}`;
  return email.length <= 254 ? email : null;
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `usr_` and 14 characters. */
export function newUserId(): string {
  return `usr_${Array.from(randomBytes(14), (byte) => ALPHABET[byte % ALPHABET.length]).join("")}`;
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
  // By address too: an opened dashboard, or the admin token, is the admin's address and no person's.
  if (user.id === by.userId || user.email === by.email.trim().toLowerCase()) {
    throw new UserProblem(409, "not_yourself", "you cannot remove yourself");
  }
  await db.query(`UPDATE users SET removed_at = now() WHERE org_id = $1 AND id = $2`, [db.orgId, id]);
  // By person, and by address for tokens made before they were a user here.
  await db.query(
    `UPDATE tokens SET revoked_at = now()
     WHERE org_id = $1 AND revoked_at IS NULL AND role IN ('admin', 'member', 'viewer')
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
  // The number of times they allowed a repository again stays. A machine
  // keeps the number it last saw. Removing the row would start the next
  // allowance at 1 again, and a machine that was offline, and already saw
  // 1, would not send the sessions this delete removed. The next allowance
  // adds one, which that machine has not seen.
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
     WHERE org_id = $1 AND id = $2 RETURNING ${USER_COLUMNS}`,
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
  return userInfo(rows[0] ?? {});
}
