/** I10 separate charges and transfers: how one platform charge divides, and what a refund or dispute takes back from the shop. */
import { describe, expect, it } from "vitest";
import { brandAccountOverflow, recoveryFrom, saleTransferGroup, saleTransferKeys, shopReversal, splitCharge, uncoveredParts } from "@/domain/charge-split";

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

describe("saleTransferKeys", () => {
  const shop = (paymentId: string) => ({ paymentId, kind: "shop" as const, staffId: null });
  const tip = (paymentId: string, staffId: string) => ({ paymentId, kind: "tip" as const, staffId });

  it("one card, one barber: {saleId}:shop and {saleId}:tip", () => {
    expect(saleTransferKeys("s1", [shop("p1"), tip("p1", "jamie")])).toEqual(["s1:shop", "s1:tip"]);
  });

  it("a split ticket's second card and several barbers get longer keys, never the same one", () => {
    const keys = saleTransferKeys("s1", [shop("p1"), tip("p1", "jamie"), tip("p1", "sara"), shop("p2"), tip("p2", "jamie")]);
    expect(keys).toEqual(["s1:shop", "s1:tip:jamie", "s1:tip:sara", "s1:shop:p2", "s1:tip:jamie:p2"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys already used by the sale (a card added later) are skipped", () => {
    expect(saleTransferKeys("s1", [shop("p3"), tip("p3", "jamie")], new Set(["s1:shop", "s1:tip"]))).toEqual(["s1:shop:p3", "s1:tip:jamie"]);
  });
});

describe("what a refund past the shop's portion was (platform losses)", () => {
  it("first the tips already with barbers, then losses this transfer paid back, then the fee", () => {
    expect(uncoveredParts({ uncoveredCents: 2_320, tipsToBarbersCents: 2_000, tipLossBookedCents: 0, recoveredOnTransferCents: 0 })).toEqual({ tipCents: 2_000, reopenCents: 0, feeCents: 320 });
    expect(uncoveredParts({ uncoveredCents: 2_320, tipsToBarbersCents: 2_000, tipLossBookedCents: 1_500, recoveredOnTransferCents: 0 })).toEqual({ tipCents: 500, reopenCents: 0, feeCents: 1_820 });
    expect(uncoveredParts({ uncoveredCents: 2_150, tipsToBarbersCents: 0, tipLossBookedCents: 0, recoveredOnTransferCents: 2_000 })).toEqual({ tipCents: 0, reopenCents: 2_000, feeCents: 150 });
    expect(uncoveredParts({ uncoveredCents: 0, tipsToBarbersCents: 2_000, tipLossBookedCents: 0, recoveredOnTransferCents: 0 })).toEqual({ tipCents: 0, reopenCents: 0, feeCents: 0 });
  });

  it("a shop on the brand's account: only the part past the charge less tips sent to barbers, never more than those tips", () => {
    const o = { amountCents: 10_000, tipsToBarbersCents: 2_000, bookedCents: 0 };
    expect(brandAccountOverflow({ ...o, takenBeforeCents: 0, cents: 8_000 })).toBe(0);
    expect(brandAccountOverflow({ ...o, takenBeforeCents: 0, cents: 10_000 })).toBe(2_000);
    expect(brandAccountOverflow({ ...o, takenBeforeCents: 7_000, cents: 2_000 })).toBe(1_000);
    expect(brandAccountOverflow({ ...o, takenBeforeCents: 9_000, cents: 1_000, bookedCents: 1_000 })).toBe(1_000);
    expect(brandAccountOverflow({ ...o, tipsToBarbersCents: 0, takenBeforeCents: 0, cents: 10_000 })).toBe(0);
  });

  it("a shop that carries its losses pays them back from its next transfers, oldest first, never more than the transfer", () => {
    expect(recoveryFrom(3_000, [{ id: "a", cents: 2_000 }, { id: "b", cents: 2_000 }])).toEqual([{ id: "a", cents: 2_000 }, { id: "b", cents: 1_000 }]);
    expect(recoveryFrom(0, [{ id: "a", cents: 2_000 }])).toEqual([]);
    expect(recoveryFrom(5_000, [])).toEqual([]);
  });
});
