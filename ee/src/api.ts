import { ApiError, type Api, type Extension } from "@sessionly/server";
import type { Entitlements } from "./entitlements.ts";
import { LicenseError, verifyLicense } from "./license/license.ts";

export interface EeDeps {
  entitlements: Entitlements;
  /** This install's org id (SESSIONLY_ORG), or null if it is not set. */
  org: string | null;
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
  return (api, { db }) => {
    // --- License -----------------------------------------------------------
    const view = async () => {
      const [people] = await db.query<{ n: unknown }>(
        `SELECT count(DISTINCT email) AS n FROM tokens WHERE revoked_at IS NULL`,
      );
      return { ...(await ent.state()), org, people: Number(people?.n ?? 0) };
    };

    // License status: verified offline; no license means core features only.
    api.get("/license", async (c) => c.json(await view()));

    requireAdmin(api, "/license", ["POST"]);
    api.post("/license", async (c) => {
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
      await db.query(
        `INSERT INTO ee_licenses (id, org, raw, expires_at, installed_by, installed_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6::timestamptz)
         ON CONFLICT (id) DO UPDATE SET org = EXCLUDED.org, raw = EXCLUDED.raw,
           expires_at = EXCLUDED.expires_at, installed_by = EXCLUDED.installed_by,
           installed_at = EXCLUDED.installed_at`,
        [license.id, license.org, body.license, license.expiresAt, c.get("principal").email, now().toISOString()],
      );
      ent.forget();
      return c.json(await view(), 201);
    });

    // --- Content policy (feature: content_policy) --------------------------
    // What the organisation asks its engineers' uploads to contain.
    api.get("/policy", async (c) => {
      await ent.require("content_policy", "read");
      const [row] = await db.query<{ content: string; updated_by: string; updated_at: unknown }>(
        `SELECT content, updated_by, updated_at FROM ee_content_policy WHERE id = 1`,
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
      await ent.require("content_policy", "write");
      const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
      const content = CONTENT_LEVELS.find((level) => level === body.content);
      if (!content) {
        throw new ApiError(400, "bad_policy", `content must be one of: ${CONTENT_LEVELS.join(", ")}`);
      }
      const at = now().toISOString();
      await db.query(
        `INSERT INTO ee_content_policy (id, content, updated_by, updated_at)
         VALUES (1, $1, $2, $3::timestamptz)
         ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [content, c.get("principal").email, at],
      );
      return c.json({ content, updated_by: c.get("principal").email, updated_at: at });
    });
  };
}
