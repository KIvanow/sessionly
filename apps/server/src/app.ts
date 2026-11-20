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
import { shownReport } from "./demo.ts";
import { exportLines } from "./export.ts";
import { allowed, exportKey, giveBack, invitesKey, onceEvery, take } from "./limits.ts";
import { PROVIDER_NAMES } from "./oauth.ts";
import { emailFrom, newUserId, offers, openRoutes, type Accounts } from "./signup.ts";
import { deleteOrg, OrgNameError } from "./orgs.ts";
import { addUser, forgetAccount, listUsers, orgName, removeUser, UserProblem } from "./users.ts";
import {
  Conflict,
  excludeRepo,
  filterOptions,
  getSession,
  heldSessions,
  includeRepo,
  listExcluded,
  listFiles,
  listSessions,
  RemovedPerson,
  RepoNameError,
  removeUpload,
  storeUpload,
  summarize,
  type Filters,
  type GroupBy,
} from "./sessions.ts";
import type { PullReport, Telemetry } from "@sessionly/schema";
import {
  BadReport,
  checkReport,
  getPull,
  listPulls,
  rematchPull,
  rematchPulls,
  pullsAddedTo,
  storePull,
  summarizePulls,
  type PullFilters,
} from "./pulls.ts";
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
    /** The session an upload stored: the pull requests it adds lines to are matched again once it is committed. */
    stored?: { machine_id: string; source: string; session_id: string };
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

/**
 * What a request to match pull requests again asks for: one (`repo` and
 * `number`), or those the list's filters choose. Anything that cannot be
 * read as that is refused: left out, it would choose more than was meant.
 */
function matchAsked(sent: unknown): { repo?: string; state?: string; since?: string; started?: string; number?: number } {
  if (typeof sent !== "object" || sent === null || Array.isArray(sent)) throw new BadRequest("the body is not a JSON object");
  const body = sent as Record<string, unknown>;
  const said = (key: string) => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new BadRequest(`${key} must be text`);
    return value;
  };
  const asked = { repo: said("repo"), state: said("state"), since: said("since"), started: said("started") };
  if (!("number" in body)) return asked;
  const number = body.number;
  // No higher than the column holds.
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > 2147483647) {
    throw new BadRequest("number must be a pull request number");
  }
  return { ...asked, number };
}

