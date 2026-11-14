import { ApiError, type Api, type Extension, type OrgDb } from "@sessionly/server";
import type { Entitlements } from "./entitlements.ts";
import { LicenseError, verifyLicense } from "./license/license.ts";

export interface EeDeps {
  entitlements: Entitlements;
  /** The org id a license must name (SESSIONLY_ORG), or null if it is not set. */
  org: string | null;
  /**
   * A service many organisations share. Licenses are for a single install:
   * the one org id a license is checked against is the whole server's, so
   * there no organisation may install one.
   */
  hosted?: boolean;
  now?: () => Date;
}

/** What an organisation can ask uploads to contain. */
const CONTENT_LEVELS = ["metadata", "previews"] as const;

function requireAdmin(api: Api, path: string, methods: string[]): void {
  api.on(methods, path, async (c, next) => {
    if (c.get("principal").role !== "admin") {
      throw new ApiError(403, "admins_only", "Only an admin can do this.");
    }
    await next();
  });
}

/** The Business and Enterprise routes, added to the core's authenticated API. */
export function eeApi(deps: EeDeps): Extension {
  const { entitlements: ent, org } = deps;
  const now = deps.now ?? (() => new Date());
  // Every route reads the request's database: its organisation's rows only.
  return (api) => {
    // --- License -----------------------------------------------------------
    const view = async (db: OrgDb) => {
      const [people] = await db.query<{ n: unknown }>(
        `SELECT count(DISTINCT email) AS n FROM tokens WHERE org_id = $1 AND revoked_at IS NULL`,
        [db.orgId],
      );
      return { ...(await ent.state(db)), org, people: Number(people?.n ?? 0) };
    };

    // License status: verified offline; no license means core features only.
    api.get("/license", async (c) => c.json(await view(c.get("db"))));

    requireAdmin(api, "/license", ["POST"]);
    api.post("/license", async (c) => {
      if (deps.hosted) {
        throw new ApiError(403, "no_licenses_here", "Licenses are for a self-hosted server. Here, features come with the plan.");
      }
      const body = (await c.req.json().catch(() => ({}))) as { license?: unknown };
      if (typeof body.license !== "string" || !body.license || body.license.length > 16_384) {
        throw new ApiError(400, "license_malformed", "Send the license file's text as `license`.");
      }
      let license;
      try {
        license = verifyLicense(body.license, ent.publicKey);
      } catch (err) {
        if (err instanceof LicenseError) {
          throw new ApiError(400, `license_${err.code}`, `License rejected: ${err.message}`);
        }
        throw err;
      }
      if (!org) {
        throw new ApiError(400, "org_not_set", "Set SESSIONLY_ORG to this install's org id first.");
      }
      if (license.org !== org) {
        throw new ApiError(403, "license_wrong_org", `This license belongs to org ${license.org}.`);
      }
      if (Date.parse(license.expiresAt) <= now().getTime()) {
        throw new ApiError(400, "license_expired", "This license has already expired.");
      }
      const db = c.get("db");
      await db.query(
        `INSERT INTO ee_licenses (org_id, id, org, raw, expires_at, installed_by, installed_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz)
         ON CONFLICT (org_id, id) DO UPDATE SET org = EXCLUDED.org, raw = EXCLUDED.raw,
           expires_at = EXCLUDED.expires_at, installed_by = EXCLUDED.installed_by,
           installed_at = EXCLUDED.installed_at`,
        [db.orgId, license.id, license.org, body.license, license.expiresAt, c.get("principal").email, now().toISOString()],
      );
      ent.forget(db.orgId);
      const installed = await view(db);
      // What was just read is not committed yet. If the commit fails, the
      // next request must not find it remembered.
      ent.forget(db.orgId);
      return c.json(installed, 201);
    });

    // --- Content policy (feature: content_policy) --------------------------
    // What the organisation asks its engineers' uploads to contain.
    api.get("/policy", async (c) => {
      const db = c.get("db");
      await ent.require(db, "content_policy", "read");
      const [row] = await db.query<{ content: string; updated_by: string; updated_at: unknown }>(
        `SELECT content, updated_by, updated_at FROM ee_content_policy WHERE org_id = $1`,
        [db.orgId],
      );
      return c.json({
        content: row?.content ?? "metadata",
        updated_by: row?.updated_by ?? null,
        updated_at: !row
          ? null
          : row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : new Date(String(row.updated_at)).toISOString(),
      });
    });

    requireAdmin(api, "/policy", ["PUT"]);
    api.put("/policy", async (c) => {
      const db = c.get("db");
      await ent.require(db, "content_policy", "write");
      const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
      const content = CONTENT_LEVELS.find((level) => level === body.content);
      if (!content) {
        throw new ApiError(400, "bad_policy", `content must be one of: ${CONTENT_LEVELS.join(", ")}`);
      }
      const at = now().toISOString();
      await db.query(
        `INSERT INTO ee_content_policy (org_id, content, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (org_id) DO UPDATE SET content = EXCLUDED.content,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [db.orgId, content, c.get("principal").email, at],
      );
      return c.json({ content, updated_by: c.get("principal").email, updated_at: at });
    });
  };
}
