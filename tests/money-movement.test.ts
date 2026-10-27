/** The platform transfer path (ST-C11) is the one in use unless a test swaps it, and live keys stay off until MONEY_MOVEMENT_LIVE. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/payments/processor", () => ({ stripe: () => (process.env.STRIPE_SECRET_KEY ? {} : null) }));

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.MONEY_MOVEMENT_LIVE;
});

describe("money movement", () => {
  it("uses the platform transfer path by default", async () => {
    const mm = await import("@/server/payments/money-movement");
    expect(mm.moneyMovement()).toBe(mm.platformTipTransfers);
    expect(mm.platformTipTransfers.name).toBe("platform_transfers");
  });

  it("the simulator always pays; test keys can; live keys wait for the switch, and holds say so", async () => {
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
  });

  it("refuses to send nothing, before any Stripe call", async () => {
    const mm = await import("@/server/payments/money-movement");
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const t = { key: "k", shopId: "s", amountCents: 0, shopCostCents: 0, to: "acct_x", group: "g", description: "d", metadata: {}, payout: { method: "standard" as const, statementDescriptor: "RAYZ TIPS" } };
    await expect(mm.platformTipTransfers.send(t, async () => {})).rejects.toBeInstanceOf(mm.MovementError);
  });
});
