// Email: the links people sign in and sign up with. Plain text only.
import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Sends through an SMTP server: `smtp://user:pass@host:587`, or `smtps://…`
 * for TLS from the start. `from` is the address messages come from, e.g.
 * `Sessionly <sign-in@example.com>`.
 */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    send: async ({ to, subject, text }) => {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

/** How long a link works, in minutes. */
export const LINK_MINUTES = 15;

const FOOTER = `The link works once, for ${LINK_MINUTES} minutes. If you did not ask for this, ignore this message: nothing happens without the link.`;

/** A link to sign in to each organisation the address is a user of. */
export function signInMail(to: string, links: { org: string; url: string }[]): Mail {
  const only = links[0];
  const body =
    links.length === 1 && only
      ? `Sign in to ${only.org} on Sessionly:\n\n${only.url}`
      : `Sign in to Sessionly. This address is in ${links.length} organisations; each has its own link:\n\n` +
        links.map((link) => `${link.org}:\n${link.url}`).join("\n\n");
  return { to, subject: "Sign in to Sessionly", text: `${body}\n\n${FOOTER}\n` };
}

// The two messages below go to addresses nobody has confirmed, on the word of
// whoever asked. So they say nothing their asker chose: no organisation's
// name, no one's address. The page the link opens says where it leads, and
// asks before going there.

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
