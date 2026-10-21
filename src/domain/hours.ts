export interface HoursRow {
  weekday: number;
  openMin: number;
  closeMin: number;
}

/**
 * Why a weekly-hours save is refused, or null. Every Ray'z shop is closed Sundays: a shop manager
 * can keep or close the Sunday hours already set, but opening or changing Sunday is a brand-level
 * setting (settings.brand, the Brand Owner).
 */
export function hoursProblem(rows: HoursRow[], who: { canSetSunday: boolean; currentSunday: Pick<HoursRow, "openMin" | "closeMin"> | null }): { code: "bad_request" | "forbidden"; message: string } | null {
  for (const r of rows) {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return { code: "bad_request", message: "Unknown weekday" };
    if (!Number.isInteger(r.openMin) || !Number.isInteger(r.closeMin) || r.openMin < 0 || r.closeMin > 24 * 60) return { code: "bad_request", message: "Hours must be within the day" };
    if (r.closeMin <= r.openMin) return { code: "bad_request", message: "Closing time must be after opening time" };
  }
  if (new Set(rows.map((r) => r.weekday)).size !== rows.length) return { code: "bad_request", message: "One row per weekday" };
  const sunday = rows.find((r) => r.weekday === 0);
  const unchanged = !!sunday && !!who.currentSunday && who.currentSunday.openMin === sunday.openMin && who.currentSunday.closeMin === sunday.closeMin;
  if (sunday && !who.canSetSunday && !unchanged) return { code: "forbidden", message: "Only the Brand Owner can open a shop on Sundays or change its Sunday hours" };
  return null;
}
