/**
 * Text-message consent shown on the web booking form. TCPA needs consent to be an
 * affirmative act, so the box starts unchecked and booking never depends on it.
 */
export const SMS_CONSENT_TEXT =
  "Text me my booking confirmation and reminders (about 3 messages per booking). Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to book.";

export const EMAIL_CONSENT_TEXT = "Email me confirmations and reminders too";

export function initialBookingForm() {
  return { firstName: "", lastName: "", phone: "", email: "", smsOptIn: false, emailOptIn: false };
}

/** Only an explicit tick is sent: an unticked box leaves a returning client's earlier choice alone. */
export function consentFields(form: { smsOptIn: boolean; emailOptIn: boolean }): { smsOptIn?: true; emailOptIn?: true } {
  return { ...(form.smsOptIn ? { smsOptIn: true as const } : {}), ...(form.emailOptIn ? { emailOptIn: true as const } : {}) };
}
