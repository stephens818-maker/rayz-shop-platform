import type { ConsentChannel, ConsentSource } from "@/db/schema";
import { EMAIL_CONSENT_TEXT, SMS_CONSENT_TEXT } from "./booking-consent";

/**
 * The wording a client agrees to, per channel, with the version every consent record stores. Changing a
 * text means a new version (tests pin each version to its text), so a record always says what was shown.
 * The app shows `text` beside an unchecked box and sends `version` back with the yes.
 */
export const CONSENT_TEXTS: Record<ConsentChannel, { version: string; label: string; text: string; marketing: boolean }> = {
  sms_transactional: { version: "sms-2026-10-26", label: "Appointment texts", text: SMS_CONSENT_TEXT, marketing: false },
  email: { version: "email-2026-10-26", label: "Appointment emails", text: EMAIL_CONSENT_TEXT, marketing: false },
  push_transactional: {
    version: "push-2026-10-26",
    label: "Appointment notifications",
    text: "Send app notifications about my appointments, receipts and rewards. Turn them off here or in your phone's settings.",
    marketing: false,
  },
  sms_marketing: {
    version: "sms-marketing-2026-10-26",
    label: "Offer and opening texts",
    text: "Text me offers, open chairs and rebooking reminders from Ray'z Barber Shop, using automated technology, at the number on my account. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of any purchase.",
    marketing: true,
  },
  email_marketing: {
    version: "email-marketing-2026-10-26",
    label: "Offer emails",
    text: "Email me offers, open chairs and news from Ray'z Barber Shop. Every email has a one-click unsubscribe.",
    marketing: true,
  },
  push_marketing: {
    version: "push-marketing-2026-10-26",
    label: "Offer notifications",
    text: "Send app notifications about offers and open chairs. Turn them off here anytime.",
    marketing: true,
  },
};

export const CONSENT_CHANNELS = Object.keys(CONSENT_TEXTS) as ConsentChannel[];

/** Text versions for records that aren't a client ticking a box. */
export const CONSENT_MARKERS = {
  stop: "STOP",
  start: "START",
  import: "squire-import",
  staff: "staff-edit",
  unsubscribe: "unsubscribe-link",
  deleted: "account-deleted",
  merge: "profiles-merged",
} as const;

/** The customer columns behind each channel. */
export const CONSENT_COLUMN = {
  sms_transactional: "smsOptIn",
  email: "emailOptIn",
  push_transactional: "pushTransactional",
  sms_marketing: "smsMarketingOptIn",
  email_marketing: "emailMarketingOptIn",
  push_marketing: "pushMarketing",
} as const satisfies Record<ConsentChannel, string>;

export type ConsentFlags = { [K in (typeof CONSENT_COLUMN)[ConsentChannel]]: boolean };

/** Only the flags, so nothing else on the record rides along. */
export const consentFlags = (c: ConsentFlags): ConsentFlags =>
  Object.fromEntries(Object.values(CONSENT_COLUMN).map((col) => [col, !!c[col]])) as ConsentFlags;

/** Where a request came from, by the app's X-Client header; anything else is the website. */
export const consentSource = (client: string | null | undefined): ConsentSource => (client === "ios" || client === "android" ? client : "web");

/** The grants and revokes between two states of a client's flags; a flag left out of `after` didn't change. */
export function consentDiff(before: Partial<ConsentFlags>, after: Partial<ConsentFlags>): { channel: ConsentChannel; granted: boolean }[] {
  const out: { channel: ConsentChannel; granted: boolean }[] = [];
  for (const channel of CONSENT_CHANNELS) {
    const col = CONSENT_COLUMN[channel];
    const next = after[col];
    if (next === undefined || !!before[col] === next) continue;
    out.push({ channel, granted: next });
  }
  return out;
}
