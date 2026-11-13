import { LICENSE_ORG } from "./license/format.ts";

export interface EeEnv {
  /** This install's org id. A license is accepted only if it names the same org. */
  org: string | null;
}

export function loadEeEnv(env: NodeJS.ProcessEnv = process.env): EeEnv {
  const org = env.SESSIONLY_ORG?.trim() || null;
  if (org && !LICENSE_ORG.test(org)) {
    throw new Error("SESSIONLY_ORG must be 1-64 letters, digits, - or _");
  }
  return { org };
}
