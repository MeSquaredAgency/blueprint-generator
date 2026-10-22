import { it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS, toJsonSchema, type SchemaName } from "../src/index.ts";
import { readJson, REPO_ROOT } from "./helpers.ts";

it("committed JSON Schema files match the Zod schemas (run `npm run schemas:export`)", () => {
  for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
    const committed = readJson(`${REPO_ROOT}packages/core/json-schema/${name}.schema.json`);
    assert.deepEqual(committed, toJsonSchema(name), name);
  }
});
