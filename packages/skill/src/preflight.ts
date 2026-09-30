// `horos-quickstart preflight`: is this agent repo ready for the quickstart? Node >= 20.12, a package.json, no
// `@horos/owner` anywhere in it, and `.env*` files gitignored (the Payment key and a Shadow API key belong in a
// gitignored .env or the shell, never in the repo). Reads only; writes nothing.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerDependencyFields, ownerInstalled, OWNER_REFUSED, readPackageJson } from "./config.js";
import { ENV, read, type Env } from "./env.js";

/** Node >= 20.12: `.env` loading uses `util.parseEnv` / `process.loadEnvFile`. */
export const MIN_NODE = [20, 12] as const;

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Informational checks never fail the preflight. */
  readonly required: boolean;
  readonly detail: string;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly checks: readonly PreflightCheck[];
}

/** A gitignore pattern (no leading slash) as a regex over a path. `**` spans directories, `*` and `?` do not. */
function patternToRegex(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "*" && pattern[i + 1] === "*") {
      body += ".*";
      i++;
    } else if (ch === "*") body += "[^/]*";
    else if (ch === "?") body += "[^/]";
    else body += /[\\^$.|+(){}[\]]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${body}$`);
}

/**
 * Whether the root `.gitignore` ignores the file at repo-relative `relPath` (`/`-separated). Last matching rule wins
 * and `!` negates; a directory-only rule (`name/`) applies to the file's parent directories, never to the file itself;
 * a file inside an ignored directory is ignored.
 */
export function isGitignored(gitignore: string, relPath: string): boolean {
  const parts = relPath.split("/");
  const targets = parts.map((_, i) => ({ path: parts.slice(0, i + 1).join("/"), dir: i < parts.length - 1 }));
  const state = targets.map(() => false);
  for (const rawLine of gitignore.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    let pattern = negate ? line.slice(1) : line;
    let anchored = false;
    if (pattern.startsWith("**/")) pattern = pattern.replace(/^(?:\*\*\/)+/, "");
    else if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    }
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.replace(/\/+$/, "");
    if (pattern === "") continue;
    if (pattern.includes("/")) anchored = true;
    const re = patternToRegex(pattern);
    targets.forEach((t, i) => {
      if (dirOnly && !t.dir) return;
      const subject = anchored ? t.path : (t.path.split("/").pop() ?? "");
      if (re.test(subject)) state[i] = !negate;
    });
  }
  return state.some(Boolean);
}

const ENV_FILE = /^\.env(?:\..+)?$/;
const EXAMPLE_ENV = /\.(?:example|sample|template)$/;
const isSecretEnvName = (name: string) => ENV_FILE.test(name) && !EXAMPLE_ENV.test(name);
const WALK_SKIP = new Set(["node_modules", ".git"]);
const WALK_MAX_ENTRIES = 20_000;

/** `.env*` files anywhere in the tree (skipping node_modules and .git), repo-relative, plus the root `.env` and `.env.local`. */
function envFilesToCheck(root: string): string[] {
  const found = new Set([".env", ".env.local"]);
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 12 || seen > WALK_MAX_ENTRIES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) walk(join(dir, e.name), r, depth + 1);
      } else if (isSecretEnvName(e.name)) found.add(r);
    }
  };
  if (existsSync(root)) walk(root, "", 0);
  return [...found];
}

/** Files tracked by git (`git ls-files`), or null when `root` is not a git work tree or git is unavailable. */
export function gitTrackedFiles(root: string): string[] | null {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.split("\0").filter((f) => f !== "");
}

export interface PreflightDeps {
  readonly root: string;
  readonly env: Env;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  /** Default: `git ls-files` in `root` (null outside a git work tree). */
  readonly gitTrackedFiles?: (root: string) => string[] | null;
}

export function preflight(deps: PreflightDeps): PreflightResult {
  const checks: PreflightCheck[] = [];
  const [major = NaN, minor = NaN] = deps.nodeVersion.replace(/^v/, "").split(".").map(Number);
  checks.push({
    name: "node",
    ok: major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]),
    required: true,
    detail: `Node ${deps.nodeVersion} (needs >= ${MIN_NODE.join(".")}, for .env loading)`,
  });

  let pkgOk = false;
  let ownerFields: string[] = [];
  let pkgDetail = "package.json found";
  try {
    ownerFields = ownerDependencyFields(readPackageJson(deps.root));
    pkgOk = true;
  } catch (err) {
    pkgDetail = err instanceof Error ? err.message : "package.json unreadable";
  }
  if (ownerInstalled(deps.root)) ownerFields.push("node_modules/@horos/owner (installed)");
  checks.push({ name: "package.json", ok: pkgOk, required: true, detail: pkgDetail });
  checks.push({
    name: "no @horos/owner",
    ok: pkgOk && ownerFields.length === 0,
    required: true,
    detail: !pkgOk && ownerFields.length === 0 ? "cannot check without a package.json" : ownerFields.length === 0 ? "@horos/owner is not a dependency" : `${OWNER_REFUSED} (found in: ${ownerFields.join(", ")})`,
  });

  const giPath = join(deps.root, ".gitignore");
  const gitignore = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const exposed = envFilesToCheck(deps.root).filter((n) => !isGitignored(gitignore, n));
  checks.push({
    name: ".env* gitignored",
    ok: exposed.length === 0,
    required: true,
    detail:
      exposed.length === 0
        ? ".env files are gitignored"
        : `not gitignored: ${exposed.join(", ")}. Add a line \`.env*\` to .gitignore (and \`!.env.example\` if you commit an example file with no values), then rerun.`,
  });

  const tracked = (deps.gitTrackedFiles ?? gitTrackedFiles)(deps.root)?.filter((f) => isSecretEnvName(f.split("/").pop() ?? "")) ?? [];
  checks.push({
    name: ".env* not tracked by git",
    ok: tracked.length === 0,
    required: true,
    detail:
      tracked.length === 0
        ? "no .env files are tracked"
        : `tracked by git: ${tracked.join(", ")}. Run \`git rm --cached <file>\` for each, and treat any key in them as exposed (it is in the history).`,
  });

  checks.push({
    name: "Payment key in env",
    ok: read(deps.env, ENV.paymentKey) !== undefined,
    required: false,
    detail: read(deps.env, ENV.paymentKey) !== undefined ? `${ENV.paymentKey} is set (value not shown)` : `${ENV.paymentKey} is not set yet; deploy, shadow and smoke need it (or use the Circle path in your own code)`,
  });
  checks.push({
    name: "api origin in env",
    ok: read(deps.env, ENV.baseUrl) !== undefined,
    required: false,
    detail: read(deps.env, ENV.baseUrl) !== undefined ? `${ENV.baseUrl} is set` : `${ENV.baseUrl} is not set yet; deploy and shadow need it`,
  });

  return { ok: checks.every((c) => c.ok || !c.required), checks };
}

export function formatPreflight(r: PreflightResult): string {
  const lines = r.checks.map((c) => `  ${c.ok ? "ok  " : c.required ? "FAIL" : "note"}  ${c.name}: ${c.detail}`);
  return [`preflight ${r.ok ? "passed" : "failed"}:`, ...lines].join("\n");
}
