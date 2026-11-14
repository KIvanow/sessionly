// Signing in and signing up by email: the routes that are asked before
// anyone is known, so they see the database as its owner does. Nothing here
// reads or returns an organisation's data; it only hands out a token.
//
// A link carries a code in the part of the address after "#", which browsers
// do not send to servers, so it reaches no access log, and a mail scanner
// that opens links does not use it up. Only the code's hash is stored, and
// it works once.
import { randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { hash, issueToken, sameSecret, type Role } from "./auth.ts";
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
  /** Links to finish signing up sent an hour, to everyone together. Default 100. */
  signupsPerHour?: number;
  /**
   * Runs work an answer does not wait for: looking an address up and sending
   * it a link. That way an answer takes as long for an address nobody has as
   * for one somebody has. Tests give their own, to wait for the work.
   */
  defer?: (work: () => Promise<void>) => void;
}

/** A request to these routes is an address and a name: this is plenty. */
const MAX_BODY_BYTES = 16 * 1024;

/** Links one address is sent an hour, for each thing it can be sent a link for. */
export const LINKS_PER_HOUR = 5;

/**
 * What an organisation may be called: 2 to 60 letters, digits, spaces and a
 * little punctuation. No dot, slash, colon or @: the name is shown to people
 * in messages, and it must not be able to carry a link or an address.
 */
export const ORG_NAME = /^[\p{L}\p{N}][\p{L}\p{N} &',()+-]{1,59}$/u;
export const ORG_NAME_RULE = "an organisation's name is 2 to 60 letters, digits, spaces and any of & ' , ( ) + -";

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

/**
 * What to count an address under. One IPv4 address is one caller. An IPv6
 * caller usually has a whole /64 to pick addresses from, so its network is
 * what is counted.
 */
export function network(address: string): string {
  const plain = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  // An IPv4 address written as IPv6.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (!isIPv6(plain)) return plain;
  const [head = "", tail] = plain.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  const first = groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
  return `${first.join(":")}::/64`;
}

/** Who is asking, as far as it can be told: for counting, not for trusting. */
export function clientAddress(c: Context, trustProxy: boolean | undefined): string {
  if (trustProxy) {
    // The last hop is the one the proxy added itself.
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim());
    const last = hops.filter(Boolean).at(-1);
    if (last) return network(last);
  }
  try {
    return network(getConnInfo(c).remote.address ?? "unknown");
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
  const failed = (what: string) => (err: unknown) => console.error(`${what}:`, err instanceof Error ? err.message : err);
  const defer = accounts.defer ?? ((work) => void work().catch(failed("work after an answer failed")));
  const send = async (mail: ReturnType<typeof signInMail>) => {
    // Named by its domain only: neither the address nor the link is logged.
    await mailer?.send(mail).catch(failed(`email to …${mail.to.replace(/^[^@]*/, "")} was not sent`));
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  // Nobody here is known yet, so nothing large is read from them.
  open.use(
    "*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "the request is too large" }, 413) }),
  );

  open.get("/options", (c) => c.json(offers(accounts)));

  // Ask for a link to sign in. The answer is the same, and as quick, whether
  // or not the address is anyone's: what follows it is not waited for.
  open.post("/email", async (c) => {
    if (!mailer || !publicUrl) return c.json({ error: "signing in by email is not set up here", code: "no_email" }, 404);
    if (!(await perMinute(c, "auth-email", 5))) return tooMany(c);
    const email = text((await body(c)).email).toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return c.json({ error: "that is not an email address" }, 400);
    defer(async () => {
      const users = await db.query<{ id: string; org_name: string }>(
        `SELECT u.id, o.name AS org_name FROM users u JOIN orgs o ON o.id = u.org_id
         WHERE u.email = $1 AND u.removed_at IS NULL AND o.deleted_at IS NULL
         ORDER BY u.created_at LIMIT ${MAX_ORGS}`,
        [email],
      );
      // Counted only when a message would go out, and apart from the links
      // for signing up: asking in someone's name cannot use theirs up.
      if (!users.length || !(await allowed(db, `signin:${email}`, 3600, LINKS_PER_HOUR))) return;
      const links = [];
      for (const user of users) {
        links.push({ org: user.org_name, url: await newLink(db, publicUrl, { purpose: "sign_in", userId: user.id }) });
      }
      await send(signInMail(email, links));
    });
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
    if (!ORG_NAME.test(orgName)) return c.json({ error: ORG_NAME_RULE, code: "bad_org_name" }, 400);
    if (accounts.signupCode && !sameSecret(text(sent.invite_code), accounts.signupCode)) {
      return c.json({ error: "signing up needs an invitation code", code: "invite_required" }, 403);
    }
    // These messages go to addresses nobody has confirmed. However many
    // addresses they are asked from, there is a ceiling on them all.
    if (!(await allowed(db, "signups", 3600, accounts.signupsPerHour ?? 100))) {
      return c.json({ error: "too many people are signing up right now; try again in an hour", code: "signups_busy" }, 429);
    }
    defer(async () => {
      if (!(await allowed(db, `signup:${email}`, 3600, LINKS_PER_HOUR))) return;
      await send(signUpMail(email, await newLink(db, publicUrl, { purpose: "signup", email, orgName })));
    });
    return c.json({ ok: true }, 202);
  });

  // What a link is for, without using it: the dashboard asks before it does,
  // so that a link someone was sent does not sign them in to wherever its
  // sender chose without their seeing where.
  open.post("/check", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const code = text((await body(c)).code);
    const invalid = () => c.json({ error: "this link is not valid any more; ask for a new one", code: "invalid_code" }, 400);
    if (!code || code.length > 200) return invalid();
    const [found] = await db.query<{ purpose: string; email: string | null; org_name: string | null }>(
      `SELECT c.purpose, coalesce(u.email, c.email) AS email, coalesce(o.name, c.org_name) AS org_name
       FROM login_codes c
       LEFT JOIN users u ON u.id = c.user_id AND u.removed_at IS NULL
       LEFT JOIN orgs o ON o.id = u.org_id AND o.deleted_at IS NULL
       WHERE c.code_hash = $1 AND c.expires_at > now()`,
      [hash(code)],
    );
    if (!found?.email || !found.org_name) return invalid();
    if (found.purpose === "signup" && !offers(accounts).signup) return invalid();
    return c.json({ purpose: found.purpose, email: found.email, org_name: found.org_name });
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
