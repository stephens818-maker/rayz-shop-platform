/** The name the public booking page may show. Never a last name, never a test account. */
export function publicBarberName(label: string): string {
  const stripped = label.replace(/\s*\(test\)\s*/gi, " ").trim();
  const first = stripped.split(/\s+/).filter(Boolean)[0] ?? stripped;
  return first.replace(/\.$/, "") || label;
}

/**
 * When two barbers at a shop share a first name, the public list uses the neutral display label
 * (Taylor A.). A unique first name stays on its own. Specialties are not shown.
 */
export function publicBarberLabels(labels: readonly string[]): string[] {
  const firsts = labels.map(publicBarberName);
  const counts = new Map<string, number>();
  for (const n of firsts) counts.set(n, (counts.get(n) ?? 0) + 1);
  return labels.map((label, i) => {
    if ((counts.get(firsts[i]) ?? 0) <= 1) return firsts[i];
    const neutral = label.replace(/\s*\(test\)\s*/gi, " ").replace(/\s+/g, " ").trim();
    return neutral || firsts[i];
  });
}

export function isTestBarberLabel(label: string): boolean {
  return /\(test\)/i.test(label);
}
