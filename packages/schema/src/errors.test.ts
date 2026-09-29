import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CONTRACT_ERRORS, classifyContractError, ERROR_CODE_HTTP_STATUS, ERROR_CODE_RETRYABLE, ErrorCode, ErrorEnvelope, errorEnvelope } from "./index.js";

describe("error envelope", () => {
  test("default retryable per code", () => {
    for (const code of ["rate_limited", "internal", "judge_unavailable", "unavailable"] as const) {
      expect(errorEnvelope(code, "x").error.retryable).toBe(true);
    }
    for (const code of ["validation_failed", "unauthenticated", "forbidden", "not_found", "conflict", "shadow_closed"] as const) {
      expect(errorEnvelope(code, "x").error.retryable).toBe(false);
    }
    expect(errorEnvelope("validation_failed", "x", true).error.retryable).toBe(true);
    expect(errorEnvelope("conflict", "x", true).error.retryable).toBe(true);
  });

  test("every code has a retryable default and an HTTP status", () => {
    expect(Object.keys(ERROR_CODE_RETRYABLE).sort()).toEqual([...ErrorCode.options].sort());
    expect(Object.keys(ERROR_CODE_HTTP_STATUS).sort()).toEqual([...ErrorCode.options].sort());
    for (const code of ErrorCode.options) {
      expect(typeof ERROR_CODE_RETRYABLE[code]).toBe("boolean");
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeLessThan(600);
    }
    expect(ERROR_CODE_HTTP_STATUS).toMatchObject({ validation_failed: 400, not_found: 404, conflict: 409, internal: 500, unavailable: 503 });
  });

  test("every code builds a valid envelope", () => {
    for (const code of ErrorCode.options) {
      expect(ErrorEnvelope.parse(errorEnvelope(code, "m"))).toEqual({ error: { code, retryable: expect.any(Boolean) as boolean, message: "m" } });
    }
    expect(ErrorEnvelope.safeParse({ error: { code: "boom", retryable: false, message: "" } }).success).toBe(false);
  });
});

describe("contract errors", () => {
  test("classifies every custom error declared in PolicyWallet.sol and RollingWindow.sol", () => {
    const declared = ["PolicyWallet.sol", "lib/RollingWindow.sol"].flatMap((f) => {
      const src = readFileSync(fileURLToPath(new URL(`../../../contracts/src/${f}`, import.meta.url)), "utf8");
      return [...src.matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((m) => m[1] ?? "");
    });
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(CONTRACT_ERRORS).toHaveProperty(name);
  });

  test("classification", () => {
    expect(classifyContractError("StaleEpoch")).toBe("terminal");
    expect(classifyContractError("CeilingExceeded")).toBe("terminal");
    expect(classifyContractError("AlreadyRegistered")).toBe("retryable");
    expect(classifyContractError("DayIndexOverflow")).toBe("terminal");
    expect(classifyContractError("SafeERC20FailedOperation")).toBe("terminal");
    expect(classifyContractError("Whatever")).toBe("retryable");
    expect(classifyContractError("toString")).toBe("retryable");
    expect(classifyContractError(undefined)).toBe("retryable");
    const retryable = Object.entries(CONTRACT_ERRORS).filter(([, c]) => c === "retryable").map(([n]) => n);
    expect(retryable).toEqual(["AlreadyRegistered"]);
  });
});
