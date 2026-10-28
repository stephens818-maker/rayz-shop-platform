/** The platform transfer path (ST-C11) is the one in use unless a test swaps it, tips move unless FEATURE_TIP_TO_BARBER or the shop's switch turns them off, and live keys stay off until MONEY_MOVEMENT_LIVE. */
import { afterEach, describe, expect, it, vi } from "vitest";

type Call = { op: string; params: Record<string, unknown>; opts?: Record<string, unknown> };
const calls: Call[] = [];
const fake = {
  transfers: {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => (calls.push({ op: "transfer", params, opts }), { id: `tr_${calls.length}` }),
    createReversal: async (id: string, params: Record<string, unknown>, opts?: Record<string, unknown>) => (calls.push({ op: "reversal", params: { id, ...params }, opts }), { id: `trr_${calls.length}` }),
  },
  payouts: { create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => (calls.push({ op: "payout", params, opts }), { id: `po_${calls.length}` }) },
};

vi.mock("server-only", () => ({}));
vi.mock("@/server/payments/processor", () => ({ stripe: () => (process.env.STRIPE_SECRET_KEY ? fake : null) }));

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.MONEY_MOVEMENT_LIVE;
  delete process.env.FEATURE_TIP_TO_BARBER;
  calls.length = 0;
});

const payout = (o: Partial<{ amountCents: number; prefundedCents: number }> = {}) => ({
  key: "k",
  shopId: "s",
  amountCents: o.amountCents ?? 0,
  prefundedCents: o.prefundedCents ?? 0,
  shopCostCents: o.amountCents ?? 0,
  to: "acct_x",
  group: "g",
  description: "d",
  metadata: {},
  payout: { method: "standard" as const, statementDescriptor: "RAYZ TIPS" },
});

