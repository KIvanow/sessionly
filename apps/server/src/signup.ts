// Signing in and signing up with Google or GitHub: the routes that are asked
// before anyone is known, so they see the database as its owner does.
// Nothing here reads or returns an organisation's data; it only hands out a
// token.
//
// The browser is sent to the provider and comes back with the provider's
// answer. What the provider says of the person (which account this is, and
// which addresses are its) is kept for a few minutes under a code. The code
// is given to the browser that came back and to nothing else: in a cookie
// that scripts cannot read and that only this host is sent. It is in no
// address, so it cannot be passed on in a link, and is in no history and no
// log. Only its hash is stored, and it works once.
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
import {
  challengeOf,
  errorWord,
  isSetupWord,
  PROVIDER_LABELS as LABELS,
  PROVIDER_NAMES,
  ProviderProblem,
  type Person,
  type Provider,
  type ProviderName,
} from "./oauth.ts";

/** How long a token from signing in lasts. */
export const SIGN_IN_DAYS = 7;

/** Someone is shown at most this many organisations they have signed in to before. */
const MAX_ORGS = 50;

/** Organisations someone was added to and has not signed in to yet are shown this many at a time, newest first. */
export const INVITATIONS_SHOWN = 10;

/** Sign-ins one browser may have under way at once, each begun and not yet come back from. */
const MAX_UNDER_WAY = 5;

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

/**
 * Wrong invitation codes an hour from one network (a /24, or a /48 of
 * IPv6), and by one account. Past either, no code of theirs is looked at
 * until the hour is over, right or wrong, so that the code cannot be found
 * by trying.
 */
const WRONG_CODES_PER_NETWORK = 10;
const WRONG_CODES_PER_ACCOUNT = 10;
/**
 * Wrong codes an hour from everyone together, past which the log says so,
 * once an hour. Nobody is refused for it: a limit here would let whoever
 * guesses a lot close signing up for everyone else.
 */
const WRONG_CODES_TO_SAY = 1000;

/** A request to these routes is a code and a name: this is plenty. */
const MAX_BODY_BYTES = 16 * 1024;

/** Organisations one address may create an hour. */
export const ORGS_PER_ADDRESS = 5;

/**
 * Organisations one person may be the owner of, in all: counted by their
 * address and by the account they signed in with. The hourly counts alone
 * let one account make over a hundred a day, for as long as it likes.
 */
export const ORGS_PER_PERSON = 20;

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
    // The one address people sign in at, to tell someone who was added where to go.
    publicUrl: providers.length ? (accounts.publicUrl?.replace(/\/+$/, "") ?? null) : null,
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

/** What a provider said of someone who has just come back from it. */
interface Arrival extends Person {
  provider: ProviderName;
}

