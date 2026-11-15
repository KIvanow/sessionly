// The HTTP API: uploads from the `sessionly` binary, and the questions the
// dashboard asks. Everything under /api/v1 needs a bearer token.
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  authenticate,
  createToken,
  listTokens,
  revokeToken,
  type Bootstrap,
  type Principal,
  type Role,
} from "./auth.ts";
import type { Db, OrgDb } from "./db.ts";
import { allowed, giveBack, take, type Taken } from "./limits.ts";
import { inviteMail } from "./mail.ts";
import { emailFrom, LINKS_PER_HOUR, mailbox, newLink, newUserId, openRoutes, unsend, type Accounts } from "./signup.ts";
import { addUser, listUsers, orgName, removeUser, UserProblem } from "./users.ts";
import {
  Conflict,
  filterOptions,
  getSession,
  listFiles,
  listSessions,
  storeUpload,
  summarize,
  type Filters,
  type GroupBy,
} from "./sessions.ts";
import type { PullReport } from "@sessionly/schema";
import { BadReport, checkReport, listPulls, storePull, summarizePulls, type PullFilters } from "./pulls.ts";
import { uploadProblems, type Upload } from "./validate.ts";

/** A record lists every tool call, so a long session is several megabytes. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export type Env = {
  Variables: {
    principal: Principal;
    db: OrgDb;
    /** An upload or a pull request report, already parsed and checked. */
    upload?: Upload;
    report?: PullReport;
    /** What to do once the request's transaction has been committed, and only then. */
    after: (() => void)[];
    /** What adding a person was counted against, to be given back if no invitation goes out. */
    invitation?: Taken[];
  };
};

/**
 * The authenticated API router. Every route on it has `c.get("principal")`,
 * who is asking, and `c.get("db")`, the database as their organisation sees
 * it: the only way a route reaches data.
 */
export type Api = Hono<Env>;

/**
 * Adds routes to the authenticated API. This is how optional parts plug in
 * without the core depending on them. A route reaches data through
 * `c.get("db")` and nothing else: an extension is not given the database.
 */
export type Extension = (api: Api) => void;

class BadRequest extends Error {}


/** Thrown to undo what a request wrote, once its answer is already decided. */
class Undo extends Error {}

/** People an organisation may add an hour: each is a message to an address nobody confirmed. */
const INVITES_PER_HOUR = 30;

