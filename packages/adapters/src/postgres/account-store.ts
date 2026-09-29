// Postgres AccountStore (AD-11, AD-15, AD-25): Customers, webhooks, the pending → bound enforced binding
// and account-request nonces. Customers, webhooks and nonces are insert-only.
import type { AccountStore, Binding, OnboardInput, OnboardResult, ProvisionedKeys } from "@horos/core";
import { Address, Bytes32, type Hex } from "@horos/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { uuidv7 } from "../ids.js";
import type { HorosDb } from "./db.js";
import { PostgresJobStore } from "./job-store.js";
import { pgErrorCode } from "./policy-version-store.js";
import { PostgresRecordStore } from "./record-store.js";
import { accountNonce, customer, customerWebhook, enforcedBinding, job } from "./schema.js";

/** The worker job that provisions a Customer's Registrar/Model/Rules keys; its window is the Customer id. */
export const PROVISION_KEYS_JOB = "provision-keys";

const UNIQUE_VIOLATION = "23505";

type BindingRow = typeof enforcedBinding.$inferSelect & { readonly paymentAddress: string };

/** The binding row (with keys) does not match what the caller expects. */
export class BindingConflictError extends Error {
  override readonly name = "BindingConflictError";
}

function toBinding(r: BindingRow): Binding {
  const keysComplete =
    r.registrar !== null &&
    r.model !== null &&
    r.rules !== null &&
    r.circleWalletSetId !== null &&
    r.circleRegistrarWalletId !== null &&
    r.circleModelWalletId !== null &&
    r.circleRulesWalletId !== null;
  if (r.status !== "pending" && r.status !== "bound") throw new TypeError("bad enforced_binding.status");
  return {
    customerId: r.customerId,
    paymentAddress: Address.parse(r.paymentAddress),
    scopeId: r.scopeId,
    status: r.status,
    policyWallet: r.policyWallet === null ? null : Address.parse(r.policyWallet),
    keys: keysComplete
      ? {
          walletSetId: r.circleWalletSetId ?? "",
          registrar: { walletId: r.circleRegistrarWalletId ?? "", address: Address.parse(r.registrar) },
          model: { walletId: r.circleModelWalletId ?? "", address: Address.parse(r.model) },
          rules: { walletId: r.circleRulesWalletId ?? "", address: Address.parse(r.rules) },
        }
      : null,
  };
}

function sameKeys(a: ProvisionedKeys, b: ProvisionedKeys): boolean {
  return (
    a.walletSetId === b.walletSetId &&
    a.registrar.walletId === b.registrar.walletId &&
    a.registrar.address === b.registrar.address &&
    a.model.walletId === b.model.walletId &&
    a.model.address === b.model.address &&
    a.rules.walletId === b.rules.walletId &&
    a.rules.address === b.rules.address
  );
}

export class PostgresAccountStore implements AccountStore {
  constructor(
    private readonly db: HorosDb,
    private readonly newId: (nowMs: number) => string = uuidv7,
  ) {}

  private selectBinding(conn: HorosDb = this.db) {
    return conn
      .select({
        customerId: enforcedBinding.customerId,
        scopeId: enforcedBinding.scopeId,
        status: enforcedBinding.status,
        policyWallet: enforcedBinding.policyWallet,
        registrar: enforcedBinding.registrar,
        model: enforcedBinding.model,
        rules: enforcedBinding.rules,
        circleWalletSetId: enforcedBinding.circleWalletSetId,
        circleRegistrarWalletId: enforcedBinding.circleRegistrarWalletId,
        circleModelWalletId: enforcedBinding.circleModelWalletId,
        circleRulesWalletId: enforcedBinding.circleRulesWalletId,
        updatedAt: enforcedBinding.updatedAt,
        paymentAddress: customer.paymentAddress,
      })
      .from(enforcedBinding)
      .innerJoin(customer, eq(customer.id, enforcedBinding.customerId));
  }

  async onboard(input: OnboardInput): Promise<OnboardResult> {
    const paymentAddress = Address.parse(input.paymentAddress);
    const nowMs = input.now.getTime();
    const created = await this.db.transaction(async (tx) => {
      const customerId = this.newId(nowMs);
      const inserted = await tx
        .insert(customer)
        .values({ id: customerId, paymentAddress, createdAt: input.now })
        .onConflictDoNothing({ target: customer.paymentAddress })
        .returning({ id: customer.id });
      if (inserted.length === 0) return false;
      await tx.insert(customerWebhook).values({ id: this.newId(nowMs), customerId, url: input.webhookUrl, createdAt: input.now });
      await tx.insert(enforcedBinding).values({ customerId, scopeId: `enforced:${this.newId(nowMs)}`, status: "pending", updatedAt: input.now });
      await tx
        .insert(job)
        .values({ kind: PROVISION_KEYS_JOB, window: customerId, status: "pending", attempts: 0, updatedAt: input.now })
        .onConflictDoNothing({ target: [job.kind, job.window] });
      return true;
    });
    const binding = await this.bindingByPayment(paymentAddress);
    if (binding === undefined) throw new Error("onboarded customer has no binding");
    // A repeat onboarding while keys are still missing revives a provision-keys job that ran out of attempts.
    if (!created && binding.keys === null) await new PostgresJobStore(this.db).resetFailed(PROVISION_KEYS_JOB, binding.customerId, input.now);
    return { binding, created };
  }

