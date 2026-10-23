import { chicagoDate, formatLongDate } from "@rayz/api";

/** Calendar day in America/Chicago. A UTC date slice shifts visits that fall after midnight in Chicago. */
export function displayDate(instant: string, locale = "en-US"): string {
  return formatLongDate(chicagoDate(instant), locale);
}
