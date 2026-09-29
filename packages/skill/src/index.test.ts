import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("@horos/skill placeholder exports its name", () => {
  expect(PACKAGE_NAME).toBe("@horos/skill");
});
