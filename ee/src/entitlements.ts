import { ApiError, type Db } from "@sessionly/server";
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
 * The install's license, read from the database and verified offline on every load (a short
 * cache keeps it off the request path). Nothing here can stop capture, upload or the
 * dashboard: it only gates ee/.
 */
export class Entitlements {
  private cached: { until: number; license: License | null } | null = null;
  private readonly db: Db;
  private readonly now: () => Date;
  readonly publicKey: string;
  private readonly ttlMs: number;

  constructor(db: Db, now: () => Date = () => new Date(), publicKey = LICENSE_PUBLIC_KEY, ttlMs = 30_000) {
    this.db = db;
    this.now = now;
    this.publicKey = publicKey;
    this.ttlMs = ttlMs;
  }

  async state(): Promise<LicenseState> {
    const at = this.now();
    if (!this.cached || this.cached.until <= Date.now()) {
      this.cached = { until: Date.now() + this.ttlMs, license: await this.load() };
    }
    return licenseState(this.cached.license, at);
  }

  private async load(): Promise<License | null> {
    const rows = await this.db.query<{ raw: string }>(
      `SELECT raw FROM ee_licenses ORDER BY installed_at DESC`,
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

  forget(): void {
    this.cached = null;
  }

  async can(feature: Feature, mode: "read" | "write"): Promise<boolean> {
    return allows(await this.state(), feature, mode);
  }

  /** Throw the API error that explains why a feature is not available. */
  async require(feature: Feature, mode: "read" | "write"): Promise<void> {
    const state = await this.state();
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
