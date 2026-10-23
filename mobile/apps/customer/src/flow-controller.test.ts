import { describe, expect, it } from "vitest";
import { flowButtonLabel, flowSheetParams, labelContainsCardNumber, skipNativeSheet } from "./flow-controller";

describe("PaymentSheet flow button", () => {
  it("shows the fee and total before pay and never a card number", () => {
    const label = flowButtonLabel({ feeCents: 93, feeLabel: "Credit card surcharge (3%)", totalCents: 3696 });
    expect(label).toContain("Credit card surcharge (3%)");
    expect(label).toContain("$36.96");
    expect(labelContainsCardNumber(label)).toBe(false);
    expect(label).not.toMatch(/4242|5556/);
  });

  it("opens FlowController with the fee on the button and skips sandbox secrets", () => {
    const params = flowSheetParams(
      { feeCents: 93, feeLabel: "Credit card surcharge (3%)", totalCents: 3696 },
      { clientSecret: "seti_live_123", ephemeralKey: "ek_test_123", customerId: "cus_123" },
    );
    expect(params.customFlow).toBe(true);
    expect(params.primaryButtonLabel).toBe("Pay $36.96 · Credit card surcharge (3%)");
    expect(params.customerEphemeralKeySecret).toBe("ek_test_123");
    expect(skipNativeSheet("seti_test_abc")).toBe(true);
    expect(skipNativeSheet("seti_live_123")).toBe(false);
  });
});