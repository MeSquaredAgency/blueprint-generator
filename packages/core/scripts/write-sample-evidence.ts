// Regenerates fixtures/harbour-plumbing/sample/evidence.json from the raw
// fixture files with the Ingest stage. A test fails if the two drift apart.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingest } from "../src/ingest.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/harbour-plumbing/", import.meta.url));
const bundle = await ingest(fixture, "harbour-plumbing");
writeFileSync(`${fixture}sample/evidence.json`, JSON.stringify(bundle, null, 2) + "\n");
console.log(`wrote sample/evidence.json (${bundle.items.length} items)`);
