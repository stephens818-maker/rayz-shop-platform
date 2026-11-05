import { isDate, payPeriodFor, type DateRange } from "./dates";
import type { EarningsQuery } from "./types";

/** Builds the query string for /me/earnings*. The signed-in employee comes from the token. staffId is rejected. */
export function earningsSearch(query: EarningsQuery): string {
  if (query && typeof query === "object" && "staffId" in query) {
    throw new Error("staffId is not allowed on earnings requests");
  }
  const params = new URLSearchParams();
  if ("from" in query) {
    if (!isDate(query.from) || !isDate(query.to)) throw new Error("from and to must be YYYY-MM-DD");
    params.set("from", query.from);
    params.set("to", query.to);
  } else if ("period" in query) {
    params.set("period", query.period);
  } else {
    params.set("periodId", query.periodId);
  }
  return params.toString();
}

export function rangeFromSearch(search: URLSearchParams, today: string): DateRange | { error: string } {
  const staffId = search.get("staffId");
  if (staffId) return { error: "staffId is not allowed" };
  const from = search.get("from");
  const to = search.get("to");
  const period = search.get("period");
  const periodId = search.get("periodId");
  const hasRange = Boolean(from || to);
  const hasPeriod = Boolean(period || periodId);
  if (hasRange && hasPeriod) return { error: "Send from/to or a period, not both" };
  if (from || to) {
    if (!from || !to || !isDate(from) || !isDate(to) || from > to) return { error: "from and to must be a valid Chicago date range" };
    return { from, to };
  }
  if (period === "current") {
    const p = payPeriodFor(today);
    return { from: p.start, to: p.end };
  }
  const id = periodId || (period && period !== "current" ? period : null);
  if (id) {
    if (!isDate(id)) return { error: "periodId must be the period start date" };
    const p = payPeriodFor(id);
    if (p.id !== id) return { error: "Unknown pay period" };
    return { from: p.start, to: p.end };
  }
  return { error: "from/to or periodId is required" };
}
