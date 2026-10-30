/**
 * Payouts matched to the bank statement: only deposits that left Stripe, only by someone who can see
 * every shop the deposit pools, audited both ways, and re-matching updates in place.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;
let R: typeof import("@/server/payments/reconcile");
const shopId: Record<string, string> = {};
const made: string[] = [];
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
let seq = 0;

beforeAll(async () => {
  m = await loadModules();
  R = await import("@/server/payments/reconcile");
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
}, 120_000);

afterAll(async () => {
  if (made.length) await m.db.db.delete(m.schema.shopPayouts).where(m.drizzle.inArray(m.schema.shopPayouts.id, made));
  await m?.db.closeDb();
});

async function payout(v: { shopId?: string | null; ownerEntityId?: string | null; status?: string }) {
  const [p] = await m.db.db
    .insert(m.schema.shopPayouts)
    .values({
      shopId: v.shopId ?? null,
      ownerEntityId: v.ownerEntityId ?? null,
      stripeAccountId: v.shopId || v.ownerEntityId ? "acct_test_reconcile" : "platform",
      stripePayoutId: `po_reconcile_${Date.now()}_${++seq}`,
      amountCents: 12_345,
      status: v.status ?? "paid",
      arrivalDate: "2026-10-20",
    })
    .returning();
  made.push(p.id);
  return p;
}

const everyShop = () => ({ shopIds: Object.values(shopId), brandWide: true });

describe("payout reconciliation", () => {
  it("matches a deposit, updates the match in place, and unmatches it, auditing each", async () => {
    const p = await payout({ shopId: shopId.silvis });
    await R.markReconciled(actor, { shopIds: [shopId.silvis], brandWide: false }, { payoutId: p.id, bankReference: "DEP 4471" });
    await R.markReconciled(actor, { shopIds: [shopId.silvis], brandWide: false }, { payoutId: p.id, bankReference: "DEP 4472", note: "  checked  " });
    const got = (await R.reconciliationsFor([p.id])).get(p.id)!;
    expect(got.bankReference).toBe("DEP 4472");
    expect(got.note).toBe("checked");
    expect((await m.db.db.select().from(m.schema.payoutReconciliations).where(eq(m.schema.payoutReconciliations.payoutId, p.id))).length).toBe(1);

    await R.unmarkReconciled(actor, { shopIds: [shopId.silvis], brandWide: false }, p.id);
    expect((await R.reconciliationsFor([p.id])).has(p.id)).toBe(false);
    await expect(R.unmarkReconciled(actor, everyShop(), p.id)).rejects.toThrow(/isn't matched/);

    const log = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, p.id));
    expect(log.map((l) => l.action).sort()).toEqual(["payout.reconcile", "payout.reconcile", "payout.unreconcile"]);
    expect(log.every((l) => l.shopId === shopId.silvis)).toBe(true);
  });

  it("refuses deposits that never reached a bank", async () => {
    for (const status of ["failed", "canceled", "pending"]) {
      const p = await payout({ shopId: shopId.silvis, status });
      await expect(R.markReconciled(actor, everyShop(), { payoutId: p.id })).rejects.toThrow(/never reached the bank/);
    }
    const t = await payout({ shopId: shopId.silvis, status: "in_transit" });
    await R.markReconciled(actor, everyShop(), { payoutId: t.id });
    expect((await R.reconciliationsFor([t.id])).has(t.id)).toBe(true);
  });

  it("needs the shop for its deposits, every shop for the brand account's, and all an owner's shops for theirs", async () => {
    const shop = await payout({ shopId: shopId.silvis });
    await expect(R.markReconciled(actor, { shopIds: [shopId.moline], brandWide: false }, { payoutId: shop.id })).rejects.toThrow(/don't have access/);

    const brand = await payout({});
    await expect(R.markReconciled(actor, { shopIds: [shopId.silvis], brandWide: false }, { payoutId: brand.id })).rejects.toThrow(/don't have access/);
    await R.markReconciled(actor, everyShop(), { payoutId: brand.id });

    const owners = await m.db.db.select({ id: m.schema.shops.ownerEntityId, shop: m.schema.shops.id }).from(m.schema.shops);
    const byOwner = Map.groupBy(
      owners.filter((o) => o.id),
      (o) => o.id!,
    );
    const shared = [...byOwner.entries()].find(([, xs]) => xs.length > 1);
    if (shared) {
      const [ownerId, xs] = shared;
      const pooled = await payout({ ownerEntityId: ownerId });
      await expect(R.markReconciled(actor, { shopIds: [xs[0].shop], brandWide: false }, { payoutId: pooled.id })).rejects.toThrow(/don't have access/);
      await R.markReconciled(actor, { shopIds: xs.map((x) => x.shop), brandWide: false }, { payoutId: pooled.id });
    }
  });

  it("scrubs card-like numbers out of the note and bank reference", async () => {
    const p = await payout({ shopId: shopId.silvis });
    await R.markReconciled(actor, everyShop(), { payoutId: p.id, bankReference: "4242 4242 4242 4242", note: "card 4242424242424242" });
    const got = (await R.reconciliationsFor([p.id])).get(p.id)!;
    expect(got.bankReference).not.toContain("4242 4242 4242 4242");
    expect(got.note).not.toContain("4242424242424242");
  });
});
