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
import type { Db } from "./db.ts";
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
import { uploadProblems, type Upload } from "./validate.ts";

/** A record lists every tool call, so a long session is several megabytes. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export type Env = { Variables: { principal: Principal } };

/** The authenticated API router: every route on it has `c.get("principal")`. */
export type Api = Hono<Env>;

/**
 * Adds routes to the authenticated API. This is how optional parts plug in
 * without the core depending on them.
 */
export type Extension = (api: Api, ctx: { db: Db }) => void;

class BadRequest extends Error {}

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
    tool: query.tool || undefined,
    q: query.q || undefined,
    since: time(query.since, "since"),
    until: time(query.until, "until"),
  };
}

function wholeNumber(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BadRequest(`${name} must be a whole number`);
  return Math.min(n, max);
}

export interface Options {
  bootstrap?: Bootstrap;
  /** Folder with the built dashboard, served at the root if given. */
  webRoot?: string;
  extensions?: Extension[];
}

export function createApp(db: Db, options: Options = {}): Hono<Env> {
  const api = new Hono<Env>();

  api.use("*", async (c, next) => {
    const principal = await authenticate(db, c.req.header("authorization"), options.bootstrap);
    if (!principal) return c.json({ error: "missing or unknown token" }, 401);
    c.set("principal", principal);
    await next();
  });

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  const whoami = (p: Principal) => ({ ok: true, email: p.email, name: p.name, role: p.role });
  api.get("/ping", (c) => c.json(whoami(c.get("principal"))));
  api.get("/me", (c) => c.json(whoami(c.get("principal"))));

  api.put(
    "/sessions/:machine/:source/:session",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: "the upload is too large" }, 413),
    }),
    async (c) => {
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
      try {
        await storeUpload(db, upload, c.get("principal"));
      } catch (err) {
        if (err instanceof Conflict) return c.json({ error: err.message }, 409);
        throw err;
      }
      return c.json({ stored: true });
    },
  );

  api.get("/summary", async (c) => {
    const query = c.req.query();
    const by = (query.by ?? "user") as GroupBy;
    if (!["user", "repo", "model", "tool", "day"].includes(by)) {
      throw new BadRequest("by must be user, repo, model, tool or day");
    }
    return c.json(await summarize(db, c.get("principal"), by, filtersFrom(query)));
  });

  api.get("/sessions", async (c) => {
    const query = c.req.query();
    const page = {
      limit: wholeNumber(query.limit, 50, 500, "limit"),
      offset: wholeNumber(query.offset, 0, Number.MAX_SAFE_INTEGER, "offset"),
    };
    return c.json(await listSessions(db, c.get("principal"), filtersFrom(query), page));
  });

  api.get("/sessions/:machine/:source/:session", async (c) => {
    const { machine, source, session } = c.req.param();
    const found = await getSession(db, c.get("principal"), {
      machine_id: machine,
      source,
      session_id: session,
    });
    return found ? c.json(found) : c.json({ error: "no such session" }, 404);
  });

  api.get("/files", async (c) => {
    const query = c.req.query();
    const limit = wholeNumber(query.limit, 200, 2000, "limit");
    return c.json(await listFiles(db, c.get("principal"), filtersFrom(query), limit));
  });

  api.get("/filters", async (c) => c.json(await filterOptions(db, c.get("principal"))));

  // Token management, for admins.
  const admin = new Hono<Env>();
  admin.use("*", async (c, next) => {
    if (c.get("principal").role !== "admin") return c.json({ error: "admins only" }, 403);
    await next();
  });
  admin.get("/", async (c) => c.json({ tokens: await listTokens(db) }));
  admin.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const role = (body.role ?? "member") as Role;
    if (!/^\S+@\S+$/.test(email)) throw new BadRequest("email is required");
    if (role !== "admin" && role !== "member") throw new BadRequest("role must be admin or member");
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const created = await createToken(db, { email, name, role });
    // The only time the token itself is returned.
    return c.json({ ...created, email: email.toLowerCase(), name, role }, 201);
  });
  admin.delete("/:id", async (c) =>
    (await revokeToken(db, c.req.param("id")))
      ? c.json({ revoked: true })
      : c.json({ error: "no such active token" }, 404),
  );
  api.route("/tokens", admin);

  for (const extend of options.extensions ?? []) extend(api, { db });

  const app = new Hono<Env>();
  app.route("/api/v1", api);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  if (options.webRoot) {
    app.use("/*", serveStatic({ root: options.webRoot }));
  }
  return app;
}
