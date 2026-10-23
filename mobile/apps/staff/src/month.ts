import { weekday } from "@rayz/api";

/** Sunday-first cells for a one-hand month grid. Leading blanks pad the first week. */
export function monthCells(year: number, month: number): { date: string | null }[] {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const lead = weekday(first);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: { date: string | null }[] = [];
  for (let i = 0; i < lead; i += 1) cells.push({ date: null });
  for (let day = 1; day <= count; day += 1) {
    cells.push({ date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` });
  }
  return cells;
}
