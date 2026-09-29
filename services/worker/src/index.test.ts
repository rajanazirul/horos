import { expect, test } from "vitest";
import { createWorker, ofacWindow, PACKAGE_NAME, runOfacPoll } from "./index.js";

test("@horos/worker exports its name and the OFAC poll surface", () => {
  expect(PACKAGE_NAME).toBe("@horos/worker");
  expect(typeof createWorker).toBe("function");
  expect(typeof runOfacPoll).toBe("function");
  expect(ofacWindow(new Date("2026-09-26T10:00:00Z"))).toBe("2026-09-26T10");
});
