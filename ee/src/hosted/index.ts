// A service many organisations share: what the core server is handed as its
// `hosting` (apps/server/src/app.ts). People sign in and sign up with Google
// or GitHub, admins add people by their address, an owner deletes their
// organisation, and one repository can be shown in an organisation of its
// own (demo.ts). Signing in comes before anyone is known, so this is handed
// the database as its owner sees it; the routes on the API reach data through
// the request's organisation only.
import {
  addUser,
  ApiError,
  emailFrom,
  giveBack,
  invitesKey,
  newUserId,
  take,
  type Db,
  type Hosting,
} from "@sessionly/server";
import { shownOutcomes, shownReport } from "./demo.ts";
import { PROVIDER_LABELS as LABELS, PROVIDER_NAMES } from "./oauth.ts";
import { deleteOrg, purgeDeletedOrgs } from "./orgs.ts";
import { offers, openRoutes, type Accounts } from "./signup.ts";

/** People an organisation may add an hour: anyone can add anyone, and be the admin of an organisation they just made. */
const INVITES_PER_HOUR = 30;

export interface HostingSettings {
  accounts: Accounts;
  /**
   * The organisation one repository is shown in (demo.ts), and the paths of
   * it that are not shown; or why those cannot be trusted, and reports to it
   * are refused (`reportsShownIn`).
   */
  demo?: { org: string; hide: string[] } | { org: string; problem: string };
}

/**
 * A host (`localhost:8080`) as a name of this machine and a port, or null
 * if it is anything else: another machine's name, or an address of this
 * one that others can reach.
 */
export function thisMachine(host: string, protocol: string): { name: string; port: string } | null {
  const found = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!found?.[1]) return null;
  return { name: found[1].toLowerCase(), port: found[2] ?? (protocol === "https:" ? "443" : "80") };
}

