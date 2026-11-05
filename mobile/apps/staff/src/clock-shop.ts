/** One shop clocks in directly. More than one waits for a pick instead of the first id. */
export function shopForClock(shops: string[], picked: string | null): string | null {
  if (picked && shops.includes(picked)) return picked;
  if (shops.length === 1) return shops[0];
  return null;
}