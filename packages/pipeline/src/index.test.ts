import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("@horos/pipeline placeholder exports its name", () => {
  expect(PACKAGE_NAME).toBe("@horos/pipeline");
});
