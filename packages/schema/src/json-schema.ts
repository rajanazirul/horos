// Published JSON Schema, generated from the zod definitions (AD-17).
import { z } from "zod";
import { CheckRequest, CheckResponse } from "./check.js";
import { ErrorEnvelope } from "./errors.js";
import { CreatePolicyVersionRequest, OffchainPolicy, PolicyVersion } from "./policy.js";
import { DecisionRecord } from "./record.js";

export const JSON_SCHEMA_ID = "urn:horos:wire-schema:1";

const DEFINITIONS = {
  CheckRequest,
  CheckResponse,
  ErrorEnvelope,
  DecisionRecord,
  OffchainPolicy,
  CreatePolicyVersionRequest,
  PolicyVersion,
} as const;

/**
 * One draft 2020-12 document with every wire definition under `$defs`. Input-side shapes are
 * emitted (what a producer must send); refinements such as EIP-55 and cap/payable_amount are
 * enforced by the zod schemas only.
 */
export function buildJsonSchema(): Record<string, unknown> {
  const defs: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(DEFINITIONS)) {
    const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) };
    delete json["$schema"];
    defs[name] = json;
  }
  tightenRefinements(defs);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: JSON_SCHEMA_ID,
    title: "Horos wire schema",
    $defs: defs,
  };
}

type JsonObject = Record<string, unknown>;

function prop(schema: JsonObject | undefined, name: string): JsonObject {
  const props = schema?.["properties"] as Record<string, JsonObject> | undefined;
  const p = props?.[name];
  if (p === undefined) throw new Error(`json-schema: missing property ${name}`);
  return p;
}

/** Express in JSON Schema the zod refinements that the emitter drops. */
function tightenRefinements(defs: Record<string, JsonObject>): void {
  const request = defs["CheckRequest"];
  // PositiveUsdcAmount: no "0".
  prop(request, "amount")["pattern"] = "^[1-9][0-9]*$";
  // DeclaredIdentity needs at least one field (both in requests and in records).
  prop(request, "declared_identity")["minProperties"] = 1;
  prop(prop(defs["DecisionRecord"], "declaredIdentity"), "value")["minProperties"] = 1;
  // payable_amount is required iff decision is cap.
  const response = defs["CheckResponse"];
  if (response === undefined) throw new Error("json-schema: missing CheckResponse");
  response["if"] = { properties: { decision: { const: "cap" } }, required: ["decision"] };
  response["then"] = { required: ["payable_amount"] };
  response["else"] = { not: { required: ["payable_amount"] } };
}

/** The committed file's exact text. */
export function renderJsonSchema(): string {
  return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
}
