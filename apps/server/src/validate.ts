// Checks an upload against the JSON Schema generated from the Rust types.
import { uploadSchema, type Upload } from "@sessionly/schema";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; depending on the loader its function is the
// module itself or its `default`.
const addFormats = ((addFormatsModule as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: Ajv2020,
) => void;

/**
 * Fields with a fixed set of values are enums in the schema. A newer binary
 * may send a value this server doesn't know yet; that must not make the
 * upload fail, so enums are checked as plain strings.
 */
function relaxEnums(schema: unknown): unknown {
  const copy = structuredClone(schema) as { $defs?: Record<string, Record<string, unknown>> };
  const isStringChoice = (branch: unknown) => {
    const b = branch as Record<string, unknown>;
    return b?.type === "string" && ("const" in b || "enum" in b);
  };
  for (const [name, def] of Object.entries(copy.$defs ?? {})) {
    const branches = def.oneOf;
    if (Array.isArray(branches) && branches.every(isStringChoice)) {
      copy.$defs![name] = { type: "string" };
    }
  }
  return copy;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ["uint", "uint8", "uint16", "uint32", "uint64"]) {
  ajv.addFormat(format, { type: "number", validate: (n: number) => n >= 0 });
}
const check = ajv.compile(relaxEnums(uploadSchema) as object);

/** Null if `body` is a valid upload, otherwise what is wrong with it. */
export function uploadProblems(body: unknown): string[] | null {
  if (check(body)) return null;
  return (check.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

export type { Upload };
