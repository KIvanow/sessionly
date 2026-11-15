// Signing in and signing up with Google or GitHub: the routes that are asked
// before anyone is known, so they see the database as its owner does.
// Nothing here reads or returns an organisation's data; it only hands out a
// token.
//
// The browser is sent to the provider and comes back with the provider's
// answer. What the provider says of the person (which addresses are theirs)
// is kept for a few minutes under a code, and the dashboard is handed the
// code in the part of the address after "#", which browsers do not send to
// servers, so it reaches no access log. Only the code's hash is stored, and
// it works once.
import { randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { domainToASCII } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { hash, issueToken, sameSecret, type Role } from "./auth.ts";
import type { Db, Queryable } from "./db.ts";
import { allowed, giveBack, take, type Taken } from "./limits.ts";
import { challengeOf, PROVIDER_NAMES, type Provider, type ProviderName } from "./oauth.ts";

/** How long a token from signing in lasts. */
export const SIGN_IN_DAYS = 7;

/** Someone is shown at most this many organisations to sign in to. */
const MAX_ORGS = 10;

/** At most this many of the addresses a provider vouches for are looked at. */
const MAX_ADDRESSES = 20;

/** How long someone may take at the provider before coming back. */
const AWAY_MINUTES = 10;

/** How long the code the dashboard is handed works: long enough to choose an organisation, or name a new one. */
export const CODE_MINUTES = 10;

export interface Accounts {
  /** The ways of signing in that are set up. Without one, people get in by token only. */
  providers?: Provider[];
  /** Where the dashboard is reached, which is also where a provider sends people back: `https://app.example.com`. */
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
  /** Organisations created an hour, by everyone together. Default 100. */
  signupsPerHour?: number;
  /** Organisations created an hour from one network (a /24, or a /48 of IPv6). Default 10. */
  signupsPerNetwork?: number;
}

/** A request to these routes is a code and a name: this is plenty. */
const MAX_BODY_BYTES = 16 * 1024;

/** Organisations one address may create an hour. */
export const ORGS_PER_ADDRESS = 5;

/**
 * Organisations created an hour from one network (a /24, or a /48 of IPv6),
 * unless set otherwise. An office or a phone network shares one, so this is
 * not tight; it is there so that one place cannot create them all.
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

/** What the server offers someone who is not signed in. */
export function offers(accounts: Accounts) {
  // A provider sends people back to the public address: without one there is nowhere to come back to.
  const providers = accounts.publicUrl ? (accounts.providers ?? []).map((provider) => provider.name) : [];
  return {
    hosted: accounts.hosted === true,
    providers,
    signup: providers.length > 0 && accounts.hosted === true && accounts.signup !== "off",
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

/** Keep what a provider said of someone who has just come back from it. Returns the code the dashboard is handed. */
async function arrived(db: Queryable, provider: ProviderName, emails: string[]): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sign_in_codes (code_hash, provider, emails, expires_at)
     VALUES ($1, $2, $3::text[], now() + make_interval(mins => $4::int))`,
    [hash(secret), provider, emails, CODE_MINUTES],
  );
  return secret;
}

/** An organisation someone can sign in to, as the page that asks them shows it. */
interface Membership {
  user_id: string;
  org_id: string;
  org_name: string;
  /** The address they are in it under: one of those the provider vouched for. */
  email: string;
  /** They have not signed in to it before. */
  first_time: boolean;
  invited_by: string | null;
  invited_via: string | null;
}

/**
 * Where the holder of these addresses can sign in. Organisations they have
 * signed in to come first: anyone can add anyone's address to an
 * organisation of their own, and being added to many must not push out of
 * the list the ones a person is really in.
 */
async function membershipsOf(db: Queryable, emails: string[]): Promise<Membership[]> {
  const rows = await db.query<Membership>(
    `SELECT u.id AS user_id, u.org_id, o.name AS org_name, u.email, u.confirmed_at IS NULL AS first_time,
            u.invited_by, u.invited_via
     FROM users u JOIN orgs o ON o.id = u.org_id
     WHERE u.email = ANY($1::text[]) AND u.removed_at IS NULL AND o.deleted_at IS NULL
     ORDER BY u.confirmed_at IS NULL, u.created_at, u.id LIMIT ${MAX_ORGS}`,
    [emails],
  );
  // A name is not enough to tell an organisation by: anyone can make
  // another of the same name. So also its id, which is its own, and for
  // someone who has not signed in to it before, who added them: if that
  // was a person who had signed in, whose address is then theirs. Someone
  // added with a token is told that much and no address, since a token's
  // address and name are whatever its maker typed.
  return rows.map((row) => ({
    ...row,
    invited_by: row.first_time && row.invited_via === "sign_in" ? row.invited_by : null,
    invited_via: row.first_time ? row.invited_via : null,
  }));
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
  /** True if this created the organisation. */
  created: boolean;
}

async function signIn(
  db: Queryable,
  user: { id: string; org_id: string; org_name: string; email: string; role: string },
  provider: ProviderName,
  created: boolean,
): Promise<SignedIn> {
  const expiresAt = new Date(Date.now() + SIGN_IN_DAYS * 86_400_000);
  const role = tokenRole(user.role);
  const { token } = await issueToken(db, user.org_id, {
    email: user.email,
    role,
    userId: user.id,
    signIn: provider,
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

/**
 * Why someone who went to a provider is back without having signed in. The
 * dashboard has the words for each; nothing a provider or a caller wrote is
 * passed on to be shown.
 */
type Problem =
  /** They said no at the provider. */
  | "refused"
  /** This browser did not start this, or started it too long ago. */
  | "not_started"
  /** The provider did not answer, or not with what was asked. */
  | "provider"
  /** The provider vouches for no address of theirs. */
  | "no_address"
  | "busy";

/** The routes under /api/v1/auth that need no token. */
export function openRoutes(db: Db, accounts: Accounts): Hono {
  const open = new Hono();
  const home = accounts.publicUrl?.replace(/\/+$/, "");
  const secure = home?.startsWith("https://") === true;
  // Under this name a browser takes the cookie only from this very host,
  // over HTTPS: a neighbouring site of the same domain cannot plant one.
  const cookie = secure ? "__Host-sessionly-signin" : "sessionly-signin";
  const providerOf = (name: ProviderName) => (home ? accounts.providers?.find((provider) => provider.name === name) : undefined);
  const redirectUri = (provider: ProviderName) => `${home}/api/v1/auth/${provider}/callback`;
  const tooMany = (c: Context) => c.json({ error: "too many requests; try again in a minute", code: "rate_limited" }, 429);
  const perMinute = async (c: Context, what: string, max: number) =>
    allowed(db, `${what}:${network(callerOf(c, accounts.trustProxy))}`, 60, max);
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const notSetUp = (c: Context) => c.json({ error: "signing in that way is not set up here", code: "no_sign_in" }, 404);
  /** Back to the dashboard, which says what happened. */
  const back = (c: Context, problem: Problem) => c.redirect(`${home}/#problem=${problem}`);

  // Nobody here is known yet, so nothing large is read from them, and
  // nothing they are answered is kept by anything in between.
  open.use(
    "*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "the request is too large" }, 413) }),
  );
  open.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  open.get("/options", (c) => c.json(offers(accounts)));

  // Off to the provider. The browser keeps, in a cookie only this server
  // reads, what it must show on the way back: that it is the browser that
  // left (`state`), and the secret whose hash the provider was given.
  const leave = (name: ProviderName) => async (c: Context) => {
    const provider = providerOf(name);
    if (!provider) return notSetUp(c);
    if (!(await perMinute(c, "auth-leave", 20))) return back(c, "busy");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    // What they came for is theirs to say, and decides only which page they land on.
    const wants = c.req.query("create") === undefined ? "in" : "new";
    setCookie(c, cookie, [provider.name, state, verifier, wants].join("."), {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: AWAY_MINUTES * 60,
    });
    return c.redirect(
      provider.authorizeUrl({ redirectUri: redirectUri(provider.name), state, challenge: challengeOf(verifier) }),
    );
  };

  // Back from the provider.
  const comeBack = (name: ProviderName) => async (c: Context) => {
    const provider = providerOf(name);
    if (!provider) return notSetUp(c);
    const [left, state, verifier, wants] = getCookie(c, cookie)?.split(".") ?? [];
    deleteCookie(c, cookie, { path: "/", secure });
    // Only the browser that left is taken back. Otherwise a link to this
    // address, with a code of the sender's own, would sign whoever opened
    // it in as the sender.
    if (left !== provider.name || !state || !verifier || !sameSecret(c.req.query("state") ?? "", state)) {
      return back(c, "not_started");
    }
    const code = c.req.query("code") ?? "";
    if (c.req.query("error") === "access_denied") return back(c, "refused");
    if (!code || code.length > 2048) return back(c, "provider");
    if (!(await perMinute(c, "auth-return", 20))) return back(c, "busy");
    let emails: string[];
    try {
      const vouched = await provider.addresses({ code, redirectUri: redirectUri(provider.name), verifier });
      emails = [...new Set(vouched.map(emailFrom).filter((email) => email !== null))].slice(0, MAX_ADDRESSES);
    } catch (err) {
      console.error(`signing in with ${provider.name} failed: ${err instanceof Error ? err.message : err}`);
      return back(c, "provider");
    }
    if (!emails.length) return back(c, "no_address");
    const secret = await arrived(db, provider.name, emails);
    return c.redirect(`${home}/#${wants === "new" ? "create" : "login"}=${secret}`);
  };

  // Each by its own name: whether or not it is set up here, the address is
  // one of these routes, and says so.
  for (const name of PROVIDER_NAMES) {
    open.get(`/${name}`, leave(name));
    open.get(`/${name}/callback`, comeBack(name));
  }

  const invalid = (c: Context) =>
    c.json({ error: "that sign-in has run out or was used already; sign in again", code: "invalid_code" }, 400);
  const codeOf = (sent: Record<string, unknown>) => {
    const code = text(sent.code);
    return code && code.length <= 200 ? code : null;
  };
  /** What a code stands for, without using it. */
  const stored = async (code: string) =>
    (
      await db.query<{ provider: ProviderName; emails: string[] }>(
        `SELECT provider, emails FROM sign_in_codes WHERE code_hash = $1 AND expires_at > now()`,
        [hash(code)],
      )
    )[0];

  // Who the provider said this is, and where they can sign in, without
  // using the code: the dashboard shows it and asks. Being added to an
  // organisation is someone else's doing, and must not sign anyone in to a
  // place they did not choose.
  open.post("/check", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const code = codeOf(await body(c));
    const found = code ? await stored(code) : undefined;
    if (!found) return invalid(c);
    return c.json({ provider: found.provider, emails: found.emails, orgs: await membershipsOf(db, found.emails) });
  });

  // Use the code, once: to sign in to an organisation (`user_id`, as
  // `/check` listed it), or to create one (`org_name`).
  open.post("/verify", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const sent = await body(c);
    const code = codeOf(sent);
    if (!code) return invalid(c);
    const used = (tx: Queryable) =>
      tx
        .query<{ provider: ProviderName; emails: string[] }>(
          `DELETE FROM sign_in_codes WHERE code_hash = $1 AND expires_at > now() RETURNING provider, emails`,
          [hash(code)],
        )
        .then((rows) => rows[0]);

    if (sent.org_name === undefined) {
      const userId = text(sent.user_id);
      if (!userId) return c.json({ error: "say where: user_id to sign in, or org_name to create an organisation" }, 400);
      const signed = await db.transaction(async (tx) => {
        const found = await used(tx);
        if (!found) return null;
        // Theirs only under an address the provider vouched for.
        const [user] = await tx.query<{ id: string; org_id: string; org_name: string; email: string; role: string }>(
          `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.role FROM users u JOIN orgs o ON o.id = u.org_id
           WHERE u.id = $1 AND u.email = ANY($2::text[]) AND u.removed_at IS NULL AND o.deleted_at IS NULL`,
          [userId, found.emails],
        );
        if (!user) return null;
        await tx.query(`UPDATE users SET confirmed_at = now() WHERE id = $1 AND confirmed_at IS NULL`, [user.id]);
        return signIn(tx, user, found.provider, false);
      });
      return signed ? c.json(signed) : invalid(c);
    }

    // Signing up. What can be said without the code is said first, so that
    // a name that will not do does not use the code up.
    if (!offers(accounts).signup) return c.json({ error: "signing up is not open here", code: "signup_closed" }, 403);
    const orgName = orgNameFrom(text(sent.org_name));
    if (!orgName) return c.json({ error: ORG_NAME_RULE, code: "bad_org_name" }, 400);
    if (accounts.signupCode && !sameSecret(text(sent.invite_code), accounts.signupCode)) {
      return c.json({ error: "signing up needs an invitation code", code: "invite_required" }, 403);
    }
    const owner = (await stored(code))?.emails[0];
    if (!owner) return invalid(c);
    // An organisation costs its maker nothing, so there are only so many an
    // hour: from one network, by one address, and in all. What is counted
    // is organisations that were made; a refusal gives back what it took.
    const counted: Taken[] = [];
    const within = async (key: string, max: number) => {
      const taken = await take(db, key, 3600, max);
      if (taken) counted.push(taken);
      else for (const each of counted.splice(0)) await giveBack(db, each);
      return taken !== null;
    };
    const limited = (error: string, code = "rate_limited") => c.json({ error, code }, 429);
    if (!(await within(`signups-from:${widerNetwork(callerOf(c, accounts.trustProxy))}`, accounts.signupsPerNetwork ?? SIGNUPS_PER_NETWORK))) {
      return limited("too many organisations were created from your network; try again in an hour");
    }
    if (!(await within(`signup:${owner}`, ORGS_PER_ADDRESS))) {
      return limited("you have created enough organisations for now; try again in an hour");
    }
    if (!(await within("signups", accounts.signupsPerHour ?? 100))) {
      // Said once an hour: someone should look at who is signing up.
      if (await allowed(db, "signups-warned", 3600, 1)) {
        console.warn(
          `The ceiling of ${accounts.signupsPerHour ?? 100} new organisations an hour is reached: no more are created until the hour is over (SESSIONLY_SIGNUPS_PER_HOUR).`,
        );
      }
      return limited("too many people are signing up right now; try again in an hour", "signups_busy");
    }
    // The organisation, its owner and their token, or none of them.
    const signed = await db.transaction(async (tx) => {
      const found = await used(tx);
      const email = found?.emails[0];
      if (!found || !email) return null;
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('sessionly-signup'))`);
      let orgId = orgIdFor(orgName);
      while ((await tx.query(`SELECT 1 FROM orgs WHERE id = $1`, [orgId])).length) orgId = orgIdFor(orgName);
      await tx.query(`INSERT INTO orgs (id, name) VALUES ($1, $2)`, [orgId, orgName]);
      const user = { id: newUserId(), org_id: orgId, org_name: orgName, email, role: "owner" };
      await tx.query(`INSERT INTO users (id, org_id, email, role, confirmed_at) VALUES ($1, $2, $3, $4, now())`, [
        user.id,
        user.org_id,
        user.email,
        user.role,
      ]);
      return signIn(tx, user, found.provider, true);
    });
    if (!signed) {
      for (const each of counted) await giveBack(db, each);
      return invalid(c);
    }
    return c.json(signed);
  });

  return open;
}