/** An error an extension wants answered with a given status and a stable code. */
export class ApiError extends Error {
  status: 400 | 403 | 404 | 409;
  code: string;
  constructor(status: 400 | 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function time(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequest(`${name} is not a date or time`);
  return date.toISOString();
}

function filtersFrom(query: Record<string, string>): Filters {
  return {
    user: query.user || undefined,
    repo: query.repo || undefined,
    repo_is: query.repo_is || undefined,
    model: query.model || undefined,
    model_is: query.model_is || undefined,
    tool: query.tool || undefined,
    runtime: whereItRan(query.runtime),
    q: query.q || undefined,
    since: time(query.since, "since"),
    until: time(query.until, "until"),
  };
}

function whereItRan(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value !== "local" && value !== "cloud") throw new BadRequest("runtime must be local or cloud");
  return value;
}

function wholeNumber(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BadRequest(`${name} must be a whole number`);
  return Math.min(n, max);
}

/**
 * Writes out why requests failed: the first few in any ten seconds as they
 * are, and of the rest how many there were, once the ten seconds are over.
 * With the database away every request fails for one reason, thousands of
 * them a second, and a log of nothing else buries what began it.
 */
export function failureLog(
  options: {
    each?: number;
    ms?: number;
    say?: (what: unknown) => void;
    now?: () => number;
    /** Run `fn` in `ms`: a timer that does not keep the process alive, unless a test has its own. */
    later?: (fn: () => void, ms: number) => void;
  } = {},
): (err: unknown) => void {
  const {
    each = 5,
    ms = 10_000,
    say = console.error,
    now = Date.now,
    later = (fn, wait) => void setTimeout(fn, wait).unref(),
  } = options;
  let began = -Infinity;
  let said = 0;
  let left = 0;
  let waiting = false;
  /** Say how many were left out, if any were. */
  const count = () => {
    if (left) say(`${left} more requests failed in those ${ms / 1000} seconds, and are not written out.`);
    left = 0;
  };
  /**
   * Have the count said when the ten seconds that are running end, whether
   * or not anything fails after them. One timer at a time: if by then other
   * ten seconds are running, with requests left out of their own, it waits
   * for those to end too.
   */
  const sayAtTheEnd = () => {
    if (waiting) return;
    waiting = true;
    later(
      () => {
        waiting = false;
        if (now() - began >= ms) count();
        else if (left) sayAtTheEnd();
      },
      Math.max(0, ms - (now() - began)),
    );
  };
  return (err) => {
    if (now() - began >= ms) {
      count();
      began = now();
      said = 0;
    }
    if (said < each) {
      said++;
      say(err);
      return;
    }
    left++;
    sayAtTheEnd();
  };
}

export interface Options {
  bootstrap?: Bootstrap;
  /** Folder with the built dashboard, served at the root if given. */
  webRoot?: string;
  extensions?: Extension[];
  /** Signing in and signing up by email, and what limits them. */
  accounts?: Accounts;
}

/**
 * What the dashboard may load and talk to: itself. Its token is kept in the
 * browser's storage, so a script from anywhere else must never run there.
 */
const DASHBOARD_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * `ownerDb` sees every organisation's rows. Here it only finds whose token a
 * request carries and opens that organisation's transaction; no route below
 * may touch it (`scripts/check-unscoped.mjs` checks each line it is on).
 */
export function createApp(ownerDb: Db, options: Options = {}): Hono<Env> {
  const api = new Hono<Env>();
  const accounts = options.accounts ?? {};
  // Work an answer does not wait for: sending a message that follows it.
  const defer =
    accounts.defer ??
    ((work: () => Promise<void>) => void work().catch((err: unknown) => console.error("work after an answer failed:", err)));

  api.use("*", async (c, next) => {
    const principal = await authenticate(ownerDb, c.req.header("authorization"), options.bootstrap);
    if (!principal) return c.json({ error: "missing or unknown token" }, 401);
    if (accounts.ratePerMinute) {
      const within = await allowed(ownerDb, `token:${principal.tokenId ?? "environment"}`, 60, accounts.ratePerMinute);
      if (!within) return c.json({ error: "too many requests; try again in a minute", code: "rate_limited" }, 429);
    }
    // A ci token reports pull requests and does nothing else.
    if (principal.role === "ci") {
      const reporting = c.req.method === "PUT" && c.req.path.endsWith("/prs");
      if (!reporting && !c.req.path.endsWith("/ping")) {
        return c.json({ error: "this token only reports pull requests" }, 403);
      }
    }
    // An env token uploads the sessions of a cloud environment and does nothing else.
    if (principal.role === "env") {
      const uploading = c.req.method === "PUT" && /\/sessions\/[^/]+\/[^/]+\/[^/]+$/.test(c.req.path);
      if (!uploading && !c.req.path.endsWith("/ping")) {
        return c.json({ error: "this token only uploads sessions" }, 403);
      }
    }
    c.set("principal", principal);
    await next();
  });

  api.use(
    "*",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: "the request is too large" }, 413),
    }),
  );

  // The two large bodies are parsed and checked before the transaction
  // below begins, so that no database connection (or the embedded database,
  // which is a single one) is held while megabytes of JSON are read through.
  api.put("/sessions/:machine/:source/:session", async (c, next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "the body is not JSON" }, 400);
    }
    const problems = uploadProblems(body);
    if (problems) return c.json({ error: "the upload does not match the schema", problems }, 422);
    const upload = body as Upload;
    const s = upload.session ?? {};
    const { machine, source, session } = c.req.param();
    if (!s.machine_id || !s.source || !s.session_id) {
      return c.json({ error: "session.machine_id, source and session_id are required" }, 422);
    }
    if (s.machine_id !== machine || s.source !== source || s.session_id !== session) {
      return c.json({ error: "the address does not match the session in the body" }, 422);
    }
    if (s.content === "local") {
      return c.json({ error: "local records are not for upload; send previews or metadata" }, 422);
    }
    c.set("upload", upload);
    await next();
  });
  api.put("/prs", async (c, next) => {
    if (c.get("principal").role === "member") {
      return c.json({ error: "reporting pull requests needs a ci or admin token" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "the body is not JSON" }, 400);
    }
    c.set("report", checkReport(body));
    await next();
  });

  // Adding a person sends a message to an address on an admin's word, and
  // anyone can be the admin of an organisation they just made. So it is
  // limited per organisation and per mailbox written to. Both are taken
  // here, outside the transaction, and given back unless a message really
  // goes out: asking to add someone who is already there, say, sends none,
  // and must not use up what their address may be sent.
  api.post("/users", async (c, next) => {
    const p = c.get("principal");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = emailFrom(body.email);
    // Anything else is refused further on, uncounted.
    if (p.role !== "admin" || !email) return next();
    const limited = (error: string) => c.json({ error, code: "rate_limited" }, 429);
    const perOrg = await take(ownerDb, `invites:${p.orgId}`, 3600, INVITES_PER_HOUR);
    if (!perOrg) return limited(`an organisation can add ${INVITES_PER_HOUR} people an hour; try again later`);
    const perMailbox = await take(ownerDb, `invite:${mailbox(email)}`, 3600, LINKS_PER_HOUR);
    if (!perMailbox) {
      await giveBack(ownerDb, perOrg);
      return limited("that address has been sent enough invitations for now; try again in an hour");
    }
    c.set("invitation", [perOrg, perMailbox]);
    await next();
    if (c.res.status !== 201) {
      await giveBack(ownerDb, perOrg);
      await giveBack(ownerDb, perMailbox);
    }
  });

  // The rest of the request runs in one transaction, as the organisation of
  // its token: `c.get("db")` sees that organisation's rows and no others.
  api.use("*", async (c, next) => {
    // Any other body is read first too, so that a slow sender holds no
    // connection. As text, which is what an upload or a report was parsed
    // from and is kept: asking for bytes would make a second copy of it.
    if (c.req.raw.body) await c.req.text();
    c.set("after", []);
    try {
      await ownerDb.asOrg(c.get("principal").orgId, async (orgDb) => {
        c.set("db", orgDb);
        await next();
        // A handler that threw has been answered for already (see onError).
        // What it wrote before throwing must not stay.
        if (c.error) throw new Undo();
      });
    } catch (err) {
      if (!(err instanceof Undo)) throw err;
      return;
    }
    // Committed: now what depended on it, such as a message with a link to
    // a row that had to exist first.
    for (const act of c.get("after")) act();
  });

  const failed = failureLog();
  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof BadReport) return c.json({ error: err.message }, 422);
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof UserProblem) return c.json({ error: err.message, code: err.code }, err.status);
    failed(err);
    return c.json({ error: "internal error" }, 500);
  });

  const whoami = (p: Principal) => ({ ok: true, org: p.orgId, email: p.email, name: p.name, role: p.role });
  api.get("/ping", (c) => c.json(whoami(c.get("principal"))));
  api.get("/me", async (c) => {
    const p = c.get("principal");
    return c.json({ ...whoami(p), org_name: await orgName(c.get("db")), signed_in: p.userId !== null });
  });

  // Sign out: the token someone got by signing in stops working.
  api.delete("/auth/session", async (c) => {
    const p = c.get("principal");
    const db = c.get("db");
    if (p.tokenId) {
      await db.query(
        `UPDATE tokens SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND sign_in IS NOT NULL`,
        [db.orgId, p.tokenId],
      );
    }
    return c.json({ signed_out: true });
  });

  // A person's own tokens, for their machines: what `sessionly connect` is given.
  const mine = new Hono<Env>();
  mine.use("*", async (c, next) => {
    const role = c.get("principal").role;
    if (role !== "admin" && role !== "member") return c.json({ error: "this token is not a person's" }, 403);
    await next();
  });
  mine.get("/", async (c) => {
    const db = c.get("db");
    const tokens = await db.query(
      `SELECT id, email, name, role, created_at, last_used_at, revoked_at FROM tokens
       WHERE org_id = $1 AND email = $2 AND role = 'member' AND sign_in IS NULL ORDER BY created_at`,
      [db.orgId, c.get("principal").email],
    );
    return c.json({ tokens });
  });
  mine.post("/", async (c) => {
    const p = c.get("principal");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
    // Always a member's: it uploads this person's sessions and reads only those.
    const created = await createToken(c.get("db"), { email: p.email, name, role: "member", userId: p.userId });
    return c.json({ ...created, email: p.email, name, role: "member" }, 201);
  });
  mine.delete("/:id", async (c) => {
    const db = c.get("db");
    const rows = await db.query(
      `UPDATE tokens SET revoked_at = now()
       WHERE org_id = $1 AND id = $2 AND email = $3 AND role = 'member' AND sign_in IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [db.orgId, c.req.param("id"), c.get("principal").email],
    );
    return rows.length ? c.json({ revoked: true }) : c.json({ error: "no such active token" }, 404);
  });
  api.route("/me/tokens", mine);

  api.put("/sessions/:machine/:source/:session", async (c) => {
    const upload = c.get("upload");
    if (!upload) throw new Error("the upload was not checked");
    let stored: boolean;
    try {
      stored = await storeUpload(c.get("db"), upload, c.get("principal"));
    } catch (err) {
      if (err instanceof Conflict) return c.json({ error: err.message }, 409);
      throw err;
    }
    // Not stored: the server already has more of this cloud session.
    return c.json({ stored });
  });

  api.get("/summary", async (c) => {
    const query = c.req.query();
    const by = (query.by ?? "user") as GroupBy;
    if (!["user", "repo", "model", "tool", "day", "runtime"].includes(by)) {
      throw new BadRequest("by must be user, repo, model, tool, day or runtime");
    }
    return c.json(await summarize(c.get("db"), c.get("principal"), by, filtersFrom(query)));
  });

  api.get("/sessions", async (c) => {
    const query = c.req.query();
    const page = {
      limit: wholeNumber(query.limit, 50, 500, "limit"),
      offset: wholeNumber(query.offset, 0, Number.MAX_SAFE_INTEGER, "offset"),
    };
    return c.json(await listSessions(c.get("db"), c.get("principal"), filtersFrom(query), page));
  });

  api.get("/sessions/:machine/:source/:session", async (c) => {
    const { machine, source, session } = c.req.param();
    const found = await getSession(c.get("db"), c.get("principal"), {
      machine_id: machine,
      source,
      session_id: session,
    });
    return found ? c.json(found) : c.json({ error: "no such session" }, 404);
  });

  api.get("/files", async (c) => {
    const query = c.req.query();
    const limit = wholeNumber(query.limit, 200, 2000, "limit");
    return c.json(await listFiles(c.get("db"), c.get("principal"), filtersFrom(query), limit));
  });

  api.get("/filters", async (c) => c.json(await filterOptions(c.get("db"), c.get("principal"))));

  // Pull requests: the GitHub Action reports them, admins read them.
  const adminsOnly = (p: Principal) => {
    if (p.role !== "admin") throw new ApiError(403, "admins_only", "admins only");
  };
  const pullFilters = (query: Record<string, string>): PullFilters => {
    const state = query.state || undefined;
    if (state && !["open", "merged", "closed"].includes(state)) {
      throw new BadRequest("state must be open, merged or closed");
    }
    return { repo: query.repo || undefined, state, since: time(query.since, "since") };
  };
  api.put("/prs", async (c) => {
    const report = c.get("report");
    if (!report) throw new Error("the report was not checked");
    return c.json({ stored: true, attribution: await storePull(c.get("db"), report) });
  });
  api.get("/prs/summary", async (c) => {
    adminsOnly(c.get("principal"));
    return c.json(await summarizePulls(c.get("db"), pullFilters(c.req.query())));
  });
  api.get("/prs", async (c) => {
    adminsOnly(c.get("principal"));
    const query = c.req.query();
    const page = {
      limit: wholeNumber(query.limit, 50, 500, "limit"),
      offset: wholeNumber(query.offset, 0, Number.MAX_SAFE_INTEGER, "offset"),
    };
    return c.json(await listPulls(c.get("db"), pullFilters(query), page));
  });

  // Token management, for admins.
  const admin = new Hono<Env>();
  admin.use("*", async (c, next) => {
    if (c.get("principal").role !== "admin") return c.json({ error: "admins only" }, 403);
    await next();
  });
  admin.get("/", async (c) => c.json({ tokens: await listTokens(c.get("db")) }));
  admin.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = emailFrom(body.email);
    const role = (body.role ?? "member") as Role;
    if (!email) throw new BadRequest("email is required, as a plain address of 254 characters at most");
    if (role !== "admin" && role !== "member" && role !== "ci" && role !== "env") {
      throw new BadRequest("role must be admin, member, ci or env");
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const created = await createToken(c.get("db"), { email, name, role });
    // The only time the token itself is returned.
    return c.json({ ...created, email, name, role }, 201);
  });
  admin.delete("/:id", async (c) =>
    (await revokeToken(c.get("db"), c.req.param("id")))
      ? c.json({ revoked: true })
      : c.json({ error: "no such active token" }, 404),
  );
  api.route("/tokens", admin);

  // The people of the organisation, for admins. Adding someone sends them a
  // link to sign in with.
  const users = new Hono<Env>();
  users.use("*", async (c, next) => {
    if (c.get("principal").role !== "admin") return c.json({ error: "admins only" }, 403);
    await next();
  });
  users.get("/", async (c) => c.json({ users: await listUsers(c.get("db")) }));
  users.post("/", async (c) => {
    const { mailer, publicUrl } = accounts;
    if (!mailer || !publicUrl) {
      return c.json({ error: "signing in by email is not set up here; create a token instead", code: "no_email" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = emailFrom(body.email);
    const role = body.role ?? "member";
    if (!email) throw new BadRequest("email is required, as a plain address of 254 characters at most");
    if (role !== "admin" && role !== "member") throw new BadRequest("role must be admin or member");
    const db = c.get("db");
    const p = c.get("principal");
    const user = await addUser(db, newUserId(), email, role, p);
    const link = await newLink(db, publicUrl, { purpose: "invite", userId: user.id });
    const mail = inviteMail(email, link.url);
    const counted = c.get("invitation") ?? [];
    // Sent once the person and their link are really there. If it cannot
    // be sent, the link is forgotten and the message is not one of those
    // counted: the person is in, and asks for a link on the sign-in page.
    c.get("after").push(() =>
      defer(async () => {
        try {
          await mailer.send(mail);
        } catch (err) {
          console.error("an invitation was not sent:", err instanceof Error ? err.message : err);
          await unsend(ownerDb, [link], counted);
        }
      }),
    );
    return c.json(user, 201);
  });
  users.delete("/:id", async (c) => {
    await removeUser(c.get("db"), c.req.param("id"), c.get("principal"));
    return c.json({ removed: true });
  });
  api.route("/users", users);

  for (const extend of options.extensions ?? []) extend(api);

  const app = new Hono<Env>();
  // For whatever keeps the server running: alive, and able to reach its database.
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await ownerDb.query(`SELECT 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  // Signing in and signing up need no token, so they come before the API that does.
  app.route("/api/v1/auth", openRoutes(ownerDb, accounts));
  app.route("/api/v1", api);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  if (options.webRoot) {
    app.use("/*", async (c, next) => {
      await next();
      c.header("Content-Security-Policy", DASHBOARD_POLICY);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
    });
    app.use("/*", serveStatic({ root: options.webRoot }));
  }
  return app;
}