/** Keep it. Returns the code the browser is given. */
async function arrived(db: Queryable, { provider, account, emails }: Arrival): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sign_in_codes (code_hash, provider, account, emails, expires_at)
     VALUES ($1, $2, $3, $4::text[], now() + make_interval(mins => $5::int))`,
    [hash(secret), provider, account, emails, CODE_MINUTES],
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
  /**
   * Set if someone signed in to it before with another account than this
   * one: that account's provider. Only that account gets in.
   */
  other_account: ProviderName | null;
}

const MEMBERSHIP = `SELECT u.id AS user_id, u.org_id, o.name AS org_name, u.email, u.confirmed_at IS NULL AS first_time,
            u.invited_by, u.invited_via,
            CASE WHEN u.sign_in_account IS NOT NULL AND (u.sign_in_provider <> $2 OR u.sign_in_account <> $3)
                 THEN u.sign_in_provider END AS other_account
     FROM users u JOIN orgs o ON o.id = u.org_id
     WHERE u.email = ANY($1::text[]) AND u.removed_at IS NULL AND o.deleted_at IS NULL`;

/**
 * Where this person can sign in. First the organisations someone has signed
 * in to under these addresses. Then, from the `shown`th on, the ones they
 * were added to and have not signed in to: the newest first and a few at a
 * time, with how many there are beyond those. Anyone can add anyone's
 * address to an organisation of their own. Being added to many must not
 * push out of the list the ones a person is really in, nor the one they
 * were just told about, and what was put there to hide it can be paged past.
 */
async function membershipsOf(db: Queryable, who: Arrival, shown = 0): Promise<{ orgs: Membership[]; more: number }> {
  const person = [who.emails, who.provider, who.account];
  const known = shown
    ? []
    : await db.query<Membership>(
        `${MEMBERSHIP} AND u.confirmed_at IS NOT NULL ORDER BY u.created_at, u.id LIMIT ${MAX_ORGS}`,
        person,
      );
  const added = await db.query<Membership & { in_all: unknown }>(
    `${MEMBERSHIP.replace("SELECT ", "SELECT count(*) OVER () AS in_all, ")} AND u.confirmed_at IS NULL
     ORDER BY coalesce(u.invited_at, u.created_at) DESC, u.id LIMIT ${INVITATIONS_SHOWN} OFFSET $4::int`,
    [...person, shown],
  );
  const inAll = added.length ? Number(added[0]?.in_all) : shown;
  // A name is not enough to tell an organisation by: anyone can make
  // another of the same name. So also its id, which is its own, and for
  // someone who has not signed in to it before, who added them: if that
  // was a person who had signed in, whose address is then theirs. Someone
  // added with a token is told that much and no address, since a token's
  // address and name are whatever its maker typed.
  const orgs = [...known, ...added].map(({ in_all: _, ...row }: Membership & { in_all?: unknown }) => ({
    ...row,
    invited_by: row.first_time && row.invited_via === "sign_in" ? row.invited_by : null,
    invited_via: row.first_time ? row.invited_via : null,
  }));
  return { orgs, more: Math.max(0, inAll - shown - added.length) };
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
  /** The provider says this server is not set up right with it. */
  | "setup"
  /** The provider vouches for no address of theirs. */
  | "no_address"
  | "busy";

/** Thrown inside a transaction to undo it, the code's use included, and answer with this. */
class Refused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}



/** The routes under /api/v1/auth that need no token. */
export function openRoutes(db: Db, accounts: Accounts): Hono {
  const open = new Hono();
  const home = accounts.publicUrl?.replace(/\/+$/, "");
  const secure = home?.startsWith("https://") === true;
  // Under this prefix a browser takes a cookie only from this very host,
  // over HTTPS: a neighbouring site of the same domain cannot plant one.
  const prefix = secure ? "__Host-" : "";
  // One for each sign-in that is under way, named after its `state`, so
  // that two tabs do not undo each other and a request that is not the way
  // back from a provider touches none of them.
  const leaving = `${prefix}sessionly-signin-`;
  const leavingAs = (state: string) => `${leaving}${hash(state).slice(0, 16)}`;
  // And one for whoever has come back, until they have said where to.
  const arrivedAs = `${prefix}sessionly-arrived`;
  const ours = { httpOnly: true, secure, sameSite: "Lax", path: "/" } as const;
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
  const origin = home ? new URL(home).origin : undefined;
  /**
   * What only the dashboard asks: JSON, and from this very site if the
   * browser says where from. A form on another site cannot send JSON, and a
   * page of a neighbouring host (which the cookie's SameSite rule lets
   * through) says it is not this one. Otherwise such a page could, in the
   * name of whoever has just signed in, create an organisation or end
   * their sign-in. What is not a browser says neither, and has no cookie.
   */
  const fromTheDashboard = async (c: Context, next: () => Promise<void>) => {
    if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ error: "this takes JSON (content-type: application/json)", code: "not_json" }, 415);
    }
    const from = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if ((from !== undefined && origin !== undefined && from !== origin) || (site !== undefined && site !== "same-origin" && site !== "none")) {
      return c.json({ error: "this is asked by the dashboard itself, and by no other site", code: "elsewhere" }, 403);
    }
    await next();
  };

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
    // Signing in is begun from the dashboard. Another site that sends a
    // browser here gets it shown the dashboard, and nothing is begun: sent
    // here over and over, it would otherwise use up what one network may
    // begin in a minute, and push out the sign-ins that are under way.
    if (c.req.header("sec-fetch-site") === "cross-site") return c.redirect(`${home}/`);
    if (!(await perMinute(c, "auth-leave", 20))) return back(c, "busy");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    // What they came for is theirs to say, and decides only which page they land on.
    const wants = c.req.query("create") === undefined ? "in" : "new";
    // Each start leaves a cookie for ten minutes. Past a few, the earlier
    // ones go: a browser sent here over and over would otherwise carry more
    // of them than a request may.
    const underWay = Object.keys(getCookie(c)).filter((each) => each.startsWith(leaving));
    if (underWay.length >= MAX_UNDER_WAY) for (const each of underWay) deleteCookie(c, each, { path: "/", secure });
    setCookie(c, leavingAs(state), [provider.name, state, verifier, wants].join("."), { ...ours, maxAge: AWAY_MINUTES * 60 });
    return c.redirect(
      provider.authorizeUrl({ redirectUri: redirectUri(provider.name), state, challenge: challengeOf(verifier) }),
    );
  };

  /** The code this browser was given when it came back, and what it came for. */
  const held = (c: Context) => {
    const [code, wants] = getCookie(c, arrivedAs)?.split(".") ?? [];
    return code && code.length <= 200 ? { code, create: wants === "new" } : null;
  };
  const forget = (code: string) => db.query(`DELETE FROM sign_in_codes WHERE code_hash = $1`, [hash(code)]);

  // Back from the provider.
  const comeBack = (name: ProviderName) => async (c: Context) => {
    const provider = providerOf(name);
    if (!provider) return notSetUp(c);
    // Only the browser that left is taken back: the one that has the cookie
    // of this `state`. Otherwise a link to this address, with a code of the
    // sender's own, would sign whoever opened it in as the sender. A request
    // that shows no such cookie changes nothing: any site can make a
    // browser ask for this address, and that must not end a sign-in that
    // is under way.
    const shown = c.req.query("state") ?? "";
    const cookie = shown && shown.length <= 200 ? leavingAs(shown) : "";
    const [left, state, verifier, wants] = (cookie ? getCookie(c, cookie) : undefined)?.split(".") ?? [];
    if (left !== provider.name || !state || !verifier || !sameSecret(shown, state)) return back(c, "not_started");
    if (!(await perMinute(c, "auth-return", 20))) return back(c, "busy");
    // This sign-in is over, however it ends, and comes back once.
    deleteCookie(c, cookie, { path: "/", secure });
    const first = await db.query(
      `INSERT INTO sign_in_states (state_hash, expires_at) VALUES ($1, now() + make_interval(mins => $2::int))
       ON CONFLICT DO NOTHING RETURNING 1 AS first`,
      [hash(state), AWAY_MINUTES],
    );
    if (!first.length) return back(c, "not_started");
    const said = c.req.query("error");
    if (said === "access_denied") return back(c, "refused");
    if (said !== undefined) {
      // In its own word and no more: the rest of what it sends is not for a log.
      const word = errorWord(said);
      console.error(
        `signing in with ${LABELS[provider.name]}: it sent someone back with ${word ? `"${word}"` : "an error it did not name plainly"}`,
      );
      return back(c, isSetupWord(word) ? "setup" : "provider");
    }
    const code = c.req.query("code") ?? "";
    if (!code || code.length > 2048) return back(c, "provider");
    let person: Person;
    try {
      const vouched = await provider.who({ code, redirectUri: redirectUri(provider.name), verifier });
      const emails = [...new Set(vouched.emails.map(emailFrom).filter((email) => email !== null))].slice(0, MAX_ADDRESSES);
      person = { account: vouched.account, emails };
    } catch (err) {
      console.error(`signing in with ${LABELS[provider.name]} failed: ${err instanceof Error ? err.message : err}`);
      return back(c, err instanceof ProviderProblem && isSetupWord(err.word) ? "setup" : "provider");
    }
    if (!person.account || person.account.length > 200) return back(c, "provider");
    if (!person.emails.length) return back(c, "no_address");
    // A sign-in this browser came back from earlier and did nothing with is over.
    const earlier = held(c);
    if (earlier) await forget(earlier.code);
    const secret = await arrived(db, { provider: provider.name, ...person });
    setCookie(c, arrivedAs, `${secret}.${wants === "new" ? "new" : "in"}`, { ...ours, maxAge: CODE_MINUTES * 60 });
    // Nothing of it in the address: the page asks, and the cookie answers.
    return c.redirect(`${home}/#signed-in`);
  };

  // Each by its own name: whether or not it is set up here, the address is
  // one of these routes, and says so.
  for (const name of PROVIDER_NAMES) {
    open.get(`/${name}`, leave(name));
    open.get(`/${name}/callback`, comeBack(name));
  }

  for (const path of ["/check", "/cancel", "/verify"]) open.use(path, fromTheDashboard);

  const invalid = (c: Context) => {
    deleteCookie(c, arrivedAs, { path: "/", secure });
    return c.json({ error: "that sign-in has run out or was used already; sign in again", code: "invalid_code" }, 400);
  };
  /** What a code stands for, without using it. */
  const stored = async (code: string) =>
    (
      await db.query<Arrival>(
        `SELECT provider, account, emails FROM sign_in_codes WHERE code_hash = $1 AND expires_at > now()`,
        [hash(code)],
      )
    )[0];

  // Who the provider said this is, and where they can sign in, without
  // using the code: the dashboard shows it and asks. Being added to an
  // organisation is someone else's doing, and must not sign anyone in to a
  // place they did not choose. The code is the one in this browser's
  // cookie: one from anywhere else, in the request or in another browser's
  // cookie, is nobody's here.
  open.post("/check", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const mine = held(c);
    const found = mine ? await stored(mine.code) : undefined;
    if (!mine || !found) return invalid(c);
    const shown = Number((await body(c)).shown ?? 0);
    if (!Number.isInteger(shown) || shown < 0 || shown > 100_000) return c.json({ error: "shown must be a whole number" }, 400);
    return c.json({ provider: found.provider, emails: found.emails, create: mine.create, ...(await membershipsOf(db, found, shown)) });
  });

  // "Not now": the sign-in is over, here and in this browser.
  open.post("/cancel", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const mine = held(c);
    if (mine) await forget(mine.code);
    deleteCookie(c, arrivedAs, { path: "/", secure });
    return c.json({ ok: true });
  });

  // Use the code, once: to sign in to an organisation (`user_id`, as
  // `/check` listed it), or to create one (`org_name`).
  open.post("/verify", async (c) => {
    if (!(await perMinute(c, "auth-verify", 20))) return tooMany(c);
    const sent = await body(c);
    const code = held(c)?.code ?? "";
    const used = (tx: Queryable) =>
      tx
        .query<Arrival>(
          `DELETE FROM sign_in_codes WHERE code_hash = $1 AND expires_at > now() RETURNING provider, account, emails`,
          [hash(code)],
        )
        .then((rows) => rows[0]);
    /** Signed in: the code is used, and this browser no longer has it. */
    const done = (signed: SignedIn) => {
      deleteCookie(c, arrivedAs, { path: "/", secure });
      return c.json(signed);
    };
    /** Said no for a reason that leaves the code as it was, to choose again with. */
    const refusal = (err: unknown, status: 403 | 409) => {
      if (!(err instanceof Refused)) throw err;
      return c.json({ error: err.message, code: err.code }, status);
    };

    if (sent.org_name === undefined) {
      const userId = text(sent.user_id);
      if (!userId) return c.json({ error: "say where: user_id to sign in, or org_name to create an organisation" }, 400);
      if (!code) return invalid(c);
      try {
        const signed = await db.transaction(async (tx) => {
          const found = await used(tx);
          if (!found) return null;
          // Theirs only under an address the provider vouched for.
          const [user] = await tx.query<{
            id: string;
            org_id: string;
            org_name: string;
            email: string;
            role: string;
            sign_in_provider: ProviderName | null;
            sign_in_account: string | null;
          }>(
            `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.role, u.sign_in_provider, u.sign_in_account
             FROM users u JOIN orgs o ON o.id = u.org_id
             WHERE u.id = $1 AND u.email = ANY($2::text[]) AND u.removed_at IS NULL AND o.deleted_at IS NULL
             FOR UPDATE OF u`,
            [userId, found.emails],
          );
          if (!user) return null;
          // And only with the account that signed in to it first. A provider
          // goes on vouching for an address after its mailbox has passed to
          // someone else; the account's own number does not pass with it.
          if (user.sign_in_account !== null && (user.sign_in_provider !== found.provider || user.sign_in_account !== found.account)) {
            throw new Refused(
              "other_account",
              `this organisation was signed in to before with another ${LABELS[user.sign_in_provider ?? found.provider]} account; sign in with that one. If it is gone, another admin of the organisation can let you in with a new one from its Team page, and if there is none, whoever runs this server can`,
            );
          }
          await tx.query(
            `UPDATE users SET confirmed_at = coalesce(confirmed_at, now()), sign_in_provider = $2, sign_in_account = $3 WHERE id = $1`,
            [user.id, found.provider, found.account],
          );
          return signIn(tx, user, found.provider, false);
        });
        return signed ? done(signed) : invalid(c);
      } catch (err) {
        return refusal(err, 403);
      }
    }

    // Signing up. Only someone who has signed in is told anything more
    // than whether it is open: whether an invitation code is right is not
    // for anyone to try out. What can be said without using the sign-in is
    // said first, so that a name that will not do does not use it up.
    if (!offers(accounts).signup) return c.json({ error: "signing up is not open here", code: "signup_closed" }, 403);
    const arrival = code ? await stored(code) : undefined;
    const owner = arrival?.emails[0];
    if (!arrival || !owner) return invalid(c);
    const orgName = orgNameFrom(text(sent.org_name));
    if (!orgName) return c.json({ error: ORG_NAME_RULE, code: "bad_org_name" }, 400);
    const limited = (error: string, code = "rate_limited") => c.json({ error, code }, 429);
    if (accounts.signupCode) {
      // A try is counted before the code is looked at, so that tries made
      // at the same moment cannot all get in under the limit; a right one
      // is given back. Counted by network and by account: one account
      // cannot go on from other networks, nor one network with other accounts.
      const tries: Taken[] = [];
      for (const [key, max] of [
        [`invite-wrong:${widerNetwork(callerOf(c, accounts.trustProxy))}`, WRONG_CODES_PER_NETWORK],
        [`invite-wrong-by:${arrival.provider}:${arrival.account}`, WRONG_CODES_PER_ACCOUNT],
      ] as const) {
        const taken = await take(db, key, 3600, max);
        if (!taken) {
          for (const each of tries) await giveBack(db, each);
          return limited("too many wrong invitation codes; none of yours is looked at until the hour is over", "invite_limited");
        }
        tries.push(taken);
      }
      if (!sameSecret(text(sent.invite_code), accounts.signupCode)) {
        if (!(await allowed(db, "invite-wrong", 3600, WRONG_CODES_TO_SAY)) && (await allowed(db, "invite-wrong-said", 3600, 1))) {
          console.warn(
            `More than ${WRONG_CODES_TO_SAY} wrong invitation codes were tried in an hour: someone may be looking for SESSIONLY_SIGNUP_CODE. Each network and each account gets ten tries an hour.`,
          );
        }
        return c.json({ error: "signing up needs an invitation code", code: "invite_required" }, 403);
      }
      for (const each of tries) await giveBack(db, each);
    }
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
    try {
      const signed = await db.transaction(async (tx) => {
        const found = await used(tx);
        const email = found?.emails[0];
        if (!found || !email) return null;
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('sessionly-signup'))`);
        // Under the lock, so that the count is of what is there.
        const [owned] = await tx.query<{ n: unknown }>(
          `SELECT count(*) AS n FROM users u JOIN orgs o ON o.id = u.org_id
           WHERE u.role = 'owner' AND u.removed_at IS NULL AND o.deleted_at IS NULL
             AND (u.email = ANY($1::text[]) OR (u.sign_in_provider = $2 AND u.sign_in_account = $3))`,
          [found.emails, found.provider, found.account],
        );
        if (Number(owned?.n) >= ORGS_PER_PERSON) {
          throw new Refused("too_many_orgs", `one person can own ${ORGS_PER_PERSON} organisations at most, and you own that many`);
        }
        let orgId = orgIdFor(orgName);
        while ((await tx.query(`SELECT 1 FROM orgs WHERE id = $1`, [orgId])).length) orgId = orgIdFor(orgName);
        await tx.query(`INSERT INTO orgs (id, name) VALUES ($1, $2)`, [orgId, orgName]);
        const user = { id: newUserId(), org_id: orgId, org_name: orgName, email, role: "owner" };
        await tx.query(
          `INSERT INTO users (id, org_id, email, role, confirmed_at, sign_in_provider, sign_in_account)
           VALUES ($1, $2, $3, $4, now(), $5, $6)`,
          [user.id, user.org_id, user.email, user.role, found.provider, found.account],
        );
        return signIn(tx, user, found.provider, true);
      });
      if (!signed) {
        for (const each of counted) await giveBack(db, each);
        return invalid(c);
      }
      return done(signed);
    } catch (err) {
      for (const each of counted) await giveBack(db, each);
      return refusal(err, 409);
    }
  });

  return open;
}
