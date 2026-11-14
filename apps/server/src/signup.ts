// Signing in and signing up by email: the routes that are asked before
// anyone is known, so they see the database as its owner does. Nothing here
// reads or returns an organisation's data; it only hands out a token.
//
// A link carries a code in the part of the address after "#", which browsers
// do not send to servers, so it reaches no access log, and a mail scanner
// that opens links does not use it up. Only the code's hash is stored, and
// it works once.
import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { hash, issueToken, type Role } from "./auth.ts";
import type { Db, Queryable } from "./db.ts";
import { allowed } from "./limits.ts";
import { LINK_MINUTES, signInMail, signUpMail, type Mailer } from "./mail.ts";

/** How long a token from signing in lasts. */
export const SIGN_IN_DAYS = 7;

/** An address is asked about at most in this many organisations at once. */
const MAX_ORGS = 10;

export interface Accounts {
  /** Sends the links. Without one, people get in by token only. */
  mailer?: Mailer;
  /** Where the dashboard is reached, for the links: `https://app.example.com`. */
  publicUrl?: string;
  /** A service many organisations share: signing up creates one. */
  hosted?: boolean;
  /** Whether anyone may sign up (hosted only). */
  signup?: "open" | "off";
  /** If set, signing up needs this code as well: an invitation, or a waiting list. */
  signupCode?: string;
  /** The server is behind a proxy of its own, whose X-Forwarded-For can be believed. */
  trustProxy?: boolean;
  /** Requests a token may make a minute. Not counted if unset. */
  ratePerMinute?: number;
}

/** What the server offers someone who is not signed in. */
export function offers(accounts: Accounts) {
  const emailSignIn = Boolean(accounts.mailer && accounts.publicUrl);
  return {
    hosted: accounts.hosted === true,
    emailSignIn,
    signup: emailSignIn && accounts.hosted === true && accounts.signup !== "off",
    inviteCode: Boolean(accounts.signupCode),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Who is asking, as far as it can be told: for counting, not for trusting. */
export function clientAddress(c: Context, trustProxy: boolean | undefined): string {
  if (trustProxy) {
    // The last hop is the one the proxy added itself.
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim());
    const last = hops.filter(Boolean).at(-1);
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** `Acme, Inc.` becomes `acme-inc-x7k2p9`: readable, and never taken. */
export function orgIdFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    // accents come apart from their letters: drop them, keep the letters
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const tail = Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
  return `${slug || "org"}-${tail}`;
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `usr_` and 14 characters. */
export function newUserId(): string {
  return `usr_${Array.from(randomBytes(14), (byte) => ALPHABET[byte % ALPHABET.length]).join("")}`;
}

/** Store a code for a link and return the link. */
export async function newLink(
  db: Queryable,
  publicUrl: string,
  code: { purpose: "sign_in"; userId: string } | { purpose: "signup"; email: string; orgName: string },
): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO login_codes (code_hash, purpose, user_id, email, org_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int))`,
    [
      hash(secret),
      code.purpose,
      code.purpose === "sign_in" ? code.userId : null,
      code.purpose === "signup" ? code.email : null,
      code.purpose === "signup" ? code.orgName : null,
      LINK_MINUTES,
    ],
  );
  return `${publicUrl.replace(/\/+$/, "")}/#login=${secret}`;
}

/** The token role someone signs in with: an owner can do what an admin can. */
function tokenRole(userRole: string): Role {
  return userRole === "member" ? "member" : "admin";
}

interface SignedIn {
  token: string;
  org: { id: string; name: string };
  email: string;
  role: Role;
  expires_at: string;
  /** True if this link created the organisation. */
  created: boolean;
}

async function signIn(
  db: Queryable,
  user: { id: string; org_id: string; org_name: string; email: string; role: string },
  created: boolean,
): Promise<SignedIn> {
  const expiresAt = new Date(Date.now() + SIGN_IN_DAYS * 86_400_000);
  const role = tokenRole(user.role);
  const { token } = await issueToken(db, user.org_id, {
    email: user.email,
    role,
    userId: user.id,
    signIn: "email",
    expiresAt,
  });
  return {
    token,
    org: { id: user.org_id, name: user.org_name },
    email: user.email,
    role,
    expires_at: expiresAt.toISOString(),
    created,
  };
}

/** The routes under /api/v1/auth that need no token. */
export function openRoutes(db: Db, accounts: Accounts): Hono {
  const open = new Hono();
  const { mailer, publicUrl } = accounts;
  const tooMany = (c: Context) => c.json({ error: "too many requests; try again in a minute", code: "rate_limited" }, 429);
  const perMinute = async (c: Context, what: string, max: number) =>
    allowed(db, `${what}:${clientAddress(c, accounts.trustProxy)}`, 60, max);
  /** A mail is sent without making the answer wait for it, or depend on it. */
  const post = (mail: ReturnType<typeof signInMail>) => {
    mailer?.send(mail).catch((err: unknown) => {
      console.error(`email to ${mail.to.replace(/^[^@]*/, "…")} was not sent:`, err instanceof Error ? err.message : err);
    });
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  open.get("/options", (c) => c.json(offers(accounts)));

  // Ask for a link to sign in. The answer is the same whether or not the
  // address is anyone's.
  open.post("/email", async (c) => {
    if (!mailer || !publicUrl) return c.json({ error: "signing in by email is not set up here", code: "no_email" }, 404);
    if (!(await perMinute(c, "auth-email", 5))) return tooMany(c);
    const email = text((await body(c)).email).toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return c.json({ error: "that is not an email address" }, 400);
    if (await allowed(db, `links:${email}`, 3600, 5)) {
      const users = await db.query<{ id: string; org_name: string }>(
        `SELECT u.id, o.name AS org_name FROM users u JOIN orgs o ON o.id = u.org_id
         WHERE u.email = $1 AND u.removed_at IS NULL AND o.deleted_at IS NULL
         ORDER BY u.created_at LIMIT ${MAX_ORGS}`,
        [email],
      );
      const links = [];
      for (const user of users) {
        links.push({ org: user.org_name, url: await newLink(db, publicUrl, { purpose: "sign_in", userId: user.id }) });
      }
      if (links.length) post(signInMail(email, links));
    }
    return c.json({ ok: true }, 202);
  });

  // Ask to create an organisation. Nothing is created until the link is
  // used, so an address nobody confirms leaves nothing behind.
  open.post("/signup", async (c) => {
    const offered = offers(accounts);
    if (!offered.signup || !mailer || !publicUrl) {
      return c.json({ error: "signing up is not open here", code: "signup_closed" }, 403);
    }
    if (!(await perMinute(c, "auth-email", 5))) return tooMany(c);
    const sent = await body(c);
    const email = text(sent.email).toLowerCase();
    const orgName = text(sent.org_name).replace(/\s+/g, " ");
    if (!EMAIL.test(email) || email.length > 254) return c.json({ error: "that is not an email address" }, 400);
    if (!orgName || orgName.length > 80) {
      return c.json({ error: "the organisation needs a name of at most 80 characters" }, 400);
    }
    if (accounts.signupCode && text(sent.invite_code) !== accounts.signupCode) {
      return c.json({ error: "signing up needs an invitation code", code: "invite_required" }, 403);
    }
    if (await allowed(db, `links:${email}`, 3600, 5)) {
      post(signUpMail(email, orgName, await newLink(db, publicUrl, { purpose: "signup", email, orgName })));
    }
    return c.json({ ok: true }, 202);
  });

  // Use a link: once, and only before it runs out.
  open.post("/verify", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const code = text((await body(c)).code);
    const invalid = () => c.json({ error: "this link is not valid any more; ask for a new one", code: "invalid_code" }, 400);
    if (!code || code.length > 200) return invalid();
    const signed = await db.transaction(async (tx) => {
      const [found] = await tx.query<{
        purpose: string;
        user_id: string | null;
        email: string | null;
        org_name: string | null;
      }>(`DELETE FROM login_codes WHERE code_hash = $1 AND expires_at > now() RETURNING purpose, user_id, email, org_name`, [
        hash(code),
      ]);
      if (!found) return null;
      if (found.purpose === "sign_in") {
        const [user] = await tx.query<{ id: string; org_id: string; org_name: string; email: string; role: string }>(
          `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.role FROM users u JOIN orgs o ON o.id = u.org_id
           WHERE u.id = $1 AND u.removed_at IS NULL AND o.deleted_at IS NULL`,
          [found.user_id],
        );
        return user ? signIn(tx, user, false) : null;
      }
      // Signing up: the organisation, its owner and their token, or none of them.
      if (!found.email || !found.org_name || !offers(accounts).signup) return null;
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('sessionly-signup'))`);
      let orgId = orgIdFor(found.org_name);
      while ((await tx.query(`SELECT 1 FROM orgs WHERE id = $1`, [orgId])).length) orgId = orgIdFor(found.org_name);
      await tx.query(`INSERT INTO orgs (id, name) VALUES ($1, $2)`, [orgId, found.org_name]);
      const user = { id: newUserId(), org_id: orgId, org_name: found.org_name, email: found.email, role: "owner" };
      await tx.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, $3, $4)`, [
        user.id,
        user.org_id,
        user.email,
        user.role,
      ]);
      return signIn(tx, user, true);
    });
    return signed ? c.json(signed) : invalid();
  });

  return open;
}