  async bindingByPayment(paymentAddress: Hex): Promise<Binding | undefined> {
    const rows = await this.selectBinding().where(eq(customer.paymentAddress, Address.parse(paymentAddress))).limit(1);
    return rows[0] === undefined ? undefined : toBinding(rows[0]);
  }

  async bindingByWallet(policyWallet: Hex): Promise<Binding | undefined> {
    const rows = await this.selectBinding().where(eq(enforcedBinding.policyWallet, Address.parse(policyWallet))).limit(1);
    return rows[0] === undefined ? undefined : toBinding(rows[0]);
  }

  async bindingByScope(scopeId: string): Promise<Binding | undefined> {
    const rows = await this.selectBinding().where(eq(enforcedBinding.scopeId, scopeId)).limit(1);
    return rows[0] === undefined ? undefined : toBinding(rows[0]);
  }

  async bindingByCustomer(customerId: string): Promise<Binding | undefined> {
    const rows = await this.selectBinding().where(eq(enforcedBinding.customerId, customerId)).limit(1);
    return rows[0] === undefined ? undefined : toBinding(rows[0]);
  }

  async setKeys(customerId: string, keys: ProvisionedKeys, now: Date): Promise<void> {
    const updated = await this.db
      .update(enforcedBinding)
      .set({
        registrar: Address.parse(keys.registrar.address),
        model: Address.parse(keys.model.address),
        rules: Address.parse(keys.rules.address),
        circleWalletSetId: keys.walletSetId,
        circleRegistrarWalletId: keys.registrar.walletId,
        circleModelWalletId: keys.model.walletId,
        circleRulesWalletId: keys.rules.walletId,
        updatedAt: now,
      })
      .where(and(eq(enforcedBinding.customerId, customerId), isNull(enforcedBinding.registrar)))
      .returning({ id: enforcedBinding.customerId });
    if (updated.length > 0) return;
    const existing = await this.bindingByCustomer(customerId);
    if (existing === undefined) throw new BindingConflictError(`no binding for customer ${customerId}`);
    if (existing.keys === null || !sameKeys(existing.keys, keys)) {
      throw new BindingConflictError(`customer ${customerId} already has different keys`);
    }
  }

  async bind(customerId: string, policyWallet: Hex, now: Date): Promise<Binding> {
    const wallet = Address.parse(policyWallet);
    try {
      // Lock the binding, create the Scope row and adopt the wallet in one transaction: a lost race or a
      // unique violation leaves no Scope row behind.
      await this.db.transaction(async (tx) => {
        const locked = await tx
          .select({ scopeId: enforcedBinding.scopeId, status: enforcedBinding.status, policyWallet: enforcedBinding.policyWallet })
          .from(enforcedBinding)
          .where(eq(enforcedBinding.customerId, customerId))
          .for("update");
        const current = locked[0];
        if (current === undefined) throw new BindingConflictError(`no binding for customer ${customerId}`);
        if (current.status === "bound" && current.policyWallet !== wallet) {
          throw new BindingConflictError("customer is already bound to a different PolicyWallet");
        }
        await new PostgresRecordStore(this.db).ensureScope({ id: current.scopeId, customerId, policyWallet: wallet }, tx);
        await tx
          .update(enforcedBinding)
          .set({ status: "bound", policyWallet: wallet, updatedAt: now })
          .where(eq(enforcedBinding.customerId, customerId));
      });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) throw new BindingConflictError("this PolicyWallet is already bound to another customer");
      throw err;
    }
    const after = await this.bindingByCustomer(customerId);
    if (after === undefined) throw new Error("binding vanished");
    return after;
  }

  async updateWebhook(customerId: string, paymentAddress: Hex, nonce: Hex, url: string, now: Date): Promise<boolean> {
    const payment = Address.parse(paymentAddress);
    const n = Bytes32.parse(nonce);
    return this.db.transaction(async (tx) => {
      const used = await tx
        .insert(accountNonce)
        .values({ paymentAddress: payment, nonce: n, createdAt: now })
        .onConflictDoNothing({ target: [accountNonce.paymentAddress, accountNonce.nonce] })
        .returning({ nonce: accountNonce.nonce });
      if (used.length === 0) return false;
      // The latest row wins: keep created_at strictly increasing per Customer, even within one millisecond.
      const latest = await tx
        .select({ createdAt: customerWebhook.createdAt })
        .from(customerWebhook)
        .where(eq(customerWebhook.customerId, customerId))
        .orderBy(desc(customerWebhook.createdAt))
        .limit(1);
      const floor = latest[0] === undefined ? 0 : latest[0].createdAt.getTime() + 1;
      const createdAt = new Date(Math.max(now.getTime(), floor));
      await tx.insert(customerWebhook).values({ id: this.newId(createdAt.getTime()), customerId, url, createdAt });
      return true;
    });
  }

  async webhookUrl(customerId: string): Promise<string> {
    const rows = await this.db
      .select({ url: customerWebhook.url })
      .from(customerWebhook)
      .where(eq(customerWebhook.customerId, customerId))
      .orderBy(desc(customerWebhook.createdAt), desc(customerWebhook.id))
      .limit(1);
    return rows[0]?.url ?? "";
  }

  /** Row counts (tests and the onboarding idempotency check). */
  async counts(): Promise<{ readonly customers: number; readonly webhooks: number; readonly bindings: number }> {
    const [c, w, b] = await Promise.all([
      this.db.$count(customer),
      this.db.$count(customerWebhook),
      this.db.$count(enforcedBinding),
    ]);
    return { customers: c, webhooks: w, bindings: b };
  }
}
