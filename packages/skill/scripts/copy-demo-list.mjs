// Build step: bundle the Horos Demo List (a labelled, fictional test list) into dist/, so the `horos-quickstart smoke`
// test can Check its first address without the monorepo checkout.
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../fixtures/horos-demo-list.json", import.meta.url));
const to = fileURLToPath(new URL("../dist/horos-demo-list.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("../dist/", import.meta.url)), { recursive: true });
copyFileSync(from, to);
