/** Staff chat must not carry a client's phone or email, even if someone pastes one. */
export function staffChatBody(raw: string): string {
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email hidden]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[number hidden]")
    .trim()
    .slice(0, 2000);
}

/** The name shown in search when the viewer is allowed to see the real last name. */
export function clientListName(hit: { firstName: string; lastName: string | null; short: string }): string {
  const last = hit.lastName?.trim() ?? "";
  if (last.replace(/\./g, "").length > 1) return `${hit.firstName} ${last}`.trim();
  return hit.short;
}
