import { z } from "zod";
import { signDocument } from "./signed-document.ts";

// The license file format: a contract between whoever issues licenses and the Business /
// Enterprise features that verify them. Issuing one only needs this and the private key.

export const LICENSE_FORMAT = "sessionly-license/1";

/** An install's org id, as SESSIONLY_ORG and the license format accept it. */
export const LICENSE_ORG = /^[A-Za-z0-9_-]{1,64}$/;

export const LICENSE_FEATURES = [
  // The organisation sets what uploads from its engineers must contain.
  "content_policy",
] as const;
export type LicenseFeature = (typeof LICENSE_FEATURES)[number];

export const licensePayload = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** The org this install's license belongs to; it must match the install's SESSIONLY_ORG. */
  org: z.string().regex(LICENSE_ORG),
  edition: z.enum(["business", "enterprise"]),
  features: z.array(z.enum(LICENSE_FEATURES)),
  /** People this install may be used for. */
  seats: z.number().int().positive(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type LicensePayload = z.infer<typeof licensePayload>;

/** Sign a license with the issuer's Ed25519 private key (PEM). */
export function signLicense(license: LicensePayload, privateKeyPem: string): string {
  return signDocument(LICENSE_FORMAT, licensePayload.parse(license), privateKeyPem);
}
