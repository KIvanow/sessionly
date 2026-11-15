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
