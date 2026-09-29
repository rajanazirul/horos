// Shared lint config for every non-Next workspace. apps/landing keeps its own
// eslint-config-next setup in apps/landing/eslint.config.mjs.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/out/**",
      "apps/landing/**",
      "contracts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // packages/core is pure (AD-1): no I/O, clock or randomness. Node globals are removed and the
  // ambient escape hatches are forbidden. Tests may use them.
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/**/*.test.ts"],
    languageOptions: {
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, "off"])),
        ...globals.es2024,
      },
    },
    rules: {
      "no-restricted-globals": [
        "error",
        ...["Date", "fetch", "process", "crypto", "setTimeout", "setInterval", "setImmediate", "performance", "globalThis", "require", "Buffer"].map(
          (name) => ({ name, message: `packages/core is pure (AD-1): ${name} is not allowed; pass facts in as arguments.` }),
        ),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "packages/core is pure (AD-1): no randomness." },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*"], message: "packages/core is pure (AD-1): no Node built-ins." }] },
      ],
    },
  },
);
