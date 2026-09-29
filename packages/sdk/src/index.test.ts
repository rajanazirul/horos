import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("@horos/sdk placeholder exports its name", () => {
  expect(PACKAGE_NAME).toBe("@horos/sdk");
});