export function hosting(ownerDb: Db, { accounts, demo }: HostingSettings): Hosting {
  const offered = offers(accounts);
  return {
    offers: offered,
    accounts,

    open(app) {
      // People sign in at one address, the public one: a provider sends them
      // back there, and the cookie that says which browser left is kept for
      // that host. A server tried on one's own machine has several names
      // (localhost, 127.0.0.1, [::1]), and a browser at one of them would not
      // show the cookie at another: nobody could finish signing in. So a
      // browser that asks for the dashboard, or to leave for a provider, at
      // another of this machine's names is sent to the same place at the
      // public one.
      //
      // Only then, and only on the same port. What a proxy passes on as Host
      // is often its own name for this server, not the one the browser asked
      // for (nginx does so unless told otherwise): going by that would send the
      // browser to the public address, and the proxy would hand it back here,
      // without end. A proxy on this very machine listens on another port than
      // this server does, so a Host that differs in the port is its doing too.
      // Everything else is answered where it is asked.
      const home = offered.publicUrl;
      const known = home ? thisMachine(new URL(home).host, new URL(home).protocol) : null;
      if (home && known) {
        app.use("*", async (c, next) => {
          const host = c.req.header("host") ?? "";
          const asked = thisMachine(host, new URL(home).protocol);
          if (c.req.method !== "GET" || !asked || asked.port !== known.port || asked.name === known.name) return next();
          const { pathname, search } = new URL(c.req.url);
          const leaving = PROVIDER_NAMES.some((name) => pathname === `/api/v1/auth/${name}`);
          if (pathname.startsWith("/api/") && !leaving) return next();
          return c.redirect(`${home}${pathname}${search}`, 307);
        });
      }
      // Signing in and signing up need no token, so they come before the API that does.
      app.route("/api/v1/auth", openRoutes(ownerDb, accounts, demo && !("problem" in demo) ? demo.org : undefined));
    },

    early(api) {
      // Where one repository is shown, a report is kept without the paths that
      // are not; and not at all while which those are cannot be told. Later
      // commits of its merged pull requests likewise.
      const refused = (org: string, problem: string) => {
        console.error(`a pull request reported to ${org} is refused:`, problem);
        return { error: "this organisation shows a repository to others, and the server's setting of what not to show cannot be used: the report is not kept", code: "demo_hide_unusable" };
      };
      api.put("/prs", async (c, next) => {
        const shownIn = demo?.org === c.get("principal").orgId ? demo : undefined;
        const report = c.get("report");
        if (shownIn && "problem" in shownIn) return c.json(refused(shownIn.org, shownIn.problem), 503);
        if (shownIn && report) c.set("report", shownReport(report, shownIn.hide));
        await next();
      });
      api.put("/prs/outcomes", async (c, next) => {
        const shownIn = demo?.org === c.get("principal").orgId ? demo : undefined;
        const report = c.get("outcomes");
        if (shownIn && "problem" in shownIn) return c.json(refused(shownIn.org, shownIn.problem), 503);
        if (shownIn && report) c.set("outcomes", shownOutcomes(report, shownIn.hide));
        await next();
      });
      // What CI said of its commits names no path, and the checks that
      // failed are named only where the Action is asked to: a public demo
      // of a public repository keeps them. Refused with the rest while what
      // not to show cannot be told.
      api.put("/prs/ci", async (c, next) => {
        const shownIn = demo?.org === c.get("principal").orgId ? demo : undefined;
        if (shownIn && "problem" in shownIn) return c.json(refused(shownIn.org, shownIn.problem), 503);
        await next();
      });

      // Adding a person puts an organisation in front of them the next time
      // they sign in, on an admin's word, and anyone can be the admin of an
      // organisation they just made. So it is limited per organisation. Taken
      // here, outside the transaction, and given back unless someone really
      // was added.
      api.post("/users", async (c, next) => {
        const p = c.get("principal");
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        // Anything else is refused further on, uncounted.
        if (p.role !== "admin" || !emailFrom(body.email)) return next();
        const perOrg = await take(ownerDb, invitesKey(p.orgId), 3600, INVITES_PER_HOUR);
        if (!perOrg) {
          return c.json({ error: `an organisation can add ${INVITES_PER_HOUR} people an hour; try again later`, code: "rate_limited" }, 429);
        }
        await next();
        if (c.res.status !== 201) await giveBack(ownerDb, perOrg);
      });
    },

    routes(api) {
      // The owner asks for the organisation to be deleted. The name in the body
      // is them saying so on purpose. From the next request, every token of it
      // is refused. The rows go after 7 days.
      api.delete("/org", async (c) => {
        if (!c.get("principal").owner) return c.json({ error: "only the owner of an organisation can do this" }, 403);
        const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
        await deleteOrg(c.get("db"), typeof body?.name === "string" ? body.name : "");
        return c.body(null, 204);
      });
    },

    // Someone who was added signs in with an account that has the address
    // they were added under, and is shown the organisation then; nothing is
    // sent to them. The core puts this on its /users, which only admins reach.
    async addUser(c) {
      if (!offered.providers.length) {
        return c.json({ error: "signing in is not set up here; create a token instead", code: "no_sign_in" }, 409);
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const email = emailFrom(body.email);
      const role = body.role ?? "member";
      if (!email) throw new ApiError(400, "bad_email", "email is required, as a plain address of 254 characters at most");
      if (role !== "admin" && role !== "member") throw new ApiError(400, "bad_role", "role must be admin or member");
      return c.json(await addUser(c.get("db"), newUserId(), email, role, c.get("principal")), 201);
    },

    start() {
      // Organisations whose owner asked for them to be deleted, a week ago.
      // Two replicas must not both do it.
      setInterval(() => {
        void purgeDeletedOrgs(ownerDb)
          .then((ids) => {
            if (ids.length) console.log(`Removed organisations deleted more than 7 days ago: ${ids.join(", ")}`);
          })
          .catch((err) => console.error("purging organisations failed:", err));
      }, 60 * 60_000).unref();
    },

    said: offered.providers.length
      ? [
          `Signing in with ${offered.providers.map((name) => LABELS[name]).join(" and ")} is on${offered.signup ? ", and anyone may sign up" : ""}${offered.signup && offered.inviteCode ? " with the invitation code" : ""}.`,
        ]
      : [],
  };
}
