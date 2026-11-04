/** The name the public booking page may show. Never a last name, never a test account. */
export function publicBarberName(label: string): string {
  const stripped = label.replace(/\s*\(test\)\s*/gi, " ").trim();
  const first = stripped.split(/\s+/).filter(Boolean)[0] ?? stripped;
  return first.replace(/\.$/, "") || label;
}

export function isTestBarberLabel(label: string): boolean {
  return /\(test\)/i.test(label);
}
