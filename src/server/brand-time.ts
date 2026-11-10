import { formatDateTime, formatTime, type TimeFormat } from "@/lib/time";
import { loadDisplay } from "@/server/display";

/** The brand setting `time_format` (brand_settings.time_format): "12h" unless the brand picks "24h". */
export async function brandTimeFormat(): Promise<TimeFormat> {
  return (await loadDisplay()).timeFormat;
}

/** Reminders, receipts, texts and push: "Tue, Oct 27 · 2:05 PM" in the shop's zone, in the brand's format. */
export async function formatForHumans(instant: Date | number | string): Promise<string> {
  return formatDateTime(instant, await brandTimeFormat());
}

/** Just the time of day, "2:05 PM", in the brand's format. */
export async function formatClock(instant: Date | number | string): Promise<string> {
  return formatTime(instant, await brandTimeFormat());
}
