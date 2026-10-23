import { describe, expect, it } from "vitest";
import { afterSheet, confirmAllowed, flowButtonLabel, flowSheetParams, labelContainsCardNumber, nativeChargePlan, nextChargeStep, NOTHING_CHARGED, sheetCardSwitched, skipNativeSheet } from "./flow-controller";

describe("PaymentSheet flow button", () => {
  it("shows the fee and total before pay and never a card number", () => {
    const label = flowButtonLabel({ feeCents: 93, totalCents: 3696, funding: "credit" });
    expect(label).toBe("Pay $36.96 (includes $0.93 credit card surcharge)");
    expect(flowButtonLabel({ feeCents: 0, totalCents: 3603, funding: "debit" })).toBe("Pay $36.03 · No surcharge on debit cards");
    expect(labelContainsCardNumber(label)).toBe(false);
    expect(label).not.toMatch(/4242|5556/);
  });

  it("shows the debit label for wallet debit", () => {
    expect(flowButtonLabel({ feeCents: 0, totalCents: 3603, funding: "debit" })).toBe("Pay $36.03 · No surcharge on debit cards");
  });

  it("opens FlowController on a PaymentIntent and skips sandbox setup secrets", () => {
    const params = flowSheetParams(
      { feeCents: 93, totalCents: 3696, funding: "credit" },
      { clientSecret: "pi_live_3Mq_secret_abc", ephemeralKey: "ek_test_123", customerId: "cus_123" },
    );
    expect(params.customFlow).toBe(true);
    expect(params.paymentIntentClientSecret).toBe("pi_live_3Mq_secret_abc");
    expect("setupIntentClientSecret" in params).toBe(false);
    expect(params.primaryButtonLabel).toBe("Pay $36.96 (includes $0.93 credit card surcharge)");
    expect(params.customerEphemeralKeySecret).toBe("ek_test_123");
    expect(skipNativeSheet("seti_test_abc")).toBe(true);
    expect(skipNativeSheet("seti_test_abc_secret_xyz")).toBe(false);
  });

  it("finishes a Stripe test-card payment through PaymentSheet and a mock sandbox payment without it", () => {
    expect(nativeChargePlan("pi_test_3Mq_secret_abc")).toBe("sheet");
    expect(nativeChargePlan("pi_live_3Mq_secret_abc")).toBe("sheet");
    expect(nativeChargePlan("pi_test_abc")).toBe("sandbox");
    expect(nativeChargePlan("pi_live_123")).toBe("refuse");
    expect(nativeChargePlan("seti_test_abc")).toBe("refuse");
    expect(nextChargeStep({ plan: "sandbox", confirm: true, sheetSwitched: false })).toBe("charge");
    expect(nextChargeStep({ plan: "sheet", confirm: true, sheetSwitched: false })).toBe("charge");
    expect(nextChargeStep({ plan: "refuse", confirm: true, sheetSwitched: false })).toBe("nothing");
    expect(nextChargeStep({ plan: "sheet", confirm: true, sheetSwitched: true })).toBe("reprice");
  });

  it("blocks confirm until the repriced total for the selected card is shown", () => {
    expect(confirmAllowed({
      selectedPaymentMethodId: "pm_card_visa_debit",
      previewPaymentMethodId: "pm_card_visa",
      previewTotalCents: 3696,
      displayedTotalCents: 3696,
    })).toEqual({ confirm: false, reprice: true });
    expect(confirmAllowed({
      selectedPaymentMethodId: "pm_card_visa_debit",
      previewPaymentMethodId: null,
      previewTotalCents: null,
      displayedTotalCents: null,
    })).toEqual({ confirm: false, reprice: true });
    expect(confirmAllowed({
      selectedPaymentMethodId: "pm_card_visa_debit",
      previewPaymentMethodId: "pm_card_visa_debit",
      previewTotalCents: 3603,
      displayedTotalCents: 3696,
    })).toEqual({ confirm: false, reprice: false });
    expect(confirmAllowed({
      selectedPaymentMethodId: "pm_card_visa_debit",
      previewPaymentMethodId: "pm_card_visa_debit",
      previewTotalCents: 3603,
      displayedTotalCents: 3603,
    })).toEqual({ confirm: true, reprice: false });
    expect(sheetCardSwitched("Visa ••4242", "Visa ••5556")).toBe(true);
    expect(sheetCardSwitched("Visa ••4242", "visa ••4242")).toBe(false);
    expect(sheetCardSwitched("Visa ••4242", null)).toBe(false);
    expect(nextChargeStep({ plan: "sheet", confirm: false, sheetSwitched: false })).toBe("reprice");
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