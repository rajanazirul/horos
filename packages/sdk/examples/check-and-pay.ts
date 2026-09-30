// End-to-end example: one signed Horos Check, then `PolicyWallet.pay` on Arc testnet with the record's hash.
//
// Requires Node >= 24 (runs directly through Node's built-in TypeScript type stripping) and a built SDK
// (`pnpm turbo run build --filter @horos/sdk...`). See ./README.md for the environment variables.
//
// The Payment key comes from the environment only and is never printed. This script never raises a Limit, never
// touches the Human key and makes no compliance claim: Horos answers, the PolicyWallet enforces, you decide.
import { createHoros, fromViemAccount, HorosError, type CheckResponse, type Hex } from "@horos/sdk";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

// The two PolicyWallet functions this example needs (the full ABI lives in the contracts package).
const policyWalletAbi = parseAbi([
  "function pay(address a, uint256 amount, bytes32 recordHash)",
  "function remaining(address a) view returns ((uint256 cpRemaining, uint256 walletRemaining, uint256 newPayeeRemaining, uint256 limit, bool pinned, bool registered, bool humanSet, uint256 humanEpoch))",
]);

const REGISTRATION_TIMEOUT_MS = 180_000;
const POLL_MS = 3_000;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v.length === 0) throw new Error(`${name} is required (see packages/sdk/examples/README.md)`);
  return v;
}

function hexEnv(name: string, bytes: number): Hex {
  const v = env(name);
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) throw new Error(`${name} must be 0x followed by ${bytes * 2} hex digits`);
  return v as Hex;
}

const amountRaw = env("HOROS_AMOUNT");
if (!/^[1-9][0-9]*$/.test(amountRaw)) throw new Error("HOROS_AMOUNT must be a positive whole number of USDC base units (1 USDC = 1000000)");
const amount = BigInt(amountRaw);
const counterparty = hexEnv("HOROS_COUNTERPARTY", 20);
const policyWallet = hexEnv("HOROS_POLICY_WALLET", 20);
const account = privateKeyToAccount(hexEnv("HOROS_PAYMENT_KEY", 32));
const transport = http(env("ARC_RPC_URL"));
const publicClient = createPublicClient({ chain: arcTestnet, transport });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport });
const explorer = arcTestnet.blockExplorers.default.url;

const horos = createHoros({
  baseUrl: env("HOROS_BASE_URL"),
  chainId: arcTestnet.id,
  policyWallet,
  signer: fromViemAccount(account),
  scope: env("HOROS_SCOPE"),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let res: CheckResponse;
try {
  res = await horos.check({ counterparty, amount });
} catch (err) {
  if (err instanceof HorosError) {
    console.error(`check failed: ${err.code} (retryable: ${err.retryable}, attempts: ${err.attempts}): ${err.message}`);
    process.exit(1);
  }
  throw err;
}
console.log(`decision: ${res.decision}  reason: ${res.reason}  record: ${res.record_id}  advisory: ${res.advisory}  limit_write: ${res.limit_write}`);

if (res.advisory) {
  console.error("the Check ran advisory (not authenticated for this PolicyWallet): not paying. Is HOROS_PAYMENT_KEY the wallet's Payment role holder, and is the wallet bound?");
  process.exit(2);
}
if (res.decision !== "allow" && res.decision !== "cap") {
  console.error(`decision is ${res.decision}: not paying`);
  process.exit(2);
}
const payAmount = res.decision === "cap" && res.payable_amount !== undefined && BigInt(res.payable_amount) < amount ? BigInt(res.payable_amount) : amount;
if (payAmount === 0n) {
  console.error("nothing is payable right now: not paying");
  process.exit(2);
}

/**
 * Run one step; on failure print a one-line reason and exit 1. Only the error's code/short message is printed:
 * a full viem error can quote the RPC URL, which may carry an API key.
 */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const why =
      err instanceof HorosError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? ((err as Error & { shortMessage?: string }).shortMessage ?? err.name)
          : "unknown error";
    console.error(`${label} failed: ${why}`);
    process.exit(1);
  }
}

// Wait until the Counterparty is Registered on-chain with room for the payment (the Check's register intent
// confirmed, or it was already registered), reading the record for its hash and receipts along the way.
const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
let recordHash: Hex | undefined;
for (;;) {
  const detail = await step("reading the Decision Record", () => horos.getRecord(res.record_id));
  recordHash = detail.recordHash;
  // `confirmed` wrote the Limit; `noop` means the chain already held it. Anything else is a failed write.
  const failed = detail.receipts.find((r) => r.status !== "confirmed" && r.status !== "noop");
  if (failed !== undefined) {
    console.error(`the Limit write for this record ended ${failed.status}: not paying`);
    process.exit(2);
  }
  const r = await step("reading remaining() on the PolicyWallet", () =>
    publicClient.readContract({ address: policyWallet, abi: policyWalletAbi, functionName: "remaining", args: [counterparty] }),
  );
  if (r.pinned) {
    console.error("the Counterparty is pinned by the Human role: not paying");
    process.exit(2);
  }
  if (r.registered && r.cpRemaining >= payAmount && r.walletRemaining < payAmount) {
    console.error(`the wallet period cap leaves ${r.walletRemaining} base units, less than ${payAmount}: not paying`);
    process.exit(2);
  }
  if (r.registered && r.cpRemaining >= payAmount && r.walletRemaining >= payAmount) break;
  if (Date.now() > deadline) {
    console.error(`the Counterparty is not Registered with enough room after ${REGISTRATION_TIMEOUT_MS / 1000} s (receipts: ${detail.receipts.map((x) => x.status).join(", ") || "none yet"})`);
    process.exit(1);
  }
  await sleep(POLL_MS);
}

const payHash = recordHash;
const hash = await step("sending pay()", () =>
  walletClient.writeContract({ address: policyWallet, abi: policyWalletAbi, functionName: "pay", args: [counterparty, payAmount, payHash] }),
);
console.log(`pay submitted: ${hash}\n  ${explorer}/tx/${hash}`);
const receipt = await step("waiting for the pay() receipt", () => publicClient.waitForTransactionReceipt({ hash }));
console.log(`pay ${receipt.status} in block ${receipt.blockNumber}: ${payAmount} base units to ${counterparty} (recordHash ${recordHash})`);
if (receipt.status !== "success") process.exit(1);
