/** Opt-out sticks. The app can turn texts off and can never send them back on. */
export function smsToggle(optedIn: boolean): { on: boolean; enabled: boolean; note: string | null } {
  if (optedIn) return { on: true, enabled: true, note: null };
  return { on: false, enabled: false, note: "Text START to resubscribe." };
}

export function smsPatch(optedIn: boolean, next: { smsMarketingOptIn: boolean; turnSmsOff: boolean }): { smsOptIn?: false; smsMarketingOptIn: boolean } {
  const body: { smsOptIn?: false; smsMarketingOptIn: boolean } = { smsMarketingOptIn: next.smsMarketingOptIn };
  if (!optedIn || next.turnSmsOff) body.smsOptIn = false;
  return body;
}
