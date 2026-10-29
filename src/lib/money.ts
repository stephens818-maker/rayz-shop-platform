/** Fractions of a cent (per-message costs) are rounded to the nearest cent. */
export function formatCents(raw: number, opts: { sign?: boolean } = {}): string {
  const cents = Math.round(raw);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `$${Math.floor(abs / 100).toLocaleString("en-US")}.${(abs % 100).toString().padStart(2, "0")}`;
  if (neg) return `-${s}`;
  return opts.sign && cents > 0 ? `+${s}` : s;
}

/** "12.5" / "$12.50" / "12" → 1250. Returns NaN for junk. */
export function parseDollars(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return NaN;
  if (typeof input === "number") return Math.round(input * 100);
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "") return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Rate stored as a fraction (0.07 = 7%). Rounded so 0.07 is "7%", not "7.%". */
export function formatRate(rate: number): string {
  const pct = Number((rate * 100).toFixed(3));
  return `${Number.isInteger(pct) ? pct.toFixed(0) : String(pct)}%`;
}

/** Banker-safe integer rounding of cents × rate (half away from zero). */
export function applyRate(cents: number, rate: number): number {
  const v = cents * rate;
  return v >= 0 ? Math.round(v + 1e-9) : -Math.round(-v + 1e-9);
}

/** Split `total` across `weights` proportionally, using largest remainder so parts sum exactly. */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}
