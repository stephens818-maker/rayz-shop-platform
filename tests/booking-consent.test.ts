/** The web booking form's text consent: unchecked to start, explicit wording, nothing sent unless ticked. */
import { describe, expect, it } from "vitest";
import { SMS_CONSENT_TEXT, consentFields, initialBookingForm } from "@/domain/booking-consent";

describe("booking SMS consent", () => {
  it("starts unchecked for texts and email", () => {
    expect(initialBookingForm().smsOptIn).toBe(false);
    expect(initialBookingForm().emailOptIn).toBe(false);
  });

  it("says what is sent, rates, STOP and HELP, and that it isn't required", () => {
    expect(SMS_CONSENT_TEXT).toMatch(/messages per booking/);
    expect(SMS_CONSENT_TEXT).toMatch(/Msg & data rates may apply/);
    expect(SMS_CONSENT_TEXT).toMatch(/Reply STOP to opt out/);
    expect(SMS_CONSENT_TEXT).toMatch(/HELP for help/);
    expect(SMS_CONSENT_TEXT).toMatch(/Not required to book/);
  });

  it("sends consent only when ticked, so an unticked box never opts a returning client out", () => {
    expect(consentFields({ smsOptIn: false, emailOptIn: false })).toEqual({});
    expect(consentFields({ smsOptIn: true, emailOptIn: false })).toEqual({ smsOptIn: true });
    expect(consentFields({ smsOptIn: true, emailOptIn: true })).toEqual({ smsOptIn: true, emailOptIn: true });
  });
});
