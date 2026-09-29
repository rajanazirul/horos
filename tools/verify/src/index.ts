// @horos/verify: the published record-chain verifier (AD-9). Depends only on @horos/schema.
export const PACKAGE_NAME = "@horos/verify";

export { splitJsonLines, verifyChain, type ChainBreak, type VerifyResult } from "./verify.js";
