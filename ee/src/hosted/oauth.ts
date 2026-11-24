// Signing in with Google or GitHub: where the browser is sent, and what is
// asked of each once it comes back. What is taken from either is which
// account this is (a number that stays the account's, whatever its
// addresses become) and which email addresses it vouches for. Nothing else
// of the account is kept, and the access it grants is used once and thrown
// away.
import { createHash } from "node:crypto";

import { PROVIDER_LABELS, PROVIDER_NAMES, type ProviderName } from "@sessionly/server";

export { PROVIDER_LABELS, PROVIDER_NAMES, type ProviderName };

/** One way of signing in. */
export interface Provider {
  name: ProviderName;
  /** Where the browser goes to sign in. `challenge` is `challengeOf` a secret this server keeps for the way back. */
  authorizeUrl(ask: { redirectUri: string; state: string; challenge: string }): string;
  /** Who the provider says this is, for the code it sent the browser back with. */
  who(answer: { code: string; redirectUri: string; verifier: string }): Promise<Person>;
}

/** Someone, as a provider knows them. */
export interface Person {
  /**
   * The account, as the provider numbers it: Google's `sub`, GitHub's user
   * id. It stays the same when the account's addresses change, and is never
   * given to another account.
   */
  account: string;
  /**
   * The addresses the provider says are this account's: only ones it has
   * verified, the main one first. Empty if it vouches for none. Verified
   * means that the account's holder could once read mail sent there, not
   * that they still can.
   */
  emails: string[];
}

/** What the provider's settings page gives for this server. */
export interface Client {
  id: string;
  secret: string;
}

/**
 * A provider did not answer, or not with what was asked for. Never carries
 * the code or a secret. `word` is the provider's own name for what went
 * wrong, if it gave one.
 */
export class ProviderProblem extends Error {
  word?: string;
  constructor(message: string, word?: string) {
    super(message);
    this.word = word;
  }
}

/**
 * The words with which a provider says that this server is not set up right
 * with it (a wrong id or secret, an address to come back to that it was not
 * told of, an app that was switched off): trying again changes nothing, and
 * whoever runs the server has something to fix.
 */
const SETUP_WORDS = new Set([
  "invalid_client",
  "unauthorized_client",
  "redirect_uri_mismatch",
  "incorrect_client_credentials",
  "application_suspended",
  "invalid_scope",
  "admin_policy_enforced",
  "disabled_client",
  "deleted_client",
  "org_internal",
]);

/** Whether a provider's word for an error means the server's settings for it are wrong. */
export function isSetupWord(word: string | undefined): boolean {
  return word !== undefined && SETUP_WORDS.has(word);
}

/** A provider's word for an error, if it is one that can be written in a log as it is. */
export function errorWord(said: unknown): string | undefined {
  return typeof said === "string" && /^[a-z][a-z0-9_.-]{0,59}$/i.test(said) ? said.toLowerCase() : undefined;
}

/** How long any one request to a provider may take, its whole answer included. A test shortens it. */
export const PATIENCE = { ms: 10_000 };

/** What a provider is sent in place of the secret, to be shown the secret itself on the way back (PKCE, S256). */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function ask(what: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  let body: string;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(PATIENCE.ms) });
    // The limit covers the rest of the answer too: one that begins and then
    // stalls is cut off here, and said as that.
    body = await response.text();
  } catch (err) {
    throw new ProviderProblem(`${what} did not answer, or not to the end (${(err as Error).name})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ProviderProblem(`${what} answered ${response.status} with something that is not JSON`);
  }
  if (!response.ok) {
    // What went wrong, in the provider's own word for it: never the whole
    // answer, which may repeat what it was sent.
    const word = errorWord((data as { error?: unknown } | null)?.error);
    throw new ProviderProblem(`${what} answered ${response.status}${word ? ` (${word})` : ""}`, word);
  }
  return data;
}

/** Exchange the code for access, as both providers take it: a form, answered in JSON. */
async function accessFor(what: string, url: string, form: Record<string, string>): Promise<string> {
  const data = (await ask(what, url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  })) as { access_token?: unknown; error?: unknown } | null;
  // GitHub says no with a 200.
  if (typeof data?.access_token !== "string" || !data.access_token) {
    const word = errorWord(data?.error);
    throw new ProviderProblem(`${what} gave no access${word ? ` (${word})` : ""}`, word);
  }
  return data.access_token;
}

export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
};

/**
 * Sign in with Google. A Google account has one address; it counts only if
 * Google has verified it. For an address that is not Google's own, that was
 * done once, when the account was made: Google goes on saying so after the
 * mailbox has gone to someone else. Which Workspace the account is in (`hd`)
 * is not looked at.
 */
export function google(client: Client, at: typeof GOOGLE = GOOGLE): Provider {
  return {
    name: "google",
    authorizeUrl: ({ redirectUri, state, challenge }) =>
      `${at.authorize}?${new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        // Someone with several Google accounts chooses which, every time.
        prompt: "select_account",
      })}`,
    async who({ code, redirectUri, verifier }) {
      const access = await accessFor("Google's token endpoint", at.token, {
        grant_type: "authorization_code",
        code,
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const who = (await ask("Google's userinfo endpoint", at.userinfo, {
        headers: { authorization: `Bearer ${access}` },
      })) as { sub?: unknown; email?: unknown; email_verified?: unknown } | null;
      if (typeof who?.sub !== "string" || !who.sub) throw new ProviderProblem("Google's userinfo endpoint named no account");
      return { account: who.sub, emails: typeof who.email === "string" && who.email_verified === true ? [who.email] : [] };
    },
  };
}

export const GITHUB = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
  emails: "https://api.github.com/user/emails",
};

/**
 * Sign in with GitHub. A GitHub account can have several addresses: every
 * one GitHub has verified counts, the primary one first, so that someone
 * whose account is under a private address gets in where their work address
 * was added. GitHub verifies an address once, and keeps it on the account
 * until its holder takes it off. The addresses GitHub makes up to hide a
 * real one (`…@users.noreply.github.com`) are nobody's mailbox and are left
 * out.
 */
export function github(client: Client, at: typeof GITHUB = GITHUB): Provider {
  return {
    name: "github",
    authorizeUrl: ({ redirectUri, state, challenge }) =>
      `${at.authorize}?${new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        scope: "user:email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    async who({ code, redirectUri, verifier }) {
      const access = await accessFor("GitHub's token endpoint", at.token, {
        code,
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const headers = {
        authorization: `Bearer ${access}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sessionly",
      };
      const [user, listed] = await Promise.all([
        ask("GitHub's account", at.user, { headers }) as Promise<{ id?: unknown } | null>,
        ask("GitHub's list of addresses", `${at.emails}?per_page=100`, { headers }),
      ]);
      // The number, not the name: a name can be changed, and then taken by someone else.
      if (!Number.isSafeInteger(user?.id) || (user?.id as number) <= 0) {
        throw new ProviderProblem("GitHub's account had no id");
      }
      if (!Array.isArray(listed)) throw new ProviderProblem("GitHub's list of addresses was not a list");
      const verified = (listed as { email?: unknown; verified?: unknown; primary?: unknown }[]).filter(
        (each) =>
          typeof each?.email === "string" && each.verified === true && !/@users\.noreply\.github\.com$/i.test(each.email),
      );
      return {
        account: String(user?.id),
        emails: [...verified.filter((each) => each.primary === true), ...verified.filter((each) => each.primary !== true)].map(
          (each) => each.email as string,
        ),
      };
    },
  };
}
