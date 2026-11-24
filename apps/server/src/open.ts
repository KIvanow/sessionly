// The routes under /api/v1/auth of a server of your own, asked before
// anyone is known: what it offers, and opening its dashboard, which needs no
// signing in. Signing in and signing up are the hosted service's (ee/src/hosted),
// which puts its own routes here ahead of these.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuthOptions } from "@sessionly/schema";
import { DEFAULT_ORG, issueToken, SIGN_IN_DAYS } from "./auth.ts";
import type { Db } from "./db.ts";
import { allowed, callerOf, network } from "./limits.ts";

/** What a server of your own offers someone who is not signed in: its dashboard, opened as its admin. */
export const OPEN: AuthOptions = {
  hosted: false,
  noSignIn: true,
  providers: [],
  signup: false,
  inviteCode: false,
  publicUrl: null,
};

/**
 * Only the dashboard asks to open it: JSON, and from this very site if the
 * browser says where from. A form on another site cannot send JSON, and a
 * page elsewhere that has a browser ask says it is not this one.
 */
export async function fromTheDashboard(c: Context, next: () => Promise<void>, origin?: string): Promise<Response | void> {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) {
    return c.json({ error: "this takes JSON (content-type: application/json)", code: "not_json" }, 415);
  }
  const from = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  if ((from !== undefined && origin !== undefined && from !== origin) || (site !== undefined && site !== "same-origin" && site !== "none")) {
    return c.json({ error: "this is asked by the dashboard itself, and by no other site", code: "elsewhere" }, 403);
  }
  await next();
}

/**
 * `/options`, and `/open`, which hands the dashboard a session as the admin
 * (`admin`, SESSIONLY_ADMIN_EMAIL), running out as a sign-in does. Anyone
 * who can reach the server can have one. `offers` is the hosted service's
 * instead, if it is one, and then nothing is opened.
 */
export function openRoutes(db: Db, settings: { admin?: string; trustProxy?: boolean; offers?: AuthOptions }): Hono {
  const open = new Hono();
  const offers = settings.offers ?? OPEN;
  open.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "the request is too large" }, 413) }));
  open.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  open.get("/options", (c) => c.json(offers));
  open.use("/open", (c, next) => fromTheDashboard(c, next));
  open.post("/open", async (c) => {
    if (!offers.noSignIn) return c.json({ error: "this server is signed in to", code: "sign_in" }, 404);
    if (!(await allowed(db, `auth-open:${network(callerOf(c, settings.trustProxy))}`, 60, 20))) {
      return c.json({ error: "too many requests; try again in a minute", code: "rate_limited" }, 429);
    }
    const expiresAt = new Date(Date.now() + SIGN_IN_DAYS * 86_400_000);
    const email = settings.admin ?? "admin@localhost";
    const [org] = await db.query<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [DEFAULT_ORG]);
    const { token } = await issueToken(db, DEFAULT_ORG, { email, role: "admin", signIn: "open", expiresAt });
    return c.json({
      token,
      org: { id: DEFAULT_ORG, name: org?.name ?? DEFAULT_ORG },
      email,
      role: "admin",
      expires_at: expiresAt.toISOString(),
      created: false,
    });
  });
  return open;
}
