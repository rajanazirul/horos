import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as schema from "./index.js";

test("committed JSON Schema matches the generator", () => {
  const committed = readFileSync(fileURLToPath(new URL("../json-schema/horos.schema.json", import.meta.url)), "utf8");
  expect(committed).toBe(schema.renderJsonSchema());
  const doc = schema.buildJsonSchema() as { $defs: Record<string, unknown> };
  expect(Object.keys(doc.$defs).sort()).toEqual([
    "CheckRequest",
    "CheckResponse",
    "CreatePolicyVersionRequest",
    "DecisionRecord",
    "ErrorEnvelope",
    "OffchainPolicy",
    "PolicyVersion",
  ]);
});

test("JSON Schema expresses the zod refinements", () => {
  type Obj = Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
  const defs = (schema.buildJsonSchema() as { $defs: Record<string, Obj> }).$defs;
  const request = defs["CheckRequest"];
  const response = defs["CheckResponse"];
  const pattern = new RegExp(String(request?.properties["amount"]?.["pattern"]));
  expect(pattern.test("0")).toBe(false);
  expect(pattern.test("2500000")).toBe(true);
  expect(request?.properties["declared_identity"]?.["minProperties"]).toBe(1);
  expect(response?.["if"]).toEqual({ properties: { decision: { const: "cap" } }, required: ["decision"] });
  expect(response?.["then"]).toEqual({ required: ["payable_amount"] });
});

test("barrel exports the public surface", () => {
  expect(schema.PACKAGE_NAME).toBe("@horos/schema");
  for (const name of [
    "CheckRequest",
    "CheckResponse",
    "ErrorEnvelope",
    "DecisionRecord",
    "recordHash",
    "jcs",
    "checkDomain",
    "humanDomain",
    "CHECK_TYPES",
    "HUMAN_TYPES",
    "classifyContractError",
    "CONTRACT_ERRORS",
    "OffchainPolicy",
    "CreatePolicyVersionRequest",
    "PolicyVersion",
  ]) {
    expect(schema).toHaveProperty(name);
  }
});
