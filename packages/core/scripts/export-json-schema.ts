// Writes packages/core/json-schema/<name>.schema.json from the Zod schemas.
// Run with `npm run schemas:export`; a test fails if the committed files drift.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEMAS, toJsonSchema, type SchemaName } from "../src/json-schema.ts";

const outDir = fileURLToPath(new URL("../json-schema/", import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
  writeFileSync(`${outDir}${name}.schema.json`, JSON.stringify(toJsonSchema(name), null, 2) + "\n");
  console.log(`wrote json-schema/${name}.schema.json`);
}
