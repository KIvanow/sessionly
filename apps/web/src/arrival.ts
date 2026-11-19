// Coming back from Google or GitHub: what the dashboard does with it. Kept
// apart from the pages, so that it can be tried without a browser.
import type { Arrival, SignedIn } from "@sessionly/schema";
import { open, savedSessions, savedToken } from "./api.ts";

/** Where someone who has signed in goes on to: an organisation they are in, or a new one. */
export type Where = { user_id: string } | { org_name: string; invite_code?: string };

/**
 * What the server is asked on the way in. None of it carries the sign-in
 * itself: that is in a cookie the server gave this browser when it came
 * back, which scripts cannot read and which is sent along with these.
 */
export const doors = {
  /** Who the provider said this is and where they can sign in, from the `shown`th organisation they were added to. */
  check: (shown = 0) => open<Arrival>("/auth/check", { shown }),
  /** Sign in to an organisation, or create one. Works once. */
  enter: (where: Where) => open<SignedIn>("/auth/verify", where),
  /** "Not now": the sign-in is over on the server too. */
  cancel: () => open<{ ok: boolean }>("/auth/cancel", {}),
};

/** Why someone is back without having signed in, as the server names it (`#problem=<word>`), in words. */
const PROBLEMS = new Map([
  ["refused", "You did not finish signing in there. Nothing was changed."],
  ["not_started", "That sign-in was not started in this browser, or was started too long ago. Start again from here."],
  ["provider", "Signing in did not work just now: the service you chose did not answer as expected. Try again in a moment."],
  [
    "setup",
    "Signing in with that service is not set up right on this server, and trying again will not help. Whoever runs the server will find the reason in its log.",
  ],
  [
    "no_address",
    "That account has no email address its provider has verified, and an address is how you are known here. Verify one there and try again.",
  ],
  ["busy", "Too many sign-ins from your network just now. Try again in a minute."],
]);

/** The words for a problem. A word this page does not know is said as the service not answering. */
export function problemText(word: string): string {
  return PROBLEMS.get(word) ?? PROBLEMS.get("provider") ?? "";
}

/** What an address says someone is back with: a sign-in to go on with, or why there is none. */
export type Landing = { arrived: true } | { arrived: false; problem: string };

/**
 * `#signed-in` and `#problem=<word>` are the two the server sends people
 * back to. Neither says who signed in: a link to either, opened by someone
 * else, has nothing in it to use.
 */
export function landingOf(hash: string): Landing | null {
  if (hash === "#signed-in") return { arrived: true };
  const word = /^#problem=([A-Za-z_]{1,40})$/.exec(hash)?.[1];
  return word === undefined ? null : { arrived: false, problem: problemText(word) };
}

/**
 * The membership to take someone straight into, without asking: the only
 * organisation there is for them, which they have signed in to before with
 * this account. Never when this browser is signed in somewhere already:
 * then whoever is at it is asked, whatever brought the sign-in about. The
 * one exception is the demo, for someone who came to view it: it is open to
 * anyone, and lets them change nothing.
 */
export function straightIn(arrival: Arrival, signedIn: boolean): string | null {
  // Came to view the demo (the website's Demo button): into it, as a viewer, whatever else they are in. Only as
  // the account that may sign in there; when it is not offered (closed, or they were removed), they are asked.
  if (arrival.demo_org) {
    const demo = arrival.orgs.find((org) => org.org_id === arrival.demo_org);
    if (demo && !demo.other_account) return demo.user_id;
  }
  if (signedIn || arrival.create || arrival.more > 0) return null;
  const [only, ...others] = arrival.orgs;
  return only && !others.length && !only.first_time && !only.other_account ? only.user_id : null;
}

/** Whether this browser is signed in to anything: with a token it is using, or a session it has kept. */
export function signedInHere(): boolean {
  return savedToken() !== null || savedSessions().length > 0;
}

export type Outcome =
  /** Signed in, with nothing asked. */
  | { kind: "entered"; signed: SignedIn }
  /** Show where they can sign in, and ask. */
  | { kind: "ask"; arrival: Arrival }
  | { kind: "problem"; text: string }
  /** Nothing to do or say. */
  | { kind: "nothing" };

/**
 * What to do with a landing. Whether the browser is signed in already is
 * looked up here, and not handed in by the page, so that the page cannot
 * get it wrong: it decides whether anyone is taken in without being asked.
 */
export async function arrive(landing: Landing, at: Pick<typeof doors, "check" | "enter"> = doors): Promise<Outcome> {
  const signedIn = signedInHere();
  if (!landing.arrived) return { kind: "problem", text: landing.problem };
  let arrival: Arrival;
  try {
    arrival = await at.check();
  } catch (err) {
    // No sign-in of this browser's is waiting. Someone signed in who
    // opened a link to this page is told nothing: it was not their doing.
    return signedIn ? { kind: "nothing" } : { kind: "problem", text: (err as Error).message };
  }
  const only = straightIn(arrival, signedIn);
  if (only === null) return { kind: "ask", arrival };
  try {
    return { kind: "entered", signed: await at.enter({ user_id: only }) };
  } catch (err) {
    return { kind: "problem", text: (err as Error).message };
  }
}
