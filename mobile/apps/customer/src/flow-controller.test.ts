import { describe, expect, it } from "vitest";
import { afterSheet, flowButtonLabel, flowSheetParams, labelContainsCardNumber, NOTHING_CHARGED, skipNativeSheet } from "./flow-controller";

describe("PaymentSheet flow button", () => {
  it("shows the fee and total before pay and never a card number", () => {
    const label = flowButtonLabel({ feeCents: 93, totalCents: 3696, funding: "credit" });
    expect(label).toBe("Pay $36.96 (includes $0.93 credit card surcharge)");
    expect(flowButtonLabel({ feeCents: 0, totalCents: 3603, funding: "debit" })).toBe("Pay $36.03 · No surcharge on debit cards");
    expect(labelContainsCardNumber(label)).toBe(false);
    expect(label).not.toMatch(/4242|5556/);
  });

  it("opens FlowController on a PaymentIntent and skips sandbox secrets", () => {
    const params = flowSheetParams(
      { feeCents: 93, totalCents: 3696, funding: "credit" },
      { clientSecret: "pi_live_123", ephemeralKey: "ek_test_123", customerId: "cus_123" },
    );
    expect(params.customFlow).toBe(true);
    expect(params.paymentIntentClientSecret).toBe("pi_live_123");
    expect("setupIntentClientSecret" in params).toBe(false);
    expect(params.primaryButtonLabel).toBe("Pay $36.96 (includes $0.93 credit card surcharge)");
    expect(params.customerEphemeralKeySecret).toBe("ek_test_123");
    expect(skipNativeSheet("seti_test_abc")).toBe(true);
    expect(skipNativeSheet("pi_test_abc")).toBe(true);
    expect(skipNativeSheet("pi_live_123")).toBe(false);
  });

  it("does not charge when PaymentSheet is canceled or returns an error", () => {
    const cancel = afterSheet({ init: {}, present: { error: { code: "Canceled", message: "The payment has been canceled" } } });
    expect(cancel.charge).toBe(false);
    expect(cancel.message).toBe(NOTHING_CHARGED);
    const failed = afterSheet({ init: { error: { code: "Failed", message: "Unable to initialize" } } });
    expect(failed.charge).toBe(false);
    expect(failed.message).toBe("Nothing was charged.");
    const confirmError = afterSheet({ init: {}, present: {}, confirm: { error: { code: "Failed", message: "card_declined" } } });
    expect(confirmError.charge).toBe(false);
    expect(confirmError.message).toBe(NOTHING_CHARGED);
    expect(afterSheet({ init: {}, present: {}, confirm: {} })).toEqual({ charge: true, message: null });
  });
});