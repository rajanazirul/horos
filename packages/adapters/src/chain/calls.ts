// PolicyWalletCall → viem `functionName` / `args`, and the Circle `abiFunctionSignature` / params.
import type { PolicyWalletCall } from "@horos/core";
import type { Hex } from "@horos/schema";

export type EncodedCall =
  | { readonly functionName: "register"; readonly args: readonly [Hex, bigint, Hex] }
  | { readonly functionName: "tighten"; readonly args: readonly [Hex, bigint, bigint, Hex] }
  | { readonly functionName: "pin"; readonly args: readonly [Hex, Hex] };

export function encodeCall(call: PolicyWalletCall): EncodedCall {
  switch (call.fn) {
    case "register":
      return { functionName: "register", args: [call.counterparty, call.limit, call.recordHash] };
    case "tighten":
      return { functionName: "tighten", args: [call.counterparty, call.limit, call.expectedEpoch, call.recordHash] };
    case "pin":
      return { functionName: "pin", args: [call.counterparty, call.recordHash] };
  }
}

/** Circle `contractExecution` form: the ABI function signature and its parameters as strings. */
export function circleCall(call: PolicyWalletCall): { readonly abiFunctionSignature: string; readonly abiParameters: string[] } {
  switch (call.fn) {
    case "register":
      return { abiFunctionSignature: "register(address,uint256,bytes32)", abiParameters: [call.counterparty, call.limit.toString(), call.recordHash] };
    case "tighten":
      return {
        abiFunctionSignature: "tighten(address,uint256,uint256,bytes32)",
        abiParameters: [call.counterparty, call.limit.toString(), call.expectedEpoch.toString(), call.recordHash],
      };
    case "pin":
      return { abiFunctionSignature: "pin(address,bytes32)", abiParameters: [call.counterparty, call.recordHash] };
  }
}
