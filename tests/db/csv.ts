/** The heading a report CSV opens with: the report, its dates, its shops and the time zone. */
export const RANGE_CSV_HEAD = "Report,Date range,Shops,Time zone";

/** A report CSV without its date range heading (header row, value row, blank line), or the text as it is when it has none. */
export const csvBody = (text: string) => (text.startsWith(`${RANGE_CSV_HEAD}\n`) ? text.split("\n").slice(3).join("\n") : text);

/** The date range heading's values: report, dates, shops and time zone, or null without one. */
export function csvRange(text: string): { report: string; range: string; shops: string; timeZone: string } | null {
  if (!text.startsWith(`${RANGE_CSV_HEAD}\n`)) return null;
  const cells = [...text.split("\n")[1].matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map((x) => (x[1].startsWith('"') ? x[1].slice(1, -1).replace(/""/g, '"') : x[1]));
  return { report: cells[0], range: cells[1], shops: cells[2], timeZone: cells[3] };
}
