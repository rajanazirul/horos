import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { assertNoOwner, CONFIG_FILE, ownerDependencyFields, readConfig, SecretInFileError, writeConfig, writePublicFile } from "./config.js";
import { API_KEY, BASE_URL, CUSTOMER, ENFORCED_SCOPE, KEY, scanAndCleanTempRepos, tempHome, tempRepo, WALLET } from "./harness.test-helpers.js";

afterAll(scanAndCleanTempRepos);

test("writePublicFile refuses private-key and API-key content and writes nothing", () => {
  const root = tempRepo();
  expect(() => writePublicFile(root, "a.json", `{"k":"${KEY}"}`)).toThrow(SecretInFileError);
  expect(() => writePublicFile(root, "b.json", `{"k":"${KEY.slice(2)}"}`)).toThrow(SecretInFileError);
  expect(() => writePublicFile(root, "c.json", `{"k":"${API_KEY}"}`)).toThrow(SecretInFileError);
  expect(() => writePublicFile(root, "d.json", `{"k":"xxsecretvalue"}`, ["secretvalue"])).toThrow(SecretInFileError);
  for (const f of ["a.json", "b.json", "c.json", "d.json"]) expect(existsSync(join(root, f))).toBe(false);
  expect(() => writePublicFile(root, "../escape.json", "{}")).toThrow(/outside/);
  writePublicFile(root, "nested/ok.json", `{"wallet":"${WALLET}"}`);
  expect(readFileSync(join(root, "nested/ok.json"), "utf8")).toContain(WALLET);
});

test("owner dependency: found in any dependency field", () => {
  expect(ownerDependencyFields({ dependencies: { viem: "1" } })).toEqual([]);
  expect(ownerDependencyFields({ devDependencies: { "@horos/owner": "1" } })).toEqual(["devDependencies"]);
  expect(ownerDependencyFields({ peerDependencies: { "@horos/owner": "1" } })).toEqual(["peerDependencies"]);
  expect(ownerDependencyFields({ optionalDependencies: { "@horos/owner": "1" } })).toEqual(["optionalDependencies"]);
  expect(ownerDependencyFields({ bundledDependencies: ["@horos/owner"] })).toEqual(["bundledDependencies"]);
  expect(ownerDependencyFields({ overrides: { "@horos/owner": "1" } })).toEqual(["overrides"]);
  const root = tempRepo({ pkg: { name: "a", devDependencies: { "@horos/owner": "workspace:*" } } });
  expect(() => assertNoOwner(root)).toThrow(/Human tooling must stay out of the agent repo/);
});

test("horos.config.json round-trips public values; mode and scope must agree", () => {
  const root = tempRepo();
  writeConfig(root, { baseUrl: BASE_URL, chainId: 5042002, policyWallet: WALLET, scope: ENFORCED_SCOPE, customerId: CUSTOMER, mode: "enforced" }, [KEY]);
  expect(Object.keys(JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as object)).toEqual(["baseUrl", "chainId", "policyWallet", "scope", "customerId", "mode"]);
  expect(readConfig(root, true).policyWallet).toBe(WALLET);
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ baseUrl: BASE_URL, chainId: 5042002, policyWallet: WALLET, scope: ENFORCED_SCOPE, customerId: CUSTOMER, mode: "shadow" }));
  expect(() => readConfig(root, true)).toThrow(/must be a shadow Scope/);
});

test("writePublicFile follows real paths: a .horos symlink out of the repo is refused", () => {
  const root = tempRepo();
  const outside = tempHome();
  symlinkSync(outside, join(root, ".horos"));
  expect(() => writePublicFile(root, ".horos/quickstart.json", "{}")).toThrow(/resolves outside the agent repo/);
  expect(existsSync(join(outside, "quickstart.json"))).toBe(false);
  const root2 = tempRepo();
  symlinkSync(join(outside, "target.json"), join(root2, "horos.config.json"));
  expect(() => writePublicFile(root2, "horos.config.json", "{}")).toThrow(/symlink/);
});

test("assertNoOwner also refuses an installed node_modules/@horos/owner", () => {
  const root = tempRepo();
  mkdirSync(join(root, "node_modules/@horos/owner"), { recursive: true });
  expect(() => assertNoOwner(root)).toThrow(/installed/);
});
