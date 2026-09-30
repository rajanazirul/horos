// The agent repo's files, as the quickstart sees them. Every write goes through `writePublicFile`, which refuses content
// that looks like a private key or a Horos API key, so the only files this CLI writes (`horos.config.json`,
// `.horos/quickstart.json`) can hold public values only. The CLI never edits the agent's source.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Address, Scope, type Hex } from "@horos/schema";
import { checkBaseUrl, QuickstartError } from "./env.js";

export const CONFIG_FILE = "horos.config.json";
export const OWNER_PACKAGE = "@horos/owner";

/** 32 bytes of hex (a private key; also a tx or record hash, which these files never need) or a Horos API key. */
const SECRET_PATTERNS: readonly RegExp[] = [/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/, /hsk_/];

export class SecretInFileError extends QuickstartError {
  constructor(file: string) {
    super(`refused to write ${file}: its content looks like a private key or an API key. Nothing was written.`);
    this.name = "SecretInFileError";
  }
}

/**
 * Write a file under `root` that must hold public values only. Refuses (and writes nothing) when the content matches
 * a private-key or `hsk_` pattern or contains any of `secrets` verbatim. Writes atomically (temp file + rename).
 */
export function writePublicFile(root: string, file: string, content: string, secrets: readonly (string | undefined)[] = []): string {
  const path = resolve(root, file);
  const rel = relative(resolve(root), path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new QuickstartError(`refused to write outside the agent repo: ${file}`);
  if (SECRET_PATTERNS.some((re) => re.test(content))) throw new SecretInFileError(file);
  for (const s of secrets) {
    if (s !== undefined && s.length >= 8 && content.toLowerCase().includes(s.toLowerCase())) throw new SecretInFileError(file);
  }
  // Symlinks (e.g. `.horos` pointing elsewhere) must not carry the write out of the repo: compare real paths.
  const realRoot = realpathSync(resolve(root));
  const inside = (p: string) => {
    const r = relative(realRoot, p);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };
  let existing = dirname(path);
  while (!existsSync(existing)) existing = dirname(existing);
  if (!inside(realpathSync(existing))) throw new QuickstartError(`refused to write ${file}: it resolves outside the agent repo (symlink)`);
  mkdirSync(dirname(path), { recursive: true });
  if (!inside(realpathSync(dirname(path)))) throw new QuickstartError(`refused to write ${file}: it resolves outside the agent repo (symlink)`);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) throw new QuickstartError(`refused to write ${file}: it is a symlink`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
  return path;
}

export function writeJson(root: string, file: string, value: unknown, secrets: readonly (string | undefined)[] = []): string {
  return writePublicFile(root, file, `${JSON.stringify(value, null, 2)}\n`, secrets);
}

export type PackageJson = Readonly<Record<string, unknown>>;

/** The agent repo's package.json. Throws when missing or unreadable. */
export function readPackageJson(root: string): PackageJson {
  const path = join(root, "package.json");
  if (!existsSync(path)) throw new QuickstartError("no package.json here: run horos-quickstart from the agent repo's root");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new QuickstartError("package.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new QuickstartError("package.json is not a JSON object");
  return parsed as PackageJson;
}

/** Whether a key or string value names `@horos/owner` (a direct name, an `npm:@horos/owner@…` alias, a `>` override path…). */
function mentionsOwner(v: string): boolean {
  return v.includes(OWNER_PACKAGE);
}

/** Every path under `value` (keys and string values, recursively) that names `@horos/owner`. */
function ownerPaths(value: unknown, path: string, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") return mentionsOwner(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => ownerPaths(v, `${path}[${i}]`, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => (mentionsOwner(k) ? [`${path}.${k}`] : ownerPaths(v, `${path}.${k}`, depth + 1)));
  }
  return [];
}

/**
 * Every package.json field that declares `@horos/owner`: any `*dependencies` field (names, `npm:` alias values,
 * bundled arrays), `overrides`, `resolutions` and `pnpm.overrides`, searched recursively.
 */
export function ownerDependencyFields(pkg: PackageJson): string[] {
  const hits = new Set<string>();
  for (const [field, value] of Object.entries(pkg)) {
    if (/dependencies$/i.test(field) || field === "overrides" || field === "resolutions") {
      if (ownerPaths(value, field).length > 0) hits.add(field);
    }
  }
  const pnpm = pkg.pnpm;
  if (pnpm !== null && typeof pnpm === "object" && ownerPaths((pnpm as Record<string, unknown>).overrides, "pnpm.overrides").length > 0) hits.add("pnpm.overrides");
  return [...hits];
}

/** Whether `@horos/owner` is installed in the repo's node_modules. */
export function ownerInstalled(root: string): boolean {
  return existsSync(join(root, "node_modules", ...OWNER_PACKAGE.split("/")));
}

export const OWNER_REFUSED =
  `${OWNER_PACKAGE} is in this repo (package.json or node_modules). Human tooling must stay out of the agent repo: the ` +
  "Human (Policy Owner) key and its CLI live in a separate custody domain the agent's runtime cannot reach. Remove it from this repo " +
  "(install it only on the Policy Owner's own machine), then rerun. horos-quickstart never installs it.";

/** Refuse to run when `@horos/owner` is declared in the agent repo. */
export function assertNoOwner(root: string): PackageJson {
  const pkg = readPackageJson(root);
  const fields = ownerDependencyFields(pkg);
  if (ownerInstalled(root)) fields.push("node_modules/@horos/owner (installed)");
  if (fields.length > 0) throw new QuickstartError(`${OWNER_REFUSED} (found in: ${fields.join(", ")})`);
  return pkg;
}

export type Mode = "enforced" | "shadow";

/** `horos.config.json`: public values only. */
export interface HorosConfig {
  readonly baseUrl: string;
  readonly chainId: number;
  /** The PolicyWallet (enforced); null in Shadow Mode. */
  readonly policyWallet: Hex | null;
  readonly scope: string;
  readonly customerId: string;
  readonly mode: Mode;
}

export function writeConfig(root: string, config: HorosConfig, secrets: readonly (string | undefined)[]): string {
  const ordered: HorosConfig = {
    baseUrl: config.baseUrl,
    chainId: config.chainId,
    policyWallet: config.policyWallet,
    scope: config.scope,
    customerId: config.customerId,
    mode: config.mode,
  };
  return writeJson(root, CONFIG_FILE, ordered, secrets);
}

/** Read and validate `horos.config.json`. `keyed`: a key will be used against this api (https unless loopback). */
export function readConfig(root: string, keyed: boolean): HorosConfig {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) throw new QuickstartError(`${CONFIG_FILE} not found: run \`horos-quickstart deploy --human <address>\` (enforced) or \`horos-quickstart shadow\` first`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new QuickstartError(`${CONFIG_FILE} is not valid JSON`);
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const bad = (field: string, what: string) => new QuickstartError(`${CONFIG_FILE}: ${field} ${what}`);
  if (typeof c.baseUrl !== "string") throw bad("baseUrl", "must be a string");
  const baseUrl = checkBaseUrl(c.baseUrl, keyed, `${CONFIG_FILE} baseUrl`);
  if (typeof c.chainId !== "number" || !Number.isSafeInteger(c.chainId) || c.chainId <= 0) throw bad("chainId", "must be a positive integer");
  if (c.mode !== "enforced" && c.mode !== "shadow") throw bad("mode", 'must be "enforced" or "shadow"');
  if (typeof c.scope !== "string" || !Scope.safeParse(c.scope).success) throw bad("scope", "must be a Scope id");
  if (!c.scope.startsWith(`${c.mode}:`)) throw bad("scope", `must be a ${c.mode} Scope`);
  if (typeof c.customerId !== "string" || c.customerId === "") throw bad("customerId", "must be a string");
  let policyWallet: Hex | null = null;
  if (c.mode === "enforced") {
    const w = Address.safeParse(c.policyWallet);
    if (!w.success) throw bad("policyWallet", "must be a 0x address with 40 hex digits");
    policyWallet = w.data;
  }
  return { baseUrl, chainId: c.chainId, policyWallet, scope: c.scope, customerId: c.customerId, mode: c.mode };
}
