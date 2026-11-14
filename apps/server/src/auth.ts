// Access tokens. A token belongs to one person (an email) and has a role:
// a member uploads sessions and sees their own; an admin sees everyone's.
// Two roles are for machines: `ci` reports pull requests, and `env` uploads
// the sessions of a cloud agent's environment. Only a hash of each token is
// stored.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";

import type { Role, TokenInfo } from "@sessionly/schema";

export type { Role, TokenInfo };

export interface Principal {
  email: string;
  name: string | null;
  role: Role;
}

/** An admin token set in the environment, for first use before any token exists. */
export interface Bootstrap {
  token: string;
  email: string;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a token and return it. This is the only time it is available in clear. */
export async function createToken(
  db: Db,
  owner: { email: string; name?: string | null; role: Role },
): Promise<{ id: string; token: string }> {
  const token = `sly_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  await db.query(
    `INSERT INTO tokens (id, token_hash, email, name, role) VALUES ($1, $2, $3, $4, $5)`,
    [id, hash(token), owner.email.trim().toLowerCase(), owner.name ?? null, owner.role],
  );
  return { id, token };
}

export async function listTokens(db: Db): Promise<TokenInfo[]> {
  return db.query<TokenInfo>(
    `SELECT id, email, name, role, created_at, last_used_at, revoked_at
     FROM tokens ORDER BY created_at`,
  );
}

/** Returns false if there is no such active token. */
export async function revokeToken(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id],
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
      return { email: bootstrap.email, name: null, role: "admin" };
    }
  }
  const rows = await db.query<Principal>(
    `UPDATE tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING email, name, role`,
    [digest],
  );
  return rows[0] ?? null;
}
