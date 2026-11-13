// Issue a license file. The private key stays with the issuer, never in this repository.
//   pnpm --filter @sessionly/ee sign-license --key ~/.config/sessionly/license-ed25519.pem \
//     --org acme --edition business --months 12 --seats 25 > acme.license
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FEATURES, signLicense, type Feature } from "../src/license/license.ts";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    org: { type: "string" },
    edition: { type: "string", default: "business" },
    months: { type: "string", default: "12" },
    seats: { type: "string", default: "1" },
    feature: { type: "string", multiple: true },
  },
});
if (!values.key || !values.org) throw new Error("--key and --org are required");
const issuedAt = new Date();
const expiresAt = new Date(issuedAt);
expiresAt.setUTCMonth(expiresAt.getUTCMonth() + Number(values.months));
process.stdout.write(
  signLicense(
    {
      id: `lic_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      org: values.org,
      edition: values.edition as "business" | "enterprise",
      features: (values.feature as Feature[] | undefined) ?? [...FEATURES],
      seats: Number(values.seats),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    readFileSync(values.key, "utf8"),
  ),
);
