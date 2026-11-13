import { generateKeyPairSync } from "node:crypto";
import type { License } from "../src/license/license.ts";

/** A key pair standing in for the issuer's (the real private key never enters the repo). */
export const issuer = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export function license(overrides: Partial<License> = {}): License {
  return {
    id: "lic_test",
    org: "acme",
    edition: "business",
    features: ["content_policy"],
    seats: 25,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}
