// Email: the links people sign in and sign up with. Plain text only, sent
// through Resend's API (https://resend.com).
import { randomUUID } from "node:crypto";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const RESEND_EMAILS = "https://api.resend.com/emails";
/** Resend refuses requests that do not say what is asking. */
const USER_AGENT = "sessionly-server";
/** How long one request may take. */
const TIMEOUT_MS = 10_000;
/** How often a message is offered in all, when Resend cannot take it right now. */
const ATTEMPTS = 3;

/** A message Resend did not take. `status` is 0 if Resend was not reached. */
export class MailProblem extends Error {
  status: number;
  /** Resend's name for what went wrong, such as `validation_error`. */
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** What Resend said, without anyone's address in it: this is logged. */
const withoutAddresses = (text: string) => text.replace(/[^\s<>()"'`]+@([^\s<>()"'`]+)/g, "…@$1");

/**
 * Sends through Resend. `apiKey` needs sending access and nothing more.
 * `from` is the address messages come from, e.g.
 * `Sessionly <sign-in@example.com>`, on a domain verified in Resend.
 *
 * A message Resend cannot take right now (too many requests a second, a
 * failure on its side, no answer) is offered again, twice at most, under one
 * idempotency key: however often it is offered, it is sent once. What Resend
 * refuses for what it is (an unverified domain, a quota used up, a key that
 * is not valid) is not offered again.
 */
export function resendMailer(
  apiKey: string,
  from: string,
  // Tests give their own: nothing leaves, and nothing waits.
  via: { fetch?: typeof fetch; wait?: (ms: number) => Promise<void> } = {},
): Mailer {
  const ask = via.fetch ?? fetch;
  const wait = via.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    send: async ({ to, subject, text }) => {
      const key = randomUUID();
      for (let attempt = 1; ; attempt++) {
        const last = attempt >= ATTEMPTS;
        let response: Response;
        try {
          response = await ask(RESEND_EMAILS, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              "user-agent": USER_AGENT,
              "idempotency-key": key,
            },
            body: JSON.stringify({ from, to: [to], subject, text }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (err) {
          if (last) throw new MailProblem(0, "unreachable", `Resend was not reached: ${err instanceof Error ? err.message : err}`);
          await wait(500 * 2 ** (attempt - 1));
          continue;
        }
        if (response.ok) return;
        const said = ((await response.json().catch(() => null)) ?? {}) as { name?: unknown; message?: unknown };
        const code = typeof said.name === "string" ? said.name : "";
        const why = typeof said.message === "string" ? withoutAddresses(said.message) : "";
        // A quota that is used up also answers 429, and asking again does not help it.
        const forNow =
          response.status >= 500 ||
          code === "concurrent_idempotent_requests" ||
          (response.status === 429 && (code === "rate_limit_exceeded" || code === ""));
        if (!forNow || last) {
          throw new MailProblem(response.status, code, `Resend did not take the message (${response.status}${code ? ` ${code}` : ""})${why ? `: ${why}` : ""}`);
        }
        // As long as it says, within reason; else a little longer each time.
        const told = Number(response.headers.get("retry-after"));
        await wait(Number.isFinite(told) && told > 0 ? Math.min(told, 5) * 1000 : 500 * 2 ** (attempt - 1));
      }
    },
  };
}

/** How long a link works, in minutes. */
export const LINK_MINUTES = 15;

const FOOTER = `The link works once, for ${LINK_MINUTES} minutes. If you did not ask for this, ignore this message: nothing happens without the link.`;

// Every message here goes to an address on the word of whoever asked, and
// anyone can make an organisation, name it, and add an address to it. So a
// message says nothing its asker chose: no one's address, and no
// organisation's name unless the person it goes to has signed in to that
// organisation before and so knows the name. The page a link opens says
// where it leads and who added the address, and asks before going there.

/**
 * A link to sign in to each organisation the address is a user of. `org` is
 * the organisation's name where the person has signed in to it before, and
 * null where they have not.
 */
export function signInMail(to: string, links: { org: string | null; url: string }[]): Mail {
  const only = links[0];
  const says = "The page it opens says which organisation it is for, and asks before signing you in.";
  const unknown = "An organisation you have not signed in to before";
  const body =
    links.length === 1 && only
      ? `${only.org ? `Sign in to ${only.org} on Sessionly` : "Sign in to Sessionly"}:\n\n${only.url}\n\n${says}`
      : `Sign in to Sessionly. Each link is for one organisation. ${says.replace("The page it", "The page a link")}\n\n` +
        links.map((link) => `${link.org ?? unknown}:\n${link.url}`).join("\n\n");
  return { to, subject: "Sign in to Sessionly", text: `${body}\n\n${FOOTER}\n` };
}

/** The link that creates the organisation someone asked for. */
export function signUpMail(to: string, url: string): Mail {
  return {
    to,
    subject: "Finish setting up Sessionly",
    text: `Confirm this address to create your organisation on Sessionly:\n\n${url}\n\n${FOOTER}\n`,
  };
}

/** The link that lets an invited person in. */
export function inviteMail(to: string, url: string): Mail {
  return {
    to,
    subject: "You were added to an organisation on Sessionly",
    text:
      `Someone added this address to their organisation on Sessionly. The link shows which, and asks before signing you in:\n\n${url}\n\n` +
      `The link works once, for ${LINK_MINUTES} minutes. After that, ask for a new one on the sign-in page with this address. ` +
      `If you were not expecting this, ignore it: nothing happens without the link.\n`,
  };
}