describe("money movement", () => {
  it("uses the platform transfer path by default", async () => {
    const mm = await import("@/server/payments/money-movement");
    expect(mm.moneyMovement()).toBe(mm.platformTipTransfers);
    expect(mm.platformTipTransfers.name).toBe("platform_transfers");
  });

  it("FEATURE_TIP_TO_BARBER=false: no direct payouts anywhere, and holds name the switch", async () => {
    process.env.FEATURE_TIP_TO_BARBER = "false";
    const mm = await import("@/server/payments/money-movement");
    expect(mm.directPayoutsAvailable()).toBe(false);
    expect(mm.transfersPendingReason()).toBe(mm.TIP_TO_BARBER_REASON);
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(mm.directPayoutsAvailable()).toBe(false);
    expect(mm.transfersPendingReason()).toMatch(/FEATURE_TIP_TO_BARBER/);
  });

  it("a shop's switch off: no direct payouts there, and holds name the shop's switch; the brand's off wins", async () => {
    const mm = await import("@/server/payments/money-movement");
    expect([mm.directPayoutsAvailable(), mm.directPayoutsAvailable(true), mm.directPayoutsAvailable(false)]).toEqual([true, true, false]);
    expect(mm.transfersPendingReason(false)).toBe(mm.SHOP_TIP_TO_BARBER_REASON);
    expect(mm.SHOP_TIP_TO_BARBER_REASON).toMatch(/turned off at this shop.*paid through payroll/);
    process.env.FEATURE_TIP_TO_BARBER = "false";
    expect(mm.transfersPendingReason(false)).toBe(mm.TIP_TO_BARBER_REASON);
  });

  it("on by default: the simulator always pays; test keys can; live keys wait for the switch, and holds say so", async () => {
    const mm = await import("@/server/payments/money-movement");
    expect(mm.directPayoutsAvailable()).toBe(true);
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(mm.directPayoutsAvailable()).toBe(true);
    expect(mm.transfersPendingReason()).toBe(mm.TRANSFERS_PENDING_REASON);
    process.env.STRIPE_SECRET_KEY = "sk_live_x";
    expect(mm.directPayoutsAvailable()).toBe(false);
    expect(mm.transfersPendingReason()).toBe(mm.LIVE_SWITCH_REASON);
    expect(() => mm.moneyClient()).toThrow(/test mode only/);
    process.env.MONEY_MOVEMENT_LIVE = "true";
    expect(mm.directPayoutsAvailable()).toBe(true);
    mm.registerMoneyMovement(null);
    expect(mm.directPayoutsAvailable()).toBe(false);
    mm.registerMoneyMovement(mm.platformTipTransfers);
  });

  it("refuses to send nothing, before any Stripe call", async () => {
    const mm = await import("@/server/payments/money-movement");
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    await expect(mm.platformTipTransfers.send(payout(), async () => {})).rejects.toBeInstanceOf(mm.MovementError);
    expect(calls).toEqual([]);
  });

  it("a payout of tips already in the barber's balance transfers only the rest, and none when it's all there", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const mm = await import("@/server/payments/money-movement");
    const some = await mm.platformTipTransfers.send(payout({ amountCents: 5000, prefundedCents: 3000 }), async () => {});
    expect(calls.map((c) => [c.op, c.params.amount])).toEqual([
      ["transfer", 2000],
      ["payout", 5000],
    ]);
    expect(some.transferId).toMatch(/^tr_/);
    calls.length = 0;
    const all = await mm.platformTipTransfers.send({ ...payout({ amountCents: 3000, prefundedCents: 3000 }), key: "k2" }, async () => {});
    expect(calls.map((c) => [c.op, c.params.amount])).toEqual([["payout", 3000]]);
    expect(all.transferId).toBeNull();
  });

  it("with the switch off, a payout that needs a transfer moves nothing", async () => {
    process.env.FEATURE_TIP_TO_BARBER = "false";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const mm = await import("@/server/payments/money-movement");
    await expect(mm.platformTipTransfers.send(payout({ amountCents: 5000, prefundedCents: 0 }), async () => {})).rejects.toThrow(/FEATURE_TIP_TO_BARBER/);
    expect(calls).toEqual([]);
  });

  describe("a sale's transfers", () => {
    const shop = { key: "row-1", kind: "shop" as const, amountCents: 4200, destination: "acct_shop", transferGroup: "sale_1", sourceTransaction: "ch_1", description: "d", metadata: { saleId: "1" } };

    it("the shop's portion waits for the charge's funds (source_transaction), keyed on its row, even with the switch off and live keys", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_live_x";
      process.env.FEATURE_TIP_TO_BARBER = "false";
      const mm = await import("@/server/payments/money-movement");
      expect(await mm.createSaleTransfer(shop)).toMatch(/^tr_/);
      expect(calls).toEqual([
        {
          op: "transfer",
          params: expect.objectContaining({ amount: 4200, destination: "acct_shop", transfer_group: "sale_1", source_transaction: "ch_1", metadata: { saleId: "1", kind: "shop" } }),
          opts: { idempotencyKey: "sale-transfer-row-1" },
        },
      ]);
    });

    it("a tip transfer is refused with FEATURE_TIP_TO_BARBER=false, and live keys need MONEY_MOVEMENT_LIVE too", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_x";
      process.env.FEATURE_TIP_TO_BARBER = "false";
      const mm = await import("@/server/payments/money-movement");
      const tip = { ...shop, key: "row-2", kind: "tip" as const, amountCents: 1000, destination: "acct_barber" };
      await expect(mm.createSaleTransfer(tip)).rejects.toMatchObject({ details: { reason: "tip_to_barber_off" } });
      delete process.env.FEATURE_TIP_TO_BARBER;
      expect(await mm.createSaleTransfer(tip)).toMatch(/^tr_/);
      process.env.STRIPE_SECRET_KEY = "sk_live_x";
      await expect(mm.createSaleTransfer(tip)).rejects.toThrow(/test mode only/);
      expect(calls.map((c) => c.params.destination)).toEqual(["acct_barber"]);
    });

    it("a reversal is of the shop's transfer, keyed on its own row; the simulator moves nothing", async () => {
      const mm = await import("@/server/payments/money-movement");
      expect(await mm.createSaleTransfer(shop)).toMatch(/^sim_tr_/);
      expect(await mm.reverseShopTransfer({ key: "rev-1", transferId: "sim_tr_x", amountCents: 500, metadata: {} })).toMatch(/^sim_trr_/);
      process.env.STRIPE_SECRET_KEY = "sk_test_x";
      expect(await mm.reverseShopTransfer({ key: "rev-1", transferId: "tr_9", amountCents: 500, metadata: {} })).toMatch(/^trr_/);
      expect(calls).toEqual([{ op: "reversal", params: { id: "tr_9", amount: 500, metadata: {} }, opts: { idempotencyKey: "shop-reversal-rev-1" } }]);
      await expect(mm.reverseShopTransfer({ key: "rev-2", transferId: "tr_9", amountCents: 0, metadata: {} })).rejects.toThrow(/positive/);
    });
  });
});
