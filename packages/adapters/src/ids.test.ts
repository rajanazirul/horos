import { UuidV7 } from "@horos/schema";
import { expect, test } from "vitest";
import { uuidv7 } from "./ids.js";

test("uuidv7 produces valid, time-ordered, unique ids", () => {
  const a = uuidv7(1_790_000_000_000);
  const b = uuidv7(1_790_000_000_001);
  expect(UuidV7.parse(a)).toBe(a);
  expect(a < b).toBe(true);
  expect(a.slice(0, 13).replace("-", "")).toBe((1_790_000_000_000).toString(16).padStart(12, "0"));
  expect(new Set(Array.from({ length: 200 }, () => uuidv7())).size).toBe(200);
  expect(() => uuidv7(-1)).toThrow(RangeError);
});
