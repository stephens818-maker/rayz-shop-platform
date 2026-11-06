/** The name the public booking page may show. Never a last name, never a test account. */
export function publicBarberName(label: string): string {
  const stripped = label.replace(/\s*\(test\)\s*/gi, " ").trim();
  const first = stripped.split(/\s+/).filter(Boolean)[0] ?? stripped;
  return first.replace(/\.$/, "") || label;
}

/**
 * When two barbers at a shop share a first name, the public list adds a specialty (never a last
 * name). A unique first name stays on its own.
 */
export function publicBarberHints(names: readonly string[], specialties: readonly (string | null | undefined)[]): (string | null)[] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return names.map((n, i) => ((counts.get(n) ?? 0) > 1 ? specialties[i]?.trim() || null : null));
}

export function isTestBarberLabel(label: string): boolean {
  return /\(test\)/i.test(label);
}
