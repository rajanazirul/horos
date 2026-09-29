import { expect, test } from "vitest";
import { NonceReplayError } from "./record-store.js";

test("NonceReplayError carries scope and nonce", () => {
  const e = new NonceReplayError("advisory-public", "0xabc");
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("NonceReplayError");
  expect(e.scope).toBe("advisory-public");
  expect(e.nonce).toBe("0xabc");
});
