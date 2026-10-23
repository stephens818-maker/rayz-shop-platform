import { describe, expect, it } from "vitest";
import { smsPatch, smsToggle } from "./sms";

describe("sticky SMS", () => {
  it("shows off, blocks the switch, and tells the customer to text START", () => {
    const off = smsToggle(false);
    expect(off).toEqual({ on: false, enabled: false, note: "Text START to resubscribe." });
    expect(smsToggle(true).enabled).toBe(true);
  });

  it("never sends smsOptIn true", () => {
    expect(smsPatch(false, { smsMarketingOptIn: true, turnSmsOff: false })).toEqual({ smsOptIn: false, smsMarketingOptIn: true, consentTextVersion: "2026-10-23" });
    expect(smsPatch(true, { smsMarketingOptIn: false, turnSmsOff: true }).smsOptIn).toBe(false);
    expect(smsPatch(true, { smsMarketingOptIn: true, turnSmsOff: false }).smsOptIn).toBeUndefined();
    expect(smsPatch(true, { smsMarketingOptIn: true, turnSmsOff: false }).consentTextVersion).toBe("2026-10-23");
    expect(smsPatch(true, { smsMarketingOptIn: false, turnSmsOff: false }).consentTextVersion).toBeUndefined();
  });
});
