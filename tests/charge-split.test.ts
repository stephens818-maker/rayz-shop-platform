/** I10 separate charges and transfers: how one platform charge divides, and what a refund or dispute takes back from the shop. */
import { describe, expect, it } from "vitest";
import { saleTransferGroup, shopReversal, splitCharge } from "@/domain/charge-split";

const tips = [
  { staffId: "jamie", cents: 1500, accountId: "acct_jamie" },
  { staffId: "sara", cents: 500, accountId: null },
];

describe("splitCharge", () => {
  it("FEATURE_TIP_TO_BARBER off: the shop's transfer is the charge less the processing fee, tips and all", () => {
    expect(splitCharge({ amountCents: 10_000, feeCents: 320, settlement: "connected", tips, tipToBarber: false })).toEqual({
      shopCents: 9_680,
      tipTransfers: [],
      tipsWithShopCents: 2_000,
      tipsOnPlatformCents: 0,
      feeShortfallCents: 0,
    });
  });

  it("on: a barber with an account gets their whole tip; one without stays in the shop's transfer", () => {
    expect(splitCharge({ amountCents: 10_000, feeCents: 320, settlement: "connected", tips, tipToBarber: true })).toEqual({
      shopCents: 8_180,
      tipTransfers: [{ staffId: "jamie", accountId: "acct_jamie", cents: 1_500 }],
      tipsWithShopCents: 500,
      tipsOnPlatformCents: 0,
      feeShortfallCents: 0,
    });
  });

  it("the fee comes out of the shop's portion, never a tip; what it can't cover is the platform's", () => {
    const r = splitCharge({ amountCents: 1_600, feeCents: 200, settlement: "connected", tips: [{ staffId: "jamie", cents: 1_500, accountId: "acct_jamie" }], tipToBarber: true });
    expect(r).toMatchObject({ shopCents: 0, tipTransfers: [{ cents: 1_500 }], feeShortfallCents: 100 });
  });

  it("a shop on the brand's account has no shop transfer: off, its tips stay on the platform; on, they still go to barbers", () => {
    expect(splitCharge({ amountCents: 5_000, feeCents: 175, settlement: "platform", tips, tipToBarber: false })).toEqual({
      shopCents: 0,
      tipTransfers: [],
      tipsWithShopCents: 0,
      tipsOnPlatformCents: 2_000,
      feeShortfallCents: 0,
    });
    expect(splitCharge({ amountCents: 5_000, feeCents: 175, settlement: "platform", tips, tipToBarber: true })).toMatchObject({ tipTransfers: [{ staffId: "jamie", cents: 1_500 }], tipsOnPlatformCents: 500 });
  });

  it("refuses amounts that don't add up", () => {
    expect(() => splitCharge({ amountCents: 100, feeCents: 101, settlement: "connected", tips: [], tipToBarber: false })).toThrow(/fee/);
    expect(() => splitCharge({ amountCents: 100, feeCents: 0, settlement: "connected", tips: [{ staffId: "a", cents: 101, accountId: null }], tipToBarber: false })).toThrow(/tips/);
    expect(() => splitCharge({ amountCents: 10.5, feeCents: 0, settlement: "connected", tips: [], tipToBarber: false })).toThrow(/whole cents/);
  });
});

describe("shopReversal", () => {
  it("takes the refund from what's left of the shop's transfer; the rest is uncovered, never a tip", () => {
    expect(shopReversal({ cents: 3_000, transferCents: 8_180, reversedCents: 0 })).toEqual({ reverseCents: 3_000, uncoveredCents: 0 });
    expect(shopReversal({ cents: 10_000, transferCents: 8_180, reversedCents: 3_000 })).toEqual({ reverseCents: 5_180, uncoveredCents: 4_820 });
    expect(shopReversal({ cents: 500, transferCents: 8_180, reversedCents: 8_180 })).toEqual({ reverseCents: 0, uncoveredCents: 500 });
  });
});

it("every payment of a sale shares one transfer_group", () => {
  expect(saleTransferGroup("0b5c")).toBe("sale_0b5c");
});
