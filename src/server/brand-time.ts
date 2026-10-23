import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings } from "@/db/schema";
import { formatDateTime, formatTime, type TimeFormat } from "@/lib/time";

/** Brand clock setting. Missing or unknown values stay 12-hour. Column is `brand_settings.time_format`. */
export async function brandTimeFormat(): Promise<TimeFormat> {
  const row = await db.query.brandSettings.findFirst({ where: eq(brandSettings.id, 1) });
  return row?.timeFormat === "24h" ? "24h" : "12h";
}

/** Appointment reminders, receipts, SMS, and push text. America/Chicago, brand `time_format`, default 12-hour. */
export async function formatForHumans(instant: Date | number | string): Promise<string> {
  return formatDateTime(instant, await brandTimeFormat());
}

export async function formatClock(instant: Date | number | string): Promise<string> {
  return formatTime(instant, await brandTimeFormat());
}
