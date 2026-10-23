import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { refundPortionPhrase, settlementLines } from "@/server/mobile/receipt";
import { portionsForRefunds, settlementFromLedger, type LedgerPayment, type LedgerTransfer } from "@/server/mobile/settlement";

const shop = (over: Partial<LedgerTransfer> = {}): LedgerTransfer => ({
  paymentIntentId: "pi_1",
  role: "shop_net",
  amountCents: 2000,
  reversedCents: 0,
  status: "executed",
  transferGroup: "tg_1",
  note: null,
  ...over,
});

const tip = (over: Partial<LedgerTransfer> = {}): LedgerTransfer => ({
  paymentIntentId: "pi_1",
  role: "tip",
  amountCents: 500,
  reversedCents: 0,
  status: "executed",
  transferGroup: "tg_1",
  note: null,
  ...over,
});

const card = (over: Partial<LedgerPayment> = {}): LedgerPayment => ({
  amountCents: 2500,
  tipCents: 500,
  applicationFeeCents: 100,
  stripeAccountId: "acct_shop",
  stripePaymentIntentId: "pi_dest",
  ...over,
});

describe("settlementFromLedger", () => {
  it("reads a separate shop transfer and a barber tip transfer", () => {
    expect(settlementFromLedger([card({ stripePaymentIntentId: "pi_1", applicationFeeCents: 0 })], [shop(), tip()])).toEqual({
      shopCents: 2000,
      tipCents: 500,
      tipStatus: "executed",
      transferGroup: "tg_1",
    });
  });

  it("keeps a skipped tip inside the shop amount", () => {
    const view = settlementFromLedger(
      [],
      [shop({ amountCents: 2400, note: "destination charge. Includes the tip." }), tip({ status: "skipped", note: "Tip stayed with the shop. Exported to iSolved as Cash Tips Recd." })],
    );
    expect(view).toEqual({ shopCents: 2400, tipCents: 0, tipStatus: "with_shop", transferGroup: "tg_1" });
  });

  it("uses the connected-account payment when no transfer rows exist yet", () => {
    expect(settlementFromLedger([card()], [])).toEqual({
      shopCents: 2400,
      tipCents: 0,
      tipStatus: "with_shop",
      transferGroup: null,
    });
  });

  it("does not invent a split for cash or an unsettled card", () => {
    expect(settlementFromLedger([card({ stripeAccountId: null, stripePaymentIntentId: null })], [])).toBeNull();
    expect(settlementFromLedger([], [])).toBeNull();
  });

  it("does not add the destination payment on top of transfer rows for the same charge", () => {
    const view = settlementFromLedger([card({ stripePaymentIntentId: "pi_1", amountCents: 2500, applicationFeeCents: 100 })], [shop(), tip()]);
    expect(view?.shopCents).toBe(2000);
    expect(view?.tipCents).toBe(500);
  });

  it("ignores a failed tip transfer", () => {
    expect(settlementFromLedger([], [shop(), tip({ status: "failed" })])).toMatchObject({ tipCents: 0, tipStatus: "failed", shopCents: 2000 });
  });
});

describe("portionsForRefunds", () => {
  it("takes a settled card refund from the shop when the tip was not reversed", () => {
    const portions = portionsForRefunds([{ createdAt: "2026-06-02T00:00:00Z", amountCents: 1000, method: "card" }], [shop(), tip()], [card({ stripePaymentIntentId: "pi_1" })]);
    expect(portions).toEqual([{ shopPortionCents: 1000, tipPortionCents: 0, from: "shop" }]);
  });

  it("spends a tip reversal oldest refund first, and only up to that pool", () => {
    const transfers = [shop(), tip({ reversedCents: 500, status: "reversed" })];
    const portions = portionsForRefunds(
      [
        { createdAt: "2026-06-03T00:00:00Z", amountCents: 400, method: "card" },
        { createdAt: "2026-06-01T00:00:00Z", amountCents: 300, method: "card" },
      ],
      transfers,
      [],
    );
    expect(portions[1]).toEqual({ shopPortionCents: 0, tipPortionCents: 300, from: "tip" });
    expect(portions[0]).toEqual({ shopPortionCents: 200, tipPortionCents: 200, from: "shop_and_tip" });
  });

  it("leaves the portion blank when nothing was settled, and for a cash refund", () => {
    expect(portionsForRefunds([{ createdAt: "2026-06-01T00:00:00Z", amountCents: 400, method: "card" }], [], [])).toEqual([
      { shopPortionCents: null, tipPortionCents: null, from: null },
    ]);
    expect(portionsForRefunds([{ createdAt: "2026-06-01T00:00:00Z", amountCents: 400, method: "cash" }], [shop()], [card()])).toEqual([
      { shopPortionCents: null, tipPortionCents: null, from: null },
    ]);
  });
});

describe("receipt settlement copy", () => {
  it("names the shop amount, the barber tip, and the refund portion", () => {
    expect(settlementLines(500, { shopCents: 2000, tipCents: 500, tipStatus: "executed", transferGroup: "tg_1" }, "Makenna")).toEqual([
      "Tip $5.00 paid to Makenna.",
      "Shop $20.00",
    ]);
    expect(settlementLines(500, { shopCents: 2000, tipCents: 500, tipStatus: "executed", transferGroup: "tg_1" }, "Makenna Lee")).toEqual([
      "Tip $5.00 paid to Makenna.",
      "Shop $20.00",
    ]);
    expect(settlementLines(500, { shopCents: 2000, tipCents: 500, tipStatus: "executed", transferGroup: "tg_1" })).toEqual([
      "Tip $5.00 paid to your barber.",
      "Shop $20.00",
    ]);
    expect(settlementLines(500, { shopCents: 2400, tipCents: 0, tipStatus: "with_shop", transferGroup: null })).toEqual([
      "Tip $5.00 stayed with the shop.",
      "Shop $24.00",
    ]);
    expect(refundPortionPhrase({ from: "shop", shopPortionCents: 400, tipPortionCents: 0 })).toBe(" from the shop");
    expect(refundPortionPhrase({ from: "shop_and_tip", shopPortionCents: 200, tipPortionCents: 500 })).toBe(" from the shop $2.00 and the tip $5.00");
    expect(refundPortionPhrase({ from: null, shopPortionCents: null, tipPortionCents: null })).toBe("");
    const copy = settlementLines(500, { shopCents: 2400, tipCents: 0, tipStatus: "with_shop", transferGroup: null }).join(" ");
    expect(copy.toLowerCase()).not.toMatch(/rating|stars|client_rating/);
  });

  it("does not keep a mobile env flag for tip routing", () => {
    const charge = readFileSync("src/server/payments/charge-plan.ts", "utf8");
    const routing = readFileSync("src/server/payments/tip-routing.ts", "utf8");
    expect(charge).not.toContain("process.env.FEATURE_TIP_TO_BARBER");
    expect(routing).not.toContain("process.env.FEATURE_TIP_TO_BARBER");
    expect(charge).not.toContain("pending CPA");
    expect(readFileSync("src/server/mobile/receipt.ts", "utf8")).not.toContain("pending CPA");
  });
});
