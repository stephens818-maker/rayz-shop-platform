/**
 * The campaign calendar: a month of blasts the person can see. Days a blast actually went out come
 * from its messages; upcoming sends come from its schedule, every repeat included, so a weekly blast
 * shows on each week it will go. Paused and A/B-testing blasts show too, marked.
 */
import { inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { occurrencesBetween } from "@/domain/campaign-schedule";
import type { Channel } from "@/domain/marketing";
import { SHOP_TZ } from "@/lib/time";
import { StaffContext } from "../auth/staff";
import { AppError } from "../errors";
import { listBlasts } from "./campaigns";

export interface CalendarEntry {
  campaignId: string;
  name: string;
  /** The local day, YYYY-MM-DD. */
  day: string;
  at: Date;
  /** Went out (with how many messages), or is still to go. */
  state: "sent" | "scheduled" | "paused" | "testing";
  sent: number;
  recurring: boolean;
  channels: Channel[];
  campaignType: "update" | "promotion";
}

export interface CampaignCalendar {
  month: string;
  timeZone: string;
  entries: CalendarEntry[];
  /** Drafts have no date yet; listed beside the calendar. */
  drafts: { id: string; name: string }[];
}

export async function campaignCalendar(ctx: StaffContext, month: string, now = new Date()): Promise<CampaignCalendar> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError("bad_request", "Pick a month like 2026-11");
  const blasts = await listBlasts(ctx);
  const firstShop = blasts.find((b) => b.shopIds.length)?.shopIds[0] ?? ctx.shopIds[0];
  const tzRow = firstShop ? await db.select({ tz: shops.timezone }).from(shops).where(inArray(shops.id, [firstShop])) : [];
  const timeZone = tzRow[0]?.tz || SHOP_TZ;
  const start = DateTime.fromISO(`${month}-01`, { zone: timeZone }).startOf("month");
  const end = start.endOf("month");
  const from = start.toJSDate();
  const to = end.toJSDate();
  const ids = blasts.map((b) => b.id);
  const sentDays = ids.length
    ? ((await db.execute(sql`
        select campaign_id, to_char(created_at at time zone ${timeZone}, 'YYYY-MM-DD') d, min(created_at) at, count(*)::int n
        from marketing_sends
        where status = 'queued' and campaign_id in (${sql.join(
          ids.map((x) => sql`${x}::uuid`),
          sql`, `,
        )}) and created_at >= ${from.toISOString()} and created_at <= ${to.toISOString()}
        group by 1, 2`)) as unknown as { campaign_id: string; d: string; at: string | Date; n: number }[])
    : [];
  const entries: CalendarEntry[] = [];
  const base = (b: (typeof blasts)[number]) => ({ campaignId: b.id, name: b.name, recurring: !!b.recurrence, channels: b.channels, campaignType: b.campaignType });
  for (const r of sentDays) {
    const b = blasts.find((x) => x.id === r.campaign_id)!;
    entries.push({ ...base(b), day: r.d, at: new Date(r.at), state: "sent", sent: Number(r.n) });
  }
  for (const b of blasts) {
    if (!b.scheduledAt || !["scheduled", "paused", "testing"].includes(b.status)) continue;
    const state = b.status as CalendarEntry["state"];
    // While an A/B test runs, the date that matters is when the winner goes to everyone else.
    const next = b.status === "testing" && b.ab?.testEndsAt ? new Date(b.ab.testEndsAt) : b.scheduledAt;
    const upcoming =
      b.recurrence && b.status !== "testing"
        ? occurrencesBetween(b.recurrence, b.recurrence.anchor ? new Date(b.recurrence.anchor) : b.scheduledAt, new Date(Math.max(from.getTime(), b.scheduledAt.getTime())), to, timeZone)
        : next >= from && next <= to
          ? [next]
          : [];
    for (const at of upcoming) {
      const day = DateTime.fromJSDate(at).setZone(timeZone).toISODate()!;
      // A send that already went out today is shown as sent, not again as upcoming.
      if (at <= now && entries.some((e) => e.campaignId === b.id && e.day === day)) continue;
      entries.push({ ...base(b), day, at, state, sent: 0 });
    }
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime() || a.name.localeCompare(b.name));
  return { month, timeZone, entries, drafts: blasts.filter((b) => b.status === "draft").map((b) => ({ id: b.id, name: b.name })) };
}
