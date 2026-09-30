// EIP-712 signer recovery for account requests and Checks (AD-11). Lives in adapters: only adapters import viem.
import {
  BIND_TYPES,
  CHECK_PRIMARY_TYPE,
  CHECK_TYPES,
  ONBOARD_TYPES,
  READ_ACCESS_TYPES,
  SHADOW_SIGNUP_TYPES,
  WEBHOOK_UPDATE_TYPES,
  type AccountDomain,
  type BindMessage,
  type CheckMessage,
  type HorosDomain,
  type Hex,
  type OnboardMessage,
  type ReadAccessMessage,
  type ShadowSignupMessage,
  type WebhookUpdateMessage,
} from "@horos/schema";
import { recoverTypedDataAddress } from "viem";

export type AccountTypedMessage =
  | { readonly primaryType: "Onboard"; readonly message: OnboardMessage }
  | { readonly primaryType: "Bind"; readonly message: BindMessage }
  | { readonly primaryType: "WebhookUpdate"; readonly message: WebhookUpdateMessage }
  | { readonly primaryType: "ReadAccess"; readonly message: ReadAccessMessage }
  | { readonly primaryType: "ShadowSignup"; readonly message: ShadowSignupMessage };

/** The lowercase signer of an account request, or undefined when the signature does not recover. */
export async function recoverAccountSigner(domain: AccountDomain, typed: AccountTypedMessage, signature: Hex): Promise<Hex | undefined> {
  try {
    const addr =
      typed.primaryType === "Onboard"
        ? await recoverTypedDataAddress({ domain, types: ONBOARD_TYPES, primaryType: "Onboard", message: typed.message, signature })
        : typed.primaryType === "Bind"
          ? await recoverTypedDataAddress({ domain, types: BIND_TYPES, primaryType: "Bind", message: typed.message, signature })
          : typed.primaryType === "WebhookUpdate"
            ? await recoverTypedDataAddress({ domain, types: WEBHOOK_UPDATE_TYPES, primaryType: "WebhookUpdate", message: typed.message, signature })
            : typed.primaryType === "ReadAccess"
              ? await recoverTypedDataAddress({ domain, types: READ_ACCESS_TYPES, primaryType: "ReadAccess", message: typed.message, signature })
              : await recoverTypedDataAddress({ domain, types: SHADOW_SIGNUP_TYPES, primaryType: "ShadowSignup", message: typed.message, signature });
    return addr.toLowerCase() as Hex;
  } catch {
    return undefined;
  }
}

/** The lowercase signer of a "Horos Check" (`checkDomain`, `CHECK_TYPES`), or undefined when it does not recover. */
export async function recoverCheckSigner(domain: HorosDomain<"Horos Check">, message: CheckMessage, signature: Hex): Promise<Hex | undefined> {
  try {
    const addr = await recoverTypedDataAddress({ domain, types: CHECK_TYPES, primaryType: CHECK_PRIMARY_TYPE, message, signature });
    return addr.toLowerCase() as Hex;
  } catch {
    return undefined;
  }
}
