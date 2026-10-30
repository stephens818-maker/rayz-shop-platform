/** Whether the Text button can send. It is always shown; a missing phone or opt-in only disables it. */
export function textButtonState(o: { customerId: string | null; hasPhone: boolean; smsOptIn: boolean; canMessage: boolean }): { enabled: boolean; reason: string | null } {
  if (!o.canMessage) return { enabled: false, reason: "You can't text clients from this login" };
  if (!o.customerId) return { enabled: false, reason: "No client on this appointment" };
  if (!o.hasPhone) return { enabled: false, reason: "No phone number on file" };
  if (!o.smsOptIn) return { enabled: false, reason: "This client has not opted in to texts" };
  return { enabled: true, reason: null };
}
