// Access tokens. A token belongs to one person (an email) and has a role:
// a member uploads sessions and sees their own; an admin sees everyone's.
// Two roles are for machines: `ci` reports pull requests, and `env` uploads
// the sessions of a cloud agent's environment. Only a hash of each token is
// stored.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, OrgDb } from "./db.ts";

import type { Role, TokenInfo } from "@sessionly/schema";

export type { Role, TokenInfo };

export interface Principal {
  /** The organisation the token belongs to. A request never names another. */
  orgId: string;
  email: string;
  name: string | null;
  role: Role;
}

/** The one organisation of a self-hosted install. */
export const DEFAULT_ORG = "default";

/** An admin token set in the environment, for first use before any token exists. */
export interface Bootstrap {
  token: string;
  email: string;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a token in the organisation and return it. This is the only time it is available in clear. */
export async function createToken(
  db: OrgDb,
  owner: { email: string; name?: string | null; role: Role },
): Promise<{ id: string; token: string }> {
  const token = `sly_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  await db.query(
    `INSERT INTO tokens (org_id, id, token_hash, email, name, role) VALUES ($1, $2, $3, $4, $5, $6)`,
    [db.orgId, id, hash(token), owner.email.trim().toLowerCase(), owner.name ?? null, owner.role],
  );
  return { id, token };
}

/** The organisation's tokens. */
export async function listTokens(db: OrgDb): Promise<TokenInfo[]> {
  return db.query<TokenInfo>(
    `SELECT id, email, name, role, created_at, last_used_at, revoked_at
     FROM tokens WHERE org_id = $1 ORDER BY created_at`,
    [db.orgId],
  );
}

/** Returns false if the organisation has no such active token. */
export async function revokeToken(db: OrgDb, id: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE tokens SET revoked_at = now()
     WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`,
    [db.orgId, id],
  );
  return rows.length > 0;
}

/** Who a request is from, given its Authorization header. Null if nobody we know. */
export async function authenticate(
  db: Db,
  header: string | undefined,
  bootstrap?: Bootstrap,
): Promise<Principal | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!token) return null;
  const digest = hash(token);
  if (bootstrap?.token) {
    const expected = Buffer.from(hash(bootstrap.token));
    if (timingSafeEqual(Buffer.from(digest), expected)) {
      return { orgId: DEFAULT_ORG, email: bootstrap.email, name: null, role: "admin" };
    }
  }
  // The one question asked before an organisation is known, so as the
  // owner: which organisation is this token's? A token that was revoked or
  // has expired, or whose organisation is being deleted, is nobody's.
  const rows = await db.query<{ org_id: string; email: string; name: string | null; role: Role }>(
    `UPDATE tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND EXISTS (SELECT 1 FROM orgs WHERE orgs.id = tokens.org_id AND orgs.deleted_at IS NULL)
     RETURNING org_id, email, name, role`,
    [digest],
  );
  const row = rows[0];
  return row ? { orgId: row.org_id, email: row.email, name: row.name, role: row.role } : null;
}
