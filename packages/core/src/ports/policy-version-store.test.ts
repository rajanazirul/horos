import { expect, test } from "vitest";
import { SeqConflictError } from "./policy-version-store.js";

test("SeqConflictError carries scope and seq", () => {
  const e = new SeqConflictError("advisory-public", 2);
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("SeqConflictError");
  expect(e.scope).toBe("advisory-public");
  expect(e.seq).toBe(2);
  expect(e.message).toContain("seq 2");
});
