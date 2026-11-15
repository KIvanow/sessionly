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
import { domainToASCII } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { hash, issueToken, sameSecret, type Role } from "./auth.ts";
import type { Db, Queryable } from "./db.ts";
import { allowed, giveBack } from "./limits.ts";
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
  /** Sign-ups asked for an hour from one network (a /24, or a /48 of IPv6). Default 10. */
  signupsPerNetwork?: number;
  /**
   * Runs work an answer does not wait for: looking an address up and sending
   * it a link. That way an answer takes as long for an address nobody has as
   * for one somebody has. Tests give their own, to wait for the work.
   */
  defer?: (work: () => Promise<void>) => void;
}

/** A request to these routes is an address and a name: this is plenty. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Links one mailbox is sent an hour to finish signing up, and as many again
 * on being added to organisations. Counted when a message goes out, not when
 * one is asked for.
 */
export const LINKS_PER_HOUR = 5;

/**
 * Messages one mailbox is sent an hour to sign in. One address cannot reach
 * this on its own, since no second link is sent while one still works (four
 * an hour at most); it is for addresses that all lead to one mailbox.
 */
const SIGN_IN_MAILS_PER_HOUR = 12;

/**
 * Sign-ups asked for an hour from one network (a /24, or a /48 of IPv6),
 * unless set otherwise. An office or a phone network shares one, so this is
 * not tight; it is there so that one place cannot ask for them all.
 */
const SIGNUPS_PER_NETWORK = 10;

/**
 * What an organisation may be called: 2 to 60 letters, digits, spaces and a
 * little punctuation. No dot, slash, colon or @: the name is shown to people,
 * and it must not be able to carry a link or an address. Letters may carry
 * the marks their script writes them with (accents, vowel signs), three in a
 * row at most.
 */
const ORG_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &',()+-]{1,59}$/u;
export const ORG_NAME_RULE =
  "an organisation's name is 2 to 60 letters, digits, spaces and any of & ' , ( ) + - (plain letters, not styled forms of them)";

/**
 * The name as it is kept, or null if it may not be one. Composed (NFC), so
 * that a name typed with separate accents is the same name as one typed
 * without. A letter that is a styled form of another (fullwidth, mathematical,
 * circled) is refused: it reads as the plain letter and is not it, which is
 * how one organisation's name is made to look like another's.
 */
export function orgNameFrom(typed: string): string | null {
  const name = typed.trim().replace(/\s+/g, " ").normalize("NFC");
  if (!ORG_NAME.test(name) || /\p{M}{4}/u.test(name)) return null;
  // Thai and Lao write one vowel (sara am) with a letter that the
  // compatibility form takes apart; it is no one's lookalike.
  const plain = name.replace(/[\u0E33\u0EB3]/g, "");
  return plain.normalize("NFKC") === plain ? name : null;
}

/**
 * The mailbox an address leads to, for counting what is sent there: without
 * a "+tag", and for Gmail without the dots it ignores. Messages still go to
 * the address as it was typed.
 */
export function mailbox(email: string): string {
  const at = email.lastIndexOf("@");
  const typed = email.slice(0, at).toLowerCase();
  let domain = email.slice(at + 1).toLowerCase();
  let local = typed.split("+")[0] || typed;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "") || local;
  return `${local}@${domain}`;
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
  const domain = domainToASCII(text.slice(at + 1).replace(/\.$/, "")).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  const email = `${local}@${domain}`;
  return email.length <= 254 ? email : null;
}

/** The groups of an IPv6 address, written out; null for anything else. */
function groupsOf(address: string): string[] | null {
  if (!isIPv6(address)) return null;
  const [head = "", tail] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
}

/** An address as it is compared: no brackets or zone, and an IPv4 address written as IPv6 as IPv4. */
function plainAddress(address: string): string {
  const plain = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)?.[1];
  return mapped && isIPv4(mapped) ? mapped : plain;
}

/**
 * What to count an address under. One IPv4 address is one caller. An IPv6
 * caller usually has a whole /64 to pick addresses from, so its network is
 * what is counted.
 */
export function network(address: string): string {
  const plain = plainAddress(address);
  const groups = groupsOf(plain);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : plain;
}

/**
 * The wider network an address is in, for what is counted by the hour: a /24
 * of IPv4, and the /48 a site is usually given of IPv6.
 */
export function widerNetwork(address: string): string {
  const plain = plainAddress(address);
  const groups = groupsOf(plain);
  if (groups) return `${groups.slice(0, 3).join(":")}::/48`;
  return isIPv4(plain) ? `${plain.split(".").slice(0, 3).join(".")}.0/24` : plain;
}

/** Who is asking, as far as it can be told: for counting, not for trusting. */
function callerOf(c: Context, trustProxy: boolean | undefined): string {
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

/** Store a code for a link. Returns the link, and what it is kept under, to forget it by. */
export async function newLink(
  db: Queryable,
  publicUrl: string,
  code: { purpose: "sign_in" | "invite"; userId: string } | { purpose: "signup"; email: string; orgName: string },
): Promise<{ url: string; code: string }> {
  const secret = randomBytes(32).toString("base64url");
  const kept = hash(secret);
  await db.query(
    `INSERT INTO login_codes (code_hash, purpose, user_id, email, org_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int))`,
    [
      kept,
      code.purpose,
      code.purpose === "signup" ? null : code.userId,
      code.purpose === "signup" ? code.email : null,
      code.purpose === "signup" ? code.orgName : null,
      LINK_MINUTES,
    ],
  );
  return { url: `${publicUrl.replace(/\/+$/, "")}/#login=${secret}`, code: kept };
}

/**
 * A message was not sent. Its links are forgotten and it does not count as
 * one that went out: left as they were, a link nobody received would hold
 * back the next one for as long as it "still worked", and the hour's
 * allowance would be spent on nothing.
 */
export async function unsend(db: Queryable, links: { code: string }[], counters: string[]): Promise<void> {
  await db.query(`DELETE FROM login_codes WHERE code_hash = ANY($1::text[])`, [links.map((link) => link.code)]);
  for (const key of counters) await giveBack(db, key, 3600);
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
    allowed(db, `${what}:${network(callerOf(c, accounts.trustProxy))}`, 60, max);
  const failed = (what: string) => (err: unknown) => console.error(`${what}:`, err instanceof Error ? err.message : err);
  const defer = accounts.defer ?? ((work) => void work().catch(failed("work after an answer failed")));
  // Named by its domain only: neither the address nor the link is logged.
  const notSent = (to: string, err: unknown) => failed(`email to …${to.replace(/^[^@]*/, "")} was not sent`)(err);
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
    const email = emailFrom((await body(c)).email);
    if (!email) return c.json({ error: "that is not an email address" }, 400);
    defer(async () => {
      const users = await db.query<{ id: string; org_name: string; known: boolean; waiting: boolean }>(
        `SELECT u.id, o.name AS org_name, u.confirmed_at IS NOT NULL AS known,
                EXISTS (SELECT 1 FROM login_codes c
                        WHERE c.user_id = u.id AND c.purpose = 'sign_in' AND c.expires_at > now()) AS waiting
         FROM users u JOIN orgs o ON o.id = u.org_id
         WHERE u.email = $1 AND u.removed_at IS NULL AND o.deleted_at IS NULL
         ORDER BY u.created_at LIMIT ${MAX_ORGS}`,
        [email],
      );
      // A link that was asked for and still works is in their inbox, and no
      // second one is sent. So asking in someone's name gets them one message
      // per quarter of an hour at most, and never leaves them without a link
      // that works: there is no allowance of theirs for it to use up.
      const due = users.filter((user) => !user.waiting);
      if (!due.length) return;
      // An address whose owner has signed in with it has an allowance of its
      // own. Addresses nobody has confirmed share their mailbox's: anyone
      // can add `ann+1@`, `ann+2@` and so on to an organisation of theirs
      // and ask for links to them all, and that must not use up Ann's.
      const counter = users.some((user) => user.known) ? `signin-own:${email}` : `signin:${mailbox(email)}`;
      if (!(await allowed(db, counter, 3600, SIGN_IN_MAILS_PER_HOUR))) return;
      const links = [];
      for (const user of due) {
        links.push({
          // The name of an organisation they have never signed in to is
          // whatever someone who added them chose: it is not passed on.
          org: user.known ? user.org_name : null,
          ...(await newLink(db, publicUrl, { purpose: "sign_in", userId: user.id })),
        });
      }
      try {
        await mailer.send(signInMail(email, links));
      } catch (err) {
        notSent(email, err);
        await unsend(db, links, [counter]);
      }
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
    const email = emailFrom(sent.email);
    const orgName = orgNameFrom(text(sent.org_name));
    if (!email) return c.json({ error: "that is not an email address" }, 400);
    if (!orgName) return c.json({ error: ORG_NAME_RULE, code: "bad_org_name" }, 400);
    if (accounts.signupCode && !sameSecret(text(sent.invite_code), accounts.signupCode)) {
      return c.json({ error: "signing up needs an invitation code", code: "invite_required" }, 403);
    }
    // By the hour too, and by a wider network than the minute's: what one
    // caller can ask for is their own to use up, and no one else's.
    if (!(await allowed(db, `signups-from:${widerNetwork(callerOf(c, accounts.trustProxy))}`, 3600, accounts.signupsPerNetwork ?? SIGNUPS_PER_NETWORK))) {
      return c.json({ error: "too many sign-ups from your network; try again in an hour", code: "rate_limited" }, 429);
    }
    // From here on only messages that really go out are counted. First the
    // mailbox's own: past it nothing is sent, and the answer stays the same.
    const perMailbox = `signup:${mailbox(email)}`;
    if (!(await allowed(db, perMailbox, 3600, LINKS_PER_HOUR))) return c.json({ ok: true }, 202);
    // These messages go to addresses nobody has confirmed. However many
    // addresses and networks they are asked from, there is a ceiling on them
    // all. Asking again for one address does not come this far, so it cannot
    // be reached that way.
    if (!(await allowed(db, "signups", 3600, accounts.signupsPerHour ?? 100))) {
      await giveBack(db, perMailbox, 3600);
      // Said once an hour: someone should look at who is signing up.
      if (await allowed(db, "signups-warned", 3600, 1)) {
        console.warn(
          `The ceiling of ${accounts.signupsPerHour ?? 100} sign-up messages an hour is reached: no more are sent until the hour is over (SESSIONLY_SIGNUPS_PER_HOUR).`,
        );
      }
      return c.json({ error: "too many people are signing up right now; try again in an hour", code: "signups_busy" }, 429);
    }
    defer(async () => {
      const link = await newLink(db, publicUrl, { purpose: "signup", email, orgName });
      try {
        await mailer.send(signUpMail(email, link.url));
      } catch (err) {
        notSent(email, err);
        await unsend(db, [link], [perMailbox, "signups"]);
      }
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
    const [found] = await db.query<{
      purpose: string;
      email: string | null;
      org_name: string | null;
      org_id: string | null;
      invited_by: string | null;
      invited_via: string | null;
      first_time: boolean;
    }>(
      `SELECT c.purpose, coalesce(u.email, c.email) AS email, coalesce(o.name, c.org_name) AS org_name,
              o.id AS org_id, u.invited_by, u.invited_via, u.confirmed_at IS NULL AS first_time
       FROM login_codes c
       LEFT JOIN users u ON u.id = c.user_id AND u.removed_at IS NULL
       LEFT JOIN orgs o ON o.id = u.org_id AND o.deleted_at IS NULL
       WHERE c.code_hash = $1 AND c.expires_at > now()`,
      [hash(code)],
    );
    if (!found?.email || !found.org_name) return invalid();
    if (found.purpose === "signup" && !offers(accounts).signup) return invalid();
    // A name is not enough to tell an organisation by: anyone can make
    // another of the same name. So also its id, which is its own, and for
    // someone who has not signed in to it before, who added them: if that
    // was a person who had signed in, whose address is then theirs. Someone
    // added with a token is told that much and no address, since a token's
    // address and name are whatever its maker typed.
    const signup = found.purpose === "signup";
    const unknown = !signup && found.first_time;
    return c.json({
      purpose: found.purpose,
      email: found.email,
      org_name: found.org_name,
      org_id: found.org_id,
      first_time: unknown,
      invited_by: unknown && found.invited_via === "sign_in" ? found.invited_by : null,
      invited_via: unknown ? found.invited_via : null,
    });
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
      if (found.purpose !== "signup") {
        const [user] = await tx.query<{ id: string; org_id: string; org_name: string; email: string; role: string }>(
          `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.role FROM users u JOIN orgs o ON o.id = u.org_id
           WHERE u.id = $1 AND u.removed_at IS NULL AND o.deleted_at IS NULL`,
          [found.user_id],
        );
        if (!user) return null;
        await tx.query(`UPDATE users SET confirmed_at = now() WHERE id = $1 AND confirmed_at IS NULL`, [user.id]);
        return signIn(tx, user, false);
      }
      // Signing up: the organisation, its owner and their token, or none of them.
      if (!found.email || !found.org_name || !offers(accounts).signup) return null;
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('sessionly-signup'))`);
      let orgId = orgIdFor(found.org_name);
      while ((await tx.query(`SELECT 1 FROM orgs WHERE id = $1`, [orgId])).length) orgId = orgIdFor(found.org_name);
      await tx.query(`INSERT INTO orgs (id, name) VALUES ($1, $2)`, [orgId, found.org_name]);
      const user = { id: newUserId(), org_id: orgId, org_name: found.org_name, email: found.email, role: "owner" };
      await tx.query(`INSERT INTO users (id, org_id, email, role, confirmed_at) VALUES ($1, $2, $3, $4, now())`, [
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
