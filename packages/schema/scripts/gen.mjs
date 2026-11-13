// Generates src/upload.ts (TypeScript types) from schema/upload.schema.json,
// which is itself generated from the Rust types (`sessionly schema upload`).
// Run with `pnpm gen`. `generate()` is also used by the staleness test.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const schemaPath = fileURLToPath(new URL("../../../schema/upload.schema.json", import.meta.url));
export const outPath = fileURLToPath(new URL("../src/upload.ts", import.meta.url));

export async function generate() {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return compile(schema, "Upload", {
    additionalProperties: false,
    bannerComment:
      "// Generated from schema/upload.schema.json by `pnpm gen`. Do not edit by hand.",
    style: { printWidth: 100 },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(outPath, await generate());
  console.log(`wrote ${outPath}`);
}