function filtersFrom(query: Record<string, string>): Filters {
  return {
    user: query.user || undefined,
    user_is: query.user_is || undefined,
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

export interface Options {
  bootstrap?: Bootstrap;
  /** Folder with the built dashboard, served at the root if given. */
  webRoot?: string;
  extensions?: Extension[];
  /** Signing in and signing up with Google or GitHub, and what limits them. */
  accounts?: Accounts;
  /** Where the dashboard counts which of its pages are opened; none: it counts nothing. */
  telemetry?: Telemetry | null;
  /** What the committers kept of a pull request are hashed with (SESSIONLY_HASH_KEY); none: a plain hash. */
  hashKey?: string;
  /**
   * The organisation one repository is shown in (demo.ts), and the paths of
   * it that are not shown; or why those cannot be trusted, and reports to it
   * are refused (`reportsShownIn`).
   */
  demo?: { org: string; hide: string[] } | { org: string; problem: string };
}

/**
 * What the dashboard may load and talk to: itself, and the address it counts
 * its pages at if it does. Its token is kept in the browser's storage, so a
 * script from anywhere else must never run there: the counting is part of the
 * dashboard's own code, and only sends.
 */
export function dashboardPolicy(telemetry?: Telemetry | null): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    telemetry ? `connect-src 'self' ${new URL(telemetry.host).origin}` : "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * `ownerDb` sees every organisation's rows. Here it only finds whose token a
 * request carries and opens that organisation's transaction; no route below
 * may touch it (`scripts/check-unscoped.mjs` checks each line it is on).
 */
/**
 * Reading pull requests takes several statements, whose figures and
 * sessions have to be of one moment: a report stored between two of them
 * would otherwise leave lines of before beside costs of after.
 */
const readsPulls = (method: string, path: string): boolean => method === "GET" && /\/prs(?:\/[a-z]+)?$/.test(path);

export function createApp(ownerDb: Db, options: Options = {}): Hono<Env> {
  const api = new Hono<Env>();
  const accounts = options.accounts ?? {};

  api.use("*", async (c, next) => {
    const principal = await authenticate(ownerDb, c.req.header("authorization"), options.bootstrap, {
      hosted: options.accounts?.hosted === true,
    });
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
    // An env token uploads the sessions of a cloud environment and does nothing
    // else, but for taking one back: as for anyone, only one filed under the
    // token's own address, never one filed under a person the platform named.
    if (principal.role === "env") {
      const uploading =
        (c.req.method === "PUT" || c.req.method === "DELETE") && /\/sessions\/[^/]+\/[^/]+\/[^/]+$/.test(c.req.path);
      if (!uploading && !c.req.path.endsWith("/ping")) {
        return c.json({ error: "this token only uploads sessions" }, 403);
      }
    }
    // A viewer, of the organisation a repository is shown in, reads and does nothing else, but for signing out.
    if (principal.role === "viewer") {
      const signingOut = c.req.method === "DELETE" && c.req.path.endsWith("/auth/session");
      if (c.req.method !== "GET" && !signingOut) {
        return c.json({ error: "a viewer can only look", code: "viewer" }, 403);
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
    const report = checkReport(body);
    // Where one repository is shown, a report is kept without the paths that
    // are not; and not at all while which those are cannot be told.
    const demo = options.demo?.org === c.get("principal").orgId ? options.demo : undefined;
    if (demo && "problem" in demo) {
      console.error(`a pull request reported to ${demo.org} is refused:`, demo.problem);
      return c.json({ error: "this organisation shows a repository to others, and the server's setting of what not to show cannot be used: the report is not kept", code: "demo_hide_unusable" }, 503);
    }
    c.set("report", demo ? shownReport(report, demo.hide) : report);
    await next();
  });

  // Matching again the pull requests the list's filters choose. Each has a
  // transaction of its own, so this is answered here, before the one the
  // rest of a request runs in: none is held for as long as all of them take.
  api.post("/prs/match", async (c, next) => {
    const asked = matchAsked(await c.req.json().catch(() => null));
    if (asked.number !== undefined) return next();
    adminsOnly(c.get("principal"));
    const filters = pullFilters({ repo: asked.repo ?? "", state: asked.state ?? "", since: asked.since ?? "" });
    const each = <T>(fn: (db: OrgDb) => Promise<T>) => ownerDb.asOrg(c.get("principal").orgId, fn);
    return c.json(await rematchPulls(each, filters, time(asked.started, "started"), options.hashKey, failed));
  });

  // The pull requests a session just stored adds lines to are found and
  // matched again once it is committed, each in a transaction of its own, as
  // above. What fails is logged: the session is stored all the same.
  api.put("/sessions/:machine/:source/:session", async (c, next) => {
    await next();
    const stored = c.get("stored");
    if (c.res.status !== 200 || !stored) return;
    try {
      for (const { repo, number } of await ownerDb.asOrg(c.get("principal").orgId, (db) => pullsAddedTo(db, stored, options.hashKey))) {
        try {
          await ownerDb.asOrg(c.get("principal").orgId, (db) => rematchPull(db, repo, number, options.hashKey, { uploaded: true }));
        } catch (err) {
          failed(err);
        }
      }
    } catch (err) {
      failed(err);
    }
  });

  // Adding a person puts an organisation in front of them the next time
  // they sign in, on an admin's word, and anyone can be the admin of an
  // organisation they just made. So it is limited per organisation. Taken
  // here, outside the transaction, and given back unless someone really
  // was added.
  api.post("/users", async (c, next) => {
    const p = c.get("principal");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = emailFrom(body.email);
    // Anything else is refused further on, uncounted.
    if (p.role !== "admin" || !email) return next();
    const limited = (error: string) => c.json({ error, code: "rate_limited" }, 429);
    const perOrg = await take(ownerDb, invitesKey(p.orgId), 3600, INVITES_PER_HOUR);
    if (!perOrg) return limited(`an organisation can add ${INVITES_PER_HOUR} people an hour; try again later`);
    await next();
    if (c.res.status !== 201) await giveBack(ownerDb, perOrg);
  });

  // The organisation's data, as a file. Read a page at a time, each in its
  // own transaction, and before the one transaction the rest of a request
  // runs in: the embedded database has a single connection, and holding it
  // for the whole download would stop every other request. The next page is
  // read when the client takes another line, so a slow download does not
  // queue the rest of the organisation.
  api.get("/export", async (c) => {
    const p = c.get("principal");
    if (!p.owner) return c.json({ error: "only the owner of an organisation can do this" }, 403);
    // Counted from the last export that was allowed, inside one transaction so
    // two at once cannot both pass. A refusal above takes none of the ten minutes.
    const within = await ownerDb.transaction((tx) => onceEvery(tx, exportKey(p.orgId), 600));
    if (!within) {
      return c.json(
        { error: "an organisation can be exported once every ten minutes; try again later", code: "rate_limited" },
        429,
      );
    }
    const exportedAt = new Date().toISOString();
    const filename = `sessionly-${p.orgId}-${exportedAt.slice(0, 10)}.jsonl`;
    c.header("content-type", "application/x-ndjson; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    const each = <T>(fn: (db: OrgDb) => Promise<T>) => ownerDb.asOrg(c.get("principal").orgId, fn);
    const encoder = new TextEncoder();
    const lines = exportLines(each, exportedAt);
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const next = await lines.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        await lines.return(undefined);
      },
    });
    return c.body(body);
  });

  // The rest of the request runs in one transaction, as the organisation of
  // its token: `c.get("db")` sees that organisation's rows and no others.
  api.use("*", async (c, next) => {
    // Any other body is read first too, so that a slow sender holds no
    // connection. As text, which is what an upload or a report was parsed
    // from and is kept: asking for bytes would make a second copy of it.
    if (c.req.raw.body) await c.req.text();
    try {
      await ownerDb.asOrg(c.get("principal").orgId, async (orgDb) => {
        c.set("db", orgDb);
        await next();
        // A handler that threw has been answered for already (see onError).
        // What it wrote before throwing must not stay.
        if (c.error) throw new Undo();
      }, { snapshot: readsPulls(c.req.method, c.req.path) });
    } catch (err) {
      if (!(err instanceof Undo)) throw err;
    }
  });

  const failed = failureLog();
  api.onError((err, c) => {
    if (err instanceof BadRequest || err instanceof RepoNameError || err instanceof OrgNameError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof RemovedPerson) {
      return c.json({ error: err.message, code: "person_removed", ...err.answer }, 403);
    }
    if (err instanceof BadReport) return c.json({ error: err.message }, 422);
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof UserProblem) return c.json({ error: err.message, code: err.code }, err.status);
    failed(err);
    return c.json({ error: "internal error" }, 500);
  });

  const whoami = (p: Principal) => ({ ok: true, org: p.orgId, email: p.email, name: p.name, role: p.role });
  // The owner asks for the organisation to be deleted. The name in the body
  // is them saying so on purpose. From the next request, every token of it
  // is refused. The rows go after 7 days. A server of one team has no such
  // request: whoever runs it drops the database.
  api.delete("/org", async (c) => {
    if (!c.get("principal").owner) return c.json({ error: "only the owner of an organisation can do this" }, 403);
    if (options.accounts?.hosted !== true) {
      return c.json(
        { error: "deleting an organisation is for the hosted service; on a server of your own, drop the database" },
        403,
      );
    }
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    await deleteOrg(c.get("db"), typeof body?.name === "string" ? body.name : "");
    return c.body(null, 204);
  });

  api.get("/ping", (c) => c.json(whoami(c.get("principal"))));
  api.get("/me", async (c) => {
    const p = c.get("principal");
    return c.json({
      ...whoami(p),
      org_name: await orgName(c.get("db")),
      signed_in: p.userId !== null,
      owner: p.owner,
    });
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
    let result: { stored: boolean; excluded?: true };
    try {
      result = await storeUpload(c.get("db"), upload, c.get("principal"));
    } catch (err) {
      if (err instanceof Conflict) return c.json({ error: err.message }, 409);
      throw err;
    }
    if (result.stored) {
      const { machine, source, session } = c.req.param();
      c.set("stored", { machine_id: machine, source, session_id: session });
    }
    // Not stored, and not excluded: the server already has more of this cloud session.
    // Excluded: the person stopped the repository, so the session was not kept.
    return c.json(result);
  });

  // The uploader takes a session back: its machine no longer has it as one
  // (a subagent's thread, since folded into the session that started it).
  // Having none of theirs to remove is an answer too, not a failure: a 404
  // here is left to mean a server that has no such address yet.
  api.delete("/sessions/:machine/:source/:session", async (c) => {
    const { machine, source, session } = c.req.param();
    const removed = await removeUpload(c.get("db"), c.get("principal"), {
      machine_id: machine,
      source,
      session_id: session,
    });
    return c.json({ removed });
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

  // Which sessions of theirs the server has from one machine, whoever asks:
  // an admin's machine is told of the admin's sessions, like anyone's.
  api.get("/sessions/held", async (c) => {
    const p = c.get("principal");
    if (p.role !== "admin" && p.role !== "member") return c.json({ error: "this token is not a person's" }, 403);
    const machine = c.req.query("machine");
    if (!machine) throw new BadRequest("name the machine");
    return c.json(await heldSessions(c.get("db"), p.email, machine));
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

  // Repositories a person stopped submitting. Only their own sessions are
  // deleted; a token that is not a person's cannot do this (ci and env are
  // already refused above, and this refuses anything else).
  const excluded = new Hono<Env>();
  excluded.use("*", async (c, next) => {
    const role = c.get("principal").role;
    if (role !== "admin" && role !== "member") return c.json({ error: "this token is not a person's" }, 403);
    await next();
  });
  excluded.get("/", async (c) => c.json(await listExcluded(c.get("db"), c.get("principal").email)));
  excluded.put("/", async (c) => {
    // Any JSON is a body, `null` too: only an object can name a repository.
    const body = (await c.req.json().catch(() => null)) as { repo?: unknown } | null;
    return c.json(await excludeRepo(c.get("db"), c.get("principal").email, body?.repo));
  });
  excluded.delete("/", async (c) => {
    const repo = await includeRepo(c.get("db"), c.get("principal").email, c.req.query("repo"));
    return repo ? c.json({ repo, removed: true }) : c.json({ error: "no such repository" }, 404);
  });
  api.route("/repos/excluded", excluded);

  // Pull requests: the GitHub Action reports them, admins read them.
  const adminsOnly = (p: Principal) => {
    if (p.role !== "admin") throw new ApiError(403, "admins_only", "admins only");
  };
  /** What an admin can read, a viewer can read too. */
  const readersOnly = (p: Principal) => {
    if (p.role !== "admin" && p.role !== "viewer") throw new ApiError(403, "admins_only", "admins only");
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
    return c.json({ stored: true, attribution: await storePull(c.get("db"), report, options.hashKey) });
  });
  api.get("/prs/summary", async (c) => {
    readersOnly(c.get("principal"));
    return c.json(await summarizePulls(c.get("db"), pullFilters(c.req.query())));
  });
  // The repository's name has slashes in it, so it is asked for by query.
  api.get("/prs/detail", async (c) => {
    readersOnly(c.get("principal"));
    const query = c.req.query();
    if (!query.repo) throw new BadRequest("repo is required");
    const number = wholeNumber(query.number, 0, 2 ** 31 - 1, "number");
    const pull = await getPull(c.get("db"), query.repo, number);
    return pull ? c.json(pull) : c.json({ error: "no such pull request" }, 404);
  });
  // Match one pull request's lines again against the sessions held now.
  // (Several, which the list's filters choose, are matched further up.)
  api.post("/prs/match", async (c) => {
    adminsOnly(c.get("principal"));
    const { repo, number } = matchAsked(await c.req.json().catch(() => null));
    if (!repo) throw new BadRequest("repo is required");
    const matched = await rematchPull(c.get("db"), repo, number!, options.hashKey);
    if (!matched) return c.json({ error: "no such pull request" }, 404);
    if (matched === "needs_report") {
      throw new ApiError(
        409,
        "needs_report",
        "this pull request was last reported before what it is matched by was kept; the Action has to report it once more",
      );
    }
    return c.json(matched);
  });
  api.get("/prs", async (c) => {
    readersOnly(c.get("principal"));
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

  // The people of the organisation, for admins. Someone who was added signs
  // in with an account that has the address they were added under, and is
  // shown the organisation then; nothing is sent to them.
  const users = new Hono<Env>();
  users.use("*", async (c, next) => {
    if (c.get("principal").role !== "admin") return c.json({ error: "admins only" }, 403);
    await next();
  });
  users.get("/", async (c) => c.json({ users: await listUsers(c.get("db")) }));
  users.post("/", async (c) => {
    if (!offers(accounts).providers.length) {
      return c.json({ error: "signing in is not set up here; create a token instead", code: "no_sign_in" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = emailFrom(body.email);
    const role = body.role ?? "member";
    if (!email) throw new BadRequest("email is required, as a plain address of 254 characters at most");
    if (role !== "admin" && role !== "member") throw new BadRequest("role must be admin or member");
    const user = await addUser(c.get("db"), newUserId(), email, role, c.get("principal"));
    return c.json(user, 201);
  });
  users.delete("/:id", async (c) => {
    // data=true also deletes their sessions and the repositories they stopped.
    // Anything else is the removal alone, as it always was.
    await removeUser(c.get("db"), c.req.param("id"), c.get("principal"), { data: c.req.query("data") === "true" });
    return c.json({ removed: true });
  });
  // Let someone in with another account than the one they signed in with:
  // for anyone but oneself, the owner included, who cannot be removed.
  users.post("/:id/forget-account", async (c) =>
    c.json(await forgetAccount(c.get("db"), { id: c.req.param("id") }, c.get("principal"))),
  );
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
  const home = offers(accounts).publicUrl;
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
  app.route("/api/v1/auth", openRoutes(ownerDb, accounts, options.demo && !("problem" in options.demo) ? options.demo.org : undefined));
  // Asked before anyone signs in, so that a page is counted whoever opens it.
  const telemetry = options.telemetry ?? null;
  app.get("/api/v1/telemetry", (c) => c.json(telemetry));
  app.route("/api/v1", api);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  if (options.webRoot) {
    const policy = dashboardPolicy(telemetry);
    app.use("/*", async (c, next) => {
      await next();
      c.header("Content-Security-Policy", policy);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
    });
    app.use("/*", serveStatic({ root: options.webRoot }));
  }
  return app;
}
