// Signing in with Google or GitHub: where the browser is sent, and what is
// asked of each once it comes back. All that is taken from either is which
// email addresses it vouches for; nothing of the account is kept, and the
// access it grants is used once and thrown away.
import { createHash } from "node:crypto";

export type ProviderName = "google" | "github";
export const PROVIDER_NAMES: readonly ProviderName[] = ["google", "github"];

/** One way of signing in. */
export interface Provider {
  name: ProviderName;
  /** Where the browser goes to sign in. `challenge` is `challengeOf` a secret this server keeps for the way back. */
  authorizeUrl(ask: { redirectUri: string; state: string; challenge: string }): string;
  /**
   * The addresses the provider says are this person's, for the code it sent
   * the browser back with: only ones it has verified, the main one first.
   * Empty if it vouches for none.
   */
  addresses(answer: { code: string; redirectUri: string; verifier: string }): Promise<string[]>;
}

/** What the provider's settings page gives for this server. */
export interface Client {
  id: string;
  secret: string;
}

/** A provider did not answer, or not with what was asked for. Never carries the code or a secret. */
export class ProviderProblem extends Error {}

/** How long any one request to a provider may take. */
const TIMEOUT_MS = 10_000;

/** What a provider is sent in place of the secret, to be shown the secret itself on the way back (PKCE, S256). */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function ask(what: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderProblem(`${what} did not answer (${(err as Error).name})`);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // What went wrong, in the provider's own word for it: never the whole
    // answer, which may repeat what it was sent.
    const said = (data as { error?: unknown } | null)?.error;
    throw new ProviderProblem(`${what} answered ${response.status}${typeof said === "string" ? ` (${said.slice(0, 80)})` : ""}`);
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
    throw new ProviderProblem(`${what} gave no access${typeof data?.error === "string" ? ` (${data.error.slice(0, 80)})` : ""}`);
  }
  return data.access_token;
}

export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
};

/** Sign in with Google. A Google account has one address; it counts only if Google has verified it. */
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
    async addresses({ code, redirectUri, verifier }) {
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
      })) as { email?: unknown; email_verified?: unknown } | null;
      return typeof who?.email === "string" && who.email_verified === true ? [who.email] : [];
    },
  };
}

export const GITHUB = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  emails: "https://api.github.com/user/emails",
};

/**
 * Sign in with GitHub. A GitHub account can have several addresses: every
 * one GitHub has verified counts, the primary one first, so that someone
 * whose account is under a private address gets in where their work address
 * was added. The addresses GitHub makes up to hide a real one
 * (`…@users.noreply.github.com`) are nobody's mailbox and are left out.
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
    async addresses({ code, redirectUri, verifier }) {
      const access = await accessFor("GitHub's token endpoint", at.token, {
        code,
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const listed = await ask("GitHub's list of addresses", `${at.emails}?per_page=100`, {
        headers: {
          authorization: `Bearer ${access}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "sessionly",
        },
      });
      if (!Array.isArray(listed)) throw new ProviderProblem("GitHub's list of addresses was not a list");
      const verified = (listed as { email?: unknown; verified?: unknown; primary?: unknown }[]).filter(
        (each) =>
          typeof each?.email === "string" && each.verified === true && !/@users\.noreply\.github\.com$/i.test(each.email),
      );
      return [...verified.filter((each) => each.primary === true), ...verified.filter((each) => each.primary !== true)].map(
        (each) => each.email as string,
      );
    },
  };
}
