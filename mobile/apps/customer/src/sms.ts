/** Opt-out sticks. The app can turn texts off and can never send them back on. */
export const CONSENT_TEXT_VERSION = "2026-10-23";

export function smsToggle(optedIn: boolean): { on: boolean; enabled: boolean; note: string | null } {
  if (optedIn) return { on: true, enabled: true, note: null };
  return { on: false, enabled: false, note: "Text START to resubscribe." };
}

export function smsPatch(optedIn: boolean, next: { smsMarketingOptIn: boolean; turnSmsOff: boolean }): { smsOptIn?: false; smsMarketingOptIn: boolean; consentTextVersion?: string } {
  const body: { smsOptIn?: false; smsMarketingOptIn: boolean; consentTextVersion?: string } = { smsMarketingOptIn: next.smsMarketingOptIn };
  if (!optedIn || next.turnSmsOff) body.smsOptIn = false;
  if (next.smsMarketingOptIn) body.consentTextVersion = CONSENT_TEXT_VERSION;
  return body;
}
