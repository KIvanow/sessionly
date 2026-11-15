// Access tokens. A token belongs to one person (an email) and has a role:
// a member uploads sessions and sees their own; an admin sees everyone's.
// Two roles are for machines: `ci` reports pull requests, and `env` uploads
// the sessions of a cloud agent's environment. Only a hash of each token is
// stored.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, OrgDb, Queryable } from "./db.ts";

import type { Role, TokenInfo } from "@sessionly/schema";

export type { Role, TokenInfo };

export interface Principal {
  /** The organisation the token belongs to. A request never names another. */
  orgId: string;
  email: string;
  name: string | null;
  role: Role;
  /** The token the request came with. Null for the admin token set in the environment. */
  tokenId: string | null;
  /** The person, if the token is tied to one: they signed in, or it is for their machines. */
  userId: string | null;
  /**
   * The request comes from someone who signed in with a link sent to
   * `email`, so the address is theirs. Any other token's address is what
   * whoever made the token typed.
   */
  viaEmail: boolean;
}

/** The one organisation of a self-hosted install. */
export const DEFAULT_ORG = "default";

/** An admin token set in the environment, for first use before any token exists. */
export interface Bootstrap {
  token: string;
  email: string;
}

/** The SHA-256 of a secret, which is all that is stored of one. */
export function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Whether two secrets are the same, taking as long to say no as to say yes. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}

export interface NewToken {
  email: string;
  name?: string | null;
  role: Role;
  /** The person it is tied to. Left out, a person of that address in the organisation is looked for. */
  userId?: string | null;
  /** Set for a token someone got by signing in, which also expires. */
  signIn?: "email";
  expiresAt?: Date;
}

/**
 * Store a new token for an organisation and return it. This is the only
 * time it is available in clear.
 */
export async function issueToken(
  db: Queryable,
  orgId: string,
  owner: NewToken,
): Promise<{ id: string; token: string }> {
  const token = `sly_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  await db.query(
    `INSERT INTO tokens (org_id, id, token_hash, email, name, role, user_id, sign_in, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
    [
      orgId,
      id,
      hash(token),
      owner.email.trim().toLowerCase(),
      owner.name ?? null,
      owner.role,
      owner.userId ?? null,
      owner.signIn ?? null,
      owner.expiresAt?.toISOString() ?? null,
    ],
  );
  return { id, token };
}

/**
 * Create a token in the request's organisation. A token for a person who is
 * a user there is tied to them, so that removing them stops it.
 */
export async function createToken(db: OrgDb, owner: NewToken): Promise<{ id: string; token: string }> {
  let userId = owner.userId;
  if (userId === undefined && (owner.role === "admin" || owner.role === "member")) {
    const [user] = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = $1 AND email = $2 AND removed_at IS NULL`,
      [db.orgId, owner.email.trim().toLowerCase()],
    );
    userId = user?.id ?? null;
  }
  return issueToken(db, db.orgId, { ...owner, userId });
}

/** The organisation's tokens. Sessions people got by signing in are not listed: they expire. */
export async function listTokens(db: OrgDb): Promise<TokenInfo[]> {
  return db.query<TokenInfo>(
    `SELECT id, email, name, role, created_at, last_used_at, revoked_at
     FROM tokens WHERE org_id = $1 AND sign_in IS NULL ORDER BY created_at`,
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
      return { orgId: DEFAULT_ORG, email: bootstrap.email, name: null, role: "admin", tokenId: null, userId: null, viaEmail: false };
    }
  }
  // The one question asked before an organisation is known, so as the
  // owner: which organisation is this token's? A token that was revoked or
  // has expired, or whose organisation is being deleted, is nobody's.
  const rows = await db.query<{
    id: string;
    org_id: string;
    email: string;
    name: string | null;
    role: Role;
    user_id: string | null;
    sign_in: string | null;
  }>(
    `UPDATE tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND EXISTS (SELECT 1 FROM orgs WHERE orgs.id = tokens.org_id AND orgs.deleted_at IS NULL)
       -- a person's token is nothing once they are removed, even one that
       -- was being issued at that very moment
       AND (tokens.user_id IS NULL OR EXISTS (
         SELECT 1 FROM users WHERE users.id = tokens.user_id AND users.removed_at IS NULL))
     RETURNING id, org_id, email, name, role, user_id, sign_in`,
    [digest],
  );
  const row = rows[0];
  return row
    ? {
        orgId: row.org_id,
        email: row.email,
        name: row.name,
        role: row.role,
        tokenId: row.id,
        userId: row.user_id,
        viaEmail: row.sign_in === "email",
      }
    : null;
}
