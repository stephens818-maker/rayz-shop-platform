/**
 * Versions of the customer-facing legal texts. A consent record stores the version the client saw,
 * so change the version whenever the wording that a consent relies on changes.
 */
export const PRIVACY_VERSION = "2026-10-26";
export const TERMS_VERSION = "2026-10-26";
export const LEGAL_UPDATED = "October 26, 2026";

/** The SMS program terms carriers require on the opt-in page and in the terms (CTIA and 10DLC campaign review). */
export const SMS_PROGRAM = {
  name: "Ray'z Barber Shop appointment texts",
  frequency: "Message frequency varies, usually about 3 texts per booking.",
  rates: "Message and data rates may apply.",
  stop: "Reply STOP to any text to stop. Reply START to start again.",
  help: "Reply HELP for help, or contact us on the support page.",
  carriers: "Carriers are not liable for delayed or undelivered messages.",
  noSharing: "We don't share your mobile number or text-message consent with anyone for their own marketing.",
};
