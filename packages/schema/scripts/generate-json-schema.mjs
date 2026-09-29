// Writes json-schema/horos.schema.json from the built package (run `build` first).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderJsonSchema } from "../dist/index.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../json-schema/horos.schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderJsonSchema());
console.log(`wrote ${out}`);
