import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("@horos/owner placeholder exports its name", () => {
  expect(PACKAGE_NAME).toBe("@horos/owner");
});
