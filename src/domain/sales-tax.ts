import type { LocalDate } from "@/lib/time";

/**
 * Sales tax is filed per state, each on its own schedule. The brand sets how often each state is
 * filed (brand_settings.tax_filing); Iowa defaults to monthly and every other state to quarterly.
 * The Sales tax report and its saved shortcuts follow the schedule.
 */

export type FilingFrequency = "monthly" | "quarterly";
export type TaxPeriod = "month" | "quarter";

export const FILING_LABEL: Record<FilingFrequency, string> = { monthly: "Monthly", quarterly: "Quarterly" };
export const PERIOD_OF: Record<FilingFrequency, TaxPeriod> = { monthly: "month", quarterly: "quarter" };
const DEFAULT_FILING: Record<string, FilingFrequency> = { IA: "monthly" };

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** "IA", "ia " and "Iowa" are all Iowa; anything else is kept as typed, upper-cased. */
export function stateCode(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  const up = t.toUpperCase();
  if (STATE_NAMES[up]) return up;
  const byName = Object.entries(STATE_NAMES).find(([, n]) => n.toUpperCase() === up);
  return byName ? byName[0] : up;
}
export const stateName = (code: string) => (code ? (STATE_NAMES[code] ?? code) : "No state set");

export function cleanTaxFiling(raw: unknown): Record<string, FilingFrequency> {
  const out: Record<string, FilingFrequency> = {};
  if (raw && typeof raw === "object")
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const code = stateCode(k);
      if (code && (v === "monthly" || v === "quarterly")) out[code] = v;
    }
  return out;
}

export const filingFor = (filing: Record<string, FilingFrequency>, state: string): FilingFrequency => filing[state] ?? DEFAULT_FILING[state] ?? "quarterly";

/** "2026-09" for a month, "2026-Q3" for a quarter. */
export function periodKey(date: LocalDate, p: TaxPeriod): string {
  const [y, m] = date.split("-").map(Number);
  return p === "month" ? date.slice(0, 7) : `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 2026", "Q3 2026". */
export function periodLabel(key: string): string {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  if (q) return `Q${q[2]} ${q[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : key;
}

export const parsePeriod = (v: unknown): TaxPeriod | null => (v === "month" || v === "quarter" ? v : null);

/** The saved "Iowa monthly sales tax" style shortcuts: the last full filing period for each state. */
export function taxShortcuts(states: readonly string[], filing: Record<string, FilingFrequency>) {
  return [...new Set(states.map(stateCode).filter(Boolean))].sort().map((state) => {
    const f = filingFor(filing, state);
    return {
      state,
      frequency: f,
      label: `${stateName(state)} ${f} sales tax`,
      query: `state=${state}&period=${PERIOD_OF[f]}&preset=${f === "monthly" ? "lastmonth" : "lastquarter"}`,
    };
  });
}
