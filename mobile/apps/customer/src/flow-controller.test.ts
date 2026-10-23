import { describe, expect, it } from "vitest";
import { flowButtonLabel, flowSheetParams, labelContainsCardNumber, skipNativeSheet } from "./flow-controller";

describe("PaymentSheet flow button", () => {
  it("shows the fee and total before pay and never a card number", () => {
    const label = flowButtonLabel({ feeCents: 93, totalCents: 3696, funding: "credit" });
    expect(label).toBe("Pay $36.96 (includes $0.93 credit card surcharge)");
    expect(flowButtonLabel({ feeCents: 0, totalCents: 3603, funding: "debit" })).toBe("Pay $36.03 · No surcharge on debit cards");
    expect(labelContainsCardNumber(label)).toBe(false);
    expect(label).not.toMatch(/4242|5556/);
  });

  it("opens FlowController with the fee on the button and skips sandbox secrets", () => {
    const params = flowSheetParams(
      { feeCents: 93, totalCents: 3696, funding: "credit" },
      { clientSecret: "seti_live_123", ephemeralKey: "ek_test_123", customerId: "cus_123" },
    );
    expect(params.customFlow).toBe(true);
    expect(params.primaryButtonLabel).toBe("Pay $36.96 (includes $0.93 credit card surcharge)");
    expect(params.customerEphemeralKeySecret).toBe("ek_test_123");
    expect(skipNativeSheet("seti_test_abc")).toBe(true);
    expect(skipNativeSheet("seti_live_123")).toBe(false);
  });
});