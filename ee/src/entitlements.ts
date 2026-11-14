import { ApiError, type OrgDb } from "@sessionly/server";
import { LICENSE_PUBLIC_KEY } from "./license/keys.ts";
import {
  allows,
  licenseState,
  verifyLicense,
  type Feature,
  type License,
  type LicenseState,
} from "./license/license.ts";

/**
 * An organisation's license, read from the database and verified offline on every load (a
 * short cache keeps it off the request path). Nothing here can stop capture, upload or the
 * dashboard: it only gates ee/. Each method takes the request's database, which is where the
 * organisation comes from.
 */
export class Entitlements {
  private readonly cached = new Map<string, { until: number; license: License | null }>();
  private readonly now: () => Date;
  readonly publicKey: string;
  private readonly ttlMs: number;

  constructor(now: () => Date = () => new Date(), publicKey = LICENSE_PUBLIC_KEY, ttlMs = 30_000) {
    this.now = now;
    this.publicKey = publicKey;
    this.ttlMs = ttlMs;
  }

  async state(db: OrgDb): Promise<LicenseState> {
    const at = this.now();
    let known = this.cached.get(db.orgId);
    if (!known || known.until <= Date.now()) {
      known = { until: Date.now() + this.ttlMs, license: await this.load(db) };
      this.cached.set(db.orgId, known);
    }
    return licenseState(known.license, at);
  }

  private async load(db: OrgDb): Promise<License | null> {
    const rows = await db.query<{ raw: string }>(
      `SELECT raw FROM ee_licenses WHERE org_id = $1 ORDER BY installed_at DESC`,
      [db.orgId],
    );
    // The newest one that still verifies (a row edited in the database does not).
    for (const row of rows) {
      try {
        return verifyLicense(row.raw, this.publicKey);
      } catch {
        continue;
      }
    }
    return null;
  }

  forget(orgId: string): void {
    this.cached.delete(orgId);
  }

  async can(db: OrgDb, feature: Feature, mode: "read" | "write"): Promise<boolean> {
    return allows(await this.state(db), feature, mode);
  }

  /** Throw the API error that explains why a feature is not available. */
  async require(db: OrgDb, feature: Feature, mode: "read" | "write"): Promise<void> {
    const state = await this.state(db);
    if (allows(state, feature, mode)) return;
    if (state.license?.features.includes(feature)) {
      throw new ApiError(
        403,
        "license_expired",
        `The license expired; ${feature} has been read-only since ${state.readOnlyAt}. Install a renewed license.`,
      );
    }
    throw new ApiError(
      403,
      "license_required",
      `This needs a Business or Enterprise license that includes ${feature}.`,
    );
  }
}
