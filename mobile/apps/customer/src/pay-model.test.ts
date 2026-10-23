import { describe, expect, it } from "vitest";
import type { PaymentPreview } from "@rayz/api";
import { needsUpdate } from "./net";
import { payModel, payRows } from "./pay-model";

const preview: PaymentPreview = {
  shopId: "shop",
  paymentsEnabled: true,
  unavailableCopy: null,
  serviceCents: 2900,
  taxCents: 203,
  tipCents: 500,
  funding: "credit",
  wallet: false,
  feeCents: 93,
  feeRate: 0.03,
  feeReason: "applies",
  feeLabel: "Credit card surcharge (3%)",
  disclosure: "A 3% surcharge applies to credit card payments only.",
  totalCents: 3696,
  destination: { model: "separate_charges_and_transfers", shopAccountId: "acct", serviceTransferCents: 3103 },
  tipTransfer: { amountCents: 500, disposition: "payroll", copy: "Tips paid through payroll." },
};

describe("pay review", () => {
  it("places the fee and disclosure on the review before the total", () => {
    const model = payModel(preview);
    expect(model.showFee).toBe(true);
    expect(model.lines.map((line) => line.label)).toContain("Credit card surcharge (3%)");
    expect(model.disclosure).toMatch(/surcharge/);
    expect(model.totalCents).toBe(3696);
    expect(model.tipTransferCopy).toBe("Tips paid through payroll.");
    expect(payRows(preview).map((line) => `${line.label} ${line.cents}`)).toEqual([
      "Service 2900",
      "Tax 203",
      "Tip 500",
      "Credit card surcharge (3%) 93",
      "Total 3696",
    ]);
  });

  it("blocks versions below the store minimum", () => {
    expect(needsUpdate("3.0.0", "2.36.0")).toBe(true);
    expect(needsUpdate("3.0.0", "3.0.0")).toBe(false);
  });
});
