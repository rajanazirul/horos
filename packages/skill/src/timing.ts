// SM-4 timing: `.horos/quickstart.json` records when the quickstart started, when each step finished, the smoke-test
// result, and the elapsed time from `start` to the first passing smoke test (`elapsedSeconds`, `underTenMinutes`).
// Public values only; written through `writePublicFile`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "./config.js";

export const QUICKSTART_FILE = ".horos/quickstart.json";
export const TEN_MINUTES_SECONDS = 600;

export interface StepMark {
  readonly step: string;
  readonly at: string;
}

export interface SmokeCheckResult {
  readonly step: "good" | "demo";
  readonly counterparty: string;
  readonly decision?: string;
  readonly simulated?: boolean;
  readonly advisory?: boolean;
  readonly recordId?: string;
  readonly outcome?: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface SmokePayResult {
  readonly step: "pay";
  readonly counterparty: string;
  readonly reverted: boolean;
  readonly revertReason?: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export type SmokeStepResult = SmokeCheckResult | SmokePayResult;

export interface SmokeRun {
  readonly mode: "enforced" | "shadow";
  readonly at: string;
  readonly amount: string;
  readonly passed: boolean;
  readonly failedStep: string | null;
  readonly steps: readonly SmokeStepResult[];
}

export interface Quickstart {
  readonly version: 1;
  /** ISO time `horos-quickstart start` ran; null when it was never run (elapsed is then unknown). */
  readonly startedAt: string | null;
  readonly steps: readonly StepMark[];
  /** The latest smoke run. */
  readonly smoke: SmokeRun | null;
  /** The latest smoke run's verdict (null before any smoke run). */
  readonly passed: boolean | null;
  readonly failedStep: string | null;
  /** When a smoke run first passed since `start`; null until then. */
  readonly firstPassedAt: string | null;
  /** Seconds from `start` to the first passing smoke run. Null before a run passes, or when `start` never ran. Frozen afterwards. */
  readonly elapsedSeconds: number | null;
  readonly underTenMinutes: boolean | null;
  /**
   * The known-good smoke address generated on the first run and reused on reruns, so reruns do not each spend a
   * new-payee slot. Kept across `start`.
   */
  readonly goodAddress: string | null;
}

const EMPTY: Quickstart = {
  version: 1,
  startedAt: null,
  steps: [],
  smoke: null,
  passed: null,
  failedStep: null,
  firstPassedAt: null,
  elapsedSeconds: null,
  underTenMinutes: null,
  goodAddress: null,
};

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const nullable = <T>(v: unknown, ok: (x: unknown) => x is T): T | null | undefined => (v === null || v === undefined ? null : ok(v) ? v : undefined);
const isNonNegInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isAddress = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x);

/**
 * Read `.horos/quickstart.json`. A corrupt file or a field of the wrong type is reported through `warn` (stderr) and
 * treated as unset; the next write replaces the file.
 */
export function readQuickstart(root: string, warn: (s: string) => void = () => undefined): Quickstart {
  const path = join(root, QUICKSTART_FILE);
  if (!existsSync(path)) return EMPTY;
  let q: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    q = parsed as Record<string, unknown>;
  } catch {
    warn(`warning: ${QUICKSTART_FILE} is corrupt (not a JSON object); the timer and smoke history start over. Run \`horos-quickstart start\` to time a new run.`);
    return EMPTY;
  }
  const bad: string[] = [];
  const field = <T>(name: string, ok: (x: unknown) => x is T): T | null => {
    const v = nullable(q[name], ok);
    if (v === undefined) {
      bad.push(name);
      return null;
    }
    return v;
  };
  const startedAt = field("startedAt", isIso);
  const firstPassedAt = field("firstPassedAt", isIso);
  const elapsedSeconds = field("elapsedSeconds", isNonNegInt);
  const underTenMinutes = field("underTenMinutes", isBool);
  const passed = field("passed", isBool);
  const failedStep = field("failedStep", (x): x is string => typeof x === "string");
  const goodAddress = field("goodAddress", isAddress);
  if (bad.length > 0) warn(`warning: ${QUICKSTART_FILE} has invalid ${bad.join(", ")}; treated as unset.`);
  const timingBroken = ["firstPassedAt", "elapsedSeconds", "underTenMinutes"].some((f) => bad.includes(f));
  return {
    version: 1,
    startedAt,
    steps: Array.isArray(q.steps) ? (q.steps as StepMark[]) : [],
    smoke: q.smoke !== null && typeof q.smoke === "object" ? (q.smoke as SmokeRun) : null,
    passed,
    failedStep,
    firstPassedAt: timingBroken ? null : firstPassedAt,
    elapsedSeconds: timingBroken ? null : elapsedSeconds,
    underTenMinutes: timingBroken ? null : underTenMinutes,
    goodAddress,
  };
}

function save(root: string, q: Quickstart, secrets: readonly (string | undefined)[]): void {
  writeJson(root, QUICKSTART_FILE, q, secrets);
}

/** Start (or restart) the timer: resets the file, keeping only the reusable known-good smoke address. */
export function startTimer(root: string, nowMs: number, warn?: (s: string) => void): Quickstart {
  const at = new Date(nowMs).toISOString();
  const q: Quickstart = { ...EMPTY, startedAt: at, steps: [{ step: "start", at }], goodAddress: readQuickstart(root, warn).goodAddress };
  save(root, q, []);
  return q;
}

/** Append a step timestamp. */
export function markStep(root: string, step: string, nowMs: number, secrets: readonly (string | undefined)[] = [], warn?: (s: string) => void): Quickstart {
  const q = readQuickstart(root, warn);
  const next: Quickstart = { ...q, steps: [...q.steps, { step, at: new Date(nowMs).toISOString() }] };
  save(root, next, secrets);
  return next;
}

/** Persist the known-good smoke address for reuse on reruns. */
export function saveGoodAddress(root: string, address: string, warn?: (s: string) => void): void {
  const q = readQuickstart(root, warn);
  if (q.goodAddress === address) return;
  save(root, { ...q, goodAddress: address }, []);
}

/**
 * Record a smoke run. The elapsed time is set only by the first passing run since `start` (null before, and null when
 * `start` never ran), then frozen: failing runs and later passes do not change it.
 */
export function recordSmoke(root: string, run: SmokeRun, nowMs: number, secrets: readonly (string | undefined)[], warn?: (s: string) => void): Quickstart {
  const q = readQuickstart(root, warn);
  const firstPass = q.firstPassedAt === null && run.passed;
  let elapsedSeconds = q.elapsedSeconds;
  let underTenMinutes = q.underTenMinutes;
  if (firstPass) {
    elapsedSeconds = q.startedAt === null ? null : Math.max(0, Math.round((nowMs - Date.parse(q.startedAt)) / 1000));
    underTenMinutes = elapsedSeconds === null ? null : elapsedSeconds < TEN_MINUTES_SECONDS;
  }
  const next: Quickstart = {
    ...q,
    steps: [...q.steps, { step: run.mode === "shadow" ? "smoke --shadow" : "smoke", at: run.at }],
    smoke: run,
    passed: run.passed,
    failedStep: run.failedStep,
    firstPassedAt: firstPass ? run.at : q.firstPassedAt,
    elapsedSeconds,
    underTenMinutes,
  };
  save(root, next, secrets);
  return next;
}

export function formatElapsed(q: Quickstart): string {
  if (q.firstPassedAt === null) return "elapsed: not recorded yet (it is set by the first passing smoke test)";
  if (q.elapsedSeconds === null) return "elapsed: unknown (run `horos-quickstart start` first to time the quickstart)";
  const m = Math.floor(q.elapsedSeconds / 60);
  const s = q.elapsedSeconds % 60;
  return `elapsed: ${m}m ${s.toString().padStart(2, "0")}s (${q.elapsedSeconds} s) ${q.underTenMinutes === true ? "under" : "over"} the ten-minute target`;
}
