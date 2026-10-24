import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, openingsWaitlist, staff } from "@/db/schema";
import { OPENINGS_STATUS_LABEL, OpeningsSegmentSchema } from "@/domain/openings";
import { Cell, Column, ListRow, ViewCtx, listTable } from "@/domain/report-views";
import { endOfLocalDay, formatDate, formatDateTime, startOfLocalDay } from "@/lib/time";
import type { ReportData } from "../report-data";
import { ReportScope, staffSelection } from "../reports";
import { openingsStats } from "./openings";

const int = (label: string): Column => ({ label, kind: "int" });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });
const OPEN = 5;
/** Fill rate is bookings over the open times at send; click rate is clicks over messages. */
const derive = (c: Cell[]): Cell[] => {
  const n = (i: number) => Number(c[i]) || 0;
  return [...c.slice(0, OPEN + 3), n(OPEN + 1) ? n(OPEN + 2) / n(OPEN + 1) : null, n(OPEN + 4), n(OPEN) ? n(OPEN + 4) / n(OPEN) : null, n(OPEN + 6)];
};

/**
 * We have openings, per blast: the barber and days, who sent it and its status, the open times when
 * it went, messages sent, clients who clicked, and bookings: recipients who booked with that barber
 * at that location on those days after the message (not cancelled since).
 */
export async function openingsReportData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const sel = staffSelection(scope);
  const rows = await db
    .select()
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.kind, "openings"),
        sql`${marketingCampaigns.createdAt} >= ${startOfLocalDay(scope.from).toISOString()} and ${marketingCampaigns.createdAt} <= ${endOfLocalDay(scope.to).toISOString()}`,
        sql`${marketingCampaigns.shopIds}->>0 in (${sql.join(
          scope.shopIds.map((x) => sql`${x}`),
          sql`, `,
        )})`,
        sel ? sql`${marketingCampaigns.segment}->>'staffId' in (${sql.join(sel.length ? sel.map((x) => sql`${x}`) : [sql`''`], sql`, `)})` : undefined,
      ),
    );
  const segs = new Map(rows.map((c) => [c.id, OpeningsSegmentSchema.safeParse(c.segment).data]));
  const people = [...new Set(rows.flatMap((c) => [c.createdBy, segs.get(c.id)?.staffId].filter((x): x is string => !!x)))];
  const ids = rows.map((c) => c.id);
  const [names, stats, wait] = await Promise.all([
    people.length ? db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, people)) : [],
    openingsStats(ids),
    ids.length
      ? db
          .select({ id: openingsWaitlist.campaignId, n: sql<number>`count(*)::int` })
          .from(openingsWaitlist)
          .where(inArray(openingsWaitlist.campaignId, ids))
          .groupBy(openingsWaitlist.campaignId)
      : [],
  ]);
  const label = new Map(names.map((n) => [n.id, n.label]));
  const waiting = new Map(wait.map((w) => [w.id, w.n]));
  const list: ListRow[] = rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((c) => {
      const seg = segs.get(c.id);
      const st = stats.get(c.id) ?? { sent: 0, clicked: 0, booked: 0 };
      const open = Number(c.settings?.openSlots ?? 0);
      return {
        shopId: c.shopIds[0],
        staffId: seg?.staffId ?? null,
        cells: derive([
          formatDateTime(c.createdAt),
          seg ? (label.get(seg.staffId) ?? "") : "",
          seg ? seg.dates.map((d) => formatDate(d, "EEE, MMM d")).join(", ") : "",
          c.createdBy ? (label.get(c.createdBy) ?? "") : "",
          OPENINGS_STATUS_LABEL[c.status] ?? c.status,
          open,
          st.sent,
          st.clicked,
          null,
          st.booked,
          null,
          waiting.get(c.id) ?? 0,
        ]),
      };
    });
  const sum = (f: (r: ListRow) => number) => list.reduce((a, r) => a + f(r), 0);
  const sent = sum((r) => Number(r.cells[OPEN + 1]) || 0);
  const clicked = sum((r) => Number(r.cells[OPEN + 2]) || 0);
  const booked = sum((r) => Number(r.cells[OPEN + 4]) || 0);
  const open = sum((r) => Number(r.cells[OPEN]) || 0);
  const went = rows.filter((c) => c.status === "sent").length;
  return {
    stats: [
      { label: "Openings blasts", value: String(went), hint: rows.length > went ? `${rows.length - went} waiting, turned down or expired` : undefined },
      { label: "Messages sent", value: String(sent) },
      { label: "Clicked", value: String(clicked), hint: sent ? `${Math.round((clicked / sent) * 100)}% of messages` : undefined },
      { label: "Booked", value: String(booked), hint: open ? `${Math.round((booked / open) * 100)}% of ${open} open times filled` : undefined },
    ],
    tables: [
      listTable(loc, {
        id: "blasts",
        title: "Openings blasts",
        subtitle: "One row per barber per send. Bookings are recipients who booked with that barber, at that location, on those days, after the message.",
        columns: [
          { label: "Sent" },
          { label: "Barber" },
          { label: "Days" },
          { label: "Sent by" },
          { label: "Status" },
          int("Open times at send"),
          int("Messages"),
          int("Clicked"),
          pct("Click rate"),
          int("Booked"),
          pct("Fill rate"),
          int("Waitlist"),
        ],
        rows: list,
        keepShop: true,
        derive,
        labelAt: 0,
      }),
    ],
    notes: [
      "We have openings tells a barber's regulars (two or more visits with them at the location in a year) and recent clients, who agreed to marketing and have nothing booked, that the barber has open times. Each client gets at most one openings message in the brand's openings window, on top of the weekly and monthly limits.",
      "Fill rate is bookings over the open times when the message went. A booking counts once per client, whichever time they took.",
    ],
  };
}
