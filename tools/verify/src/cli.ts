#!/usr/bin/env node
// `horos-verify <file.jsonl>`: verify an exported Scope chain. Exit 0 ok, 1 on a break, 2 on usage or read errors.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { verifyChain } from "./verify.js";

export interface CliIo {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly readText: (path: string) => Promise<string>;
}

const defaultIo: CliIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  readText: (path) => readFile(path, "utf8"),
};

export async function main(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const [file, ...rest] = argv;
  if (file === undefined || rest.length > 0 || file === "-h" || file === "--help") {
    io.err("usage: horos-verify <file.jsonl>");
    return 2;
  }
  let text: string;
  try {
    text = await io.readText(file);
  } catch (e) {
    io.err(`horos-verify: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const result = verifyChain(text);
  io.out(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
