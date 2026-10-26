/** True when `current` is older than `min`. Missing pieces count as zero. */
export function needsUpdate(min: string, current: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number(part) || 0);
  const [a, b, c] = parse(current);
  const [x, y, z] = parse(min);
  if (a !== x) return a < x;
  if (b !== y) return b < y;
  return c < z;
}
