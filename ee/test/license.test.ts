import assert from "node:assert/strict";
import { test } from "node:test";
import { LICENSE_PUBLIC_KEY } from "../src/license/keys.ts";
import {
  GRACE_MS,
  LicenseError,
  allows,
  licenseState,
  signLicense,
  verifyLicense,
} from "../src/license/license.ts";
import { LICENSE_FORMAT } from "../src/license/format.ts";
import { signDocument } from "../src/license/signed-document.ts";
import { issuer, license } from "./harness.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (err) {
    return err instanceof LicenseError ? err.code : String(err);
  }
};

test("a valid license verifies offline", () => {
  const l = license();
  assert.deepEqual(verifyLicense(signLicense(l, issuer.privateKey), issuer.publicKey), l);
});

test("a tampered license is rejected", () => {
  const file = signLicense(license(), issuer.privateKey);
  const doc = JSON.parse(file) as { payload: string; signature: string };
  const payload = JSON.parse(Buffer.from(doc.payload, "base64url").toString()) as object;
  const forged = JSON.stringify({
    ...doc,
    payload: Buffer.from(JSON.stringify({ ...payload, seats: 10_000 })).toString("base64url"),
  });
  assert.equal(codeOf(() => verifyLicense(forged, issuer.publicKey)), "bad_signature");
  // A flipped signature bit, too.
  const bytes = Buffer.from(doc.signature, "base64url");
  bytes[0]! ^= 1;
  const flipped = JSON.stringify({ ...doc, signature: bytes.toString("base64url") });
  assert.equal(codeOf(() => verifyLicense(flipped, issuer.publicKey)), "bad_signature");
});

test("a license from another issuer, or for another format, is rejected", () => {
  const file = signLicense(license(), issuer.privateKey);
  // signed by the test issuer, not by the key built into releases
  assert.equal(codeOf(() => verifyLicense(file, LICENSE_PUBLIC_KEY)), "bad_signature");
  const other = JSON.stringify({ ...JSON.parse(file), format: "something-else/1" });
  assert.equal(codeOf(() => verifyLicense(other, issuer.publicKey)), "malformed");
  assert.equal(codeOf(() => verifyLicense("not a license", issuer.publicKey)), "malformed");
  assert.equal(codeOf(() => verifyLicense("{}", issuer.publicKey)), "malformed");
});

test("license fields are checked", () => {
  // Sign whatever is given, bypassing the issuer-side validation.
  const sign = (fields: object) => signDocument(LICENSE_FORMAT, fields, issuer.privateKey);
  const verify = (fields: object) => codeOf(() => verifyLicense(sign(fields), issuer.publicKey));
  assert.equal(verify(license()), "ok");
  assert.equal(verify({ ...license(), features: ["mind_reading"] }), "invalid");
  assert.equal(verify({ ...license(), seats: 0 }), "invalid");
  assert.equal(verify({ ...license(), org: "not an org id!" }), "invalid");
  assert.equal(verify({ ...license(), extra: true }), "invalid");
  assert.equal(verify({ ...license(), expiresAt: "2025-01-01T00:00:00.000Z" }), "invalid");
  assert.throws(() => signLicense({ ...license(), seats: -1 }, issuer.privateKey));
});

test("active, then 14 days of grace, then read-only", () => {
  const l = license();
  const expires = Date.parse(l.expiresAt);
  const at = (ms: number) => licenseState(l, new Date(ms));
  assert.equal(licenseState(null, new Date()).status, "missing");
  assert.equal(at(expires - 1).status, "active");
  assert.equal(at(expires).status, "grace");
  assert.equal(at(expires + GRACE_MS - 1).status, "grace");
  assert.equal(at(expires + GRACE_MS).status, "expired");
  assert.equal(at(expires).readOnlyAt, new Date(expires + GRACE_MS).toISOString());

  for (const [ms, write] of [[expires - 1, true], [expires + 1, true], [expires + GRACE_MS, false]] as const) {
    assert.equal(allows(at(ms), "content_policy", "read"), true);
    assert.equal(allows(at(ms), "content_policy", "write"), write);
  }
  const without = licenseState(license({ features: [] }), new Date(expires - 1));
  assert.equal(allows(without, "content_policy", "read"), false);
  assert.equal(allows(licenseState(null, new Date()), "content_policy", "read"), false);
});
