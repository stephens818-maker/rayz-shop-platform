/** Integer cents. The apps never compute payroll; they only format amounts the server already decided. */

export function formatCents(cents: number, locale = "en-US"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString(locale);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rem}`;
}

export function formatHours(hours: number): string {
  if (Number.isInteger(hours)) return String(hours);
  const rounded = Math.round(hours * 100) / 100;
  return String(rounded);
}

export function applyRate(cents: number, rate: number): number {
  const v = cents * rate;
  return v >= 0 ? Math.round(v + 1e-9) : -Math.round(-v + 1e-9);
}
