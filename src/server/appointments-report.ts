import "server-only";
import { sql } from "drizzle-orm";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  AppointmentStatus,
  BOOKING_METHODS,
  BOOKING_METHOD_LABEL,
  BookingMethod,
  PAYMENT_FILTERS,
  PAYMENT_LABEL,
  PLATFORMS,
  PLATFORM_LABEL,
  matchesFilters,
  parseAppointmentFilters,
  paymentOf,
  platformOf,
} from "@/domain/appointment-report";
import { Cell, Column, ViewCtx, listTable, staffName } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import type { ReportData, ReportOption } from "./report-data";
import { PAID, ReportScope, ids, rows, staffFilter } from "./report-sql";

interface Row {
  id: string;
  code: string;
  shopId: string;
  staffId: string;
  day: string;
  time: string;
  status: AppointmentStatus;
  source: BookingMethod;
  services: string | null;
  estimateCents: number;
  totalCents: number | null;
  tipCents: number | null;
  methods: string[] | null;
}

/** Appointments by the day they're for, with their ticket and how it was paid. Capped so a year at every shop still loads. */
export async function appointmentRows(scope: ReportScope, limit = 20000): Promise<Row[]> {
  return rows<Row>(sql`
    select a.id, a.code, a.shop_id "shopId", a.staff_id "staffId", to_char(a.starts_at at time zone 'America/Chicago', 'YYYY-MM-DD') as day,
      to_char(a.starts_at at time zone 'America/Chicago', 'HH24:MI') as time, a.status, a.source, a.estimate_cents "estimateCents",
      (select string_agg(i.name, ', ' order by i.kind, i.name) from appointment_items i where i.appointment_id = a.id) services,
      s.total_cents "totalCents", s.tip_cents "tipCents",
      (select array_agg(distinct p.method::text) from payments p where p.sale_id = s.id and p.status in ('succeeded', 'refunded', 'partially_refunded')) methods
    from appointments a
    left join lateral (
      select s.id, s.total_cents, s.tip_cents from sales s
      where s.status in ${PAID} and (s.appointment_id = a.id or exists (select 1 from sale_appointments sa where sa.sale_id = s.id and sa.appointment_id = a.id))
      order by s.created_at limit 1
    ) s on true
    where a.shop_id in ${ids(scope)} and (a.starts_at at time zone 'America/Chicago')::date between ${scope.from}::date and ${scope.to}::date
      ${staffFilter(sql`a.staff_id`, scope)}
    order by a.starts_at desc
    limit ${limit}`);
}

const option = (param: string, label: string, value: string | null, choices: [string, string][]): ReportOption => ({
  param,
  label,
  value: value ?? "",
  choices: [["", "All"] as [string, string], ...choices].map(([v, l]) => ({ value: v, label: l })),
  select: true,
});

const int = (label: string): Column => ({ label, kind: "int" });
const money = (label: string): Column => ({ label, kind: "money" });
const text = (label: string): Column => ({ label });

export async function appointmentsReportData(scope: ReportScope, loc: ViewCtx, params: Record<string, string | undefined>): Promise<ReportData> {
  const f = parseAppointmentFilters(params);
  const all = await appointmentRows(scope);
  const r = all.filter((x) => matchesFilters(x, f));
  const done = r.filter((x) => x.status === "completed").length;
  const cancelled = r.filter((x) => x.status === "cancelled").length;
  const noShows = r.filter((x) => x.status === "no_show").length;
  const collected = r.reduce((a, x) => a + (x.totalCents ?? 0), 0);
  const booked = r.filter((x) => x.status !== "cancelled").reduce((a, x) => a + x.estimateCents, 0);
  const pct = (n: number) => (r.length ? `${Math.round((n / r.length) * 100)}%` : "—");

  const breakdown = (id: string, title: string, label: string, keyOf: (x: Row) => string, labelOf: (k: string) => string) =>
    listTable(loc, {
      id,
      title,
      columns: [text(label), int("Appointments"), int("Completed"), int("Cancelled"), int("No-shows"), money("Collected")],
      rows: r.map((x) => {
        const k = keyOf(x);
        return {
          shopId: x.shopId,
          key: k,
          cells: [labelOf(k), 1, x.status === "completed" ? 1 : 0, x.status === "cancelled" ? 1 : 0, x.status === "no_show" ? 1 : 0, x.totalCents ?? 0] as Cell[],
        };
      }),
      merge: true,
      sort: (a, b) => Number(b[1]) - Number(a[1]),
    });

  return {
    stats: [
      { label: "Appointments", value: String(r.length), hint: r.length === all.length ? undefined : `of ${all.length} before filters` },
      { label: "Completed", value: String(done), hint: pct(done) },
      { label: "Cancelled / no-show", value: `${cancelled} / ${noShows}`, hint: `${pct(cancelled)} / ${pct(noShows)}`, tone: noShows > 0 ? "down" : undefined },
      { label: "Collected", value: formatCents(collected), hint: `${formatCents(booked)} booked` },
    ],
    options: [
      option("payment", "Payment", f.payment, PAYMENT_FILTERS.map((p) => [p, PAYMENT_LABEL[p]])),
      option("method", "Booking method", f.method, BOOKING_METHODS.map((m) => [m, BOOKING_METHOD_LABEL[m]])),
      option("status", "Status", f.status, APPOINTMENT_STATUSES.map((s) => [s, APPOINTMENT_STATUS_LABEL[s]])),
      option("platform", "Platform", f.platform, PLATFORMS.map((p) => [p, PLATFORM_LABEL[p]])),
    ],
    tables: [
      breakdown("methods", "By booking method", "Booking method", (x) => x.source, (k) => BOOKING_METHOD_LABEL[k as BookingMethod] ?? k),
      breakdown("platforms", "By platform", "Platform", (x) => platformOf(x.source), (k) => PLATFORM_LABEL[k as keyof typeof PLATFORM_LABEL] ?? k),
      breakdown("payments", "By payment", "Payment", (x) => paymentOf(x.methods), (k) => PAYMENT_LABEL[k as keyof typeof PAYMENT_LABEL] ?? k),
      listTable(loc, {
        id: "appointments",
        title: "Appointments",
        subtitle: r.length >= 20000 ? "The first 20,000 appointments; narrow the dates or filters to see the rest." : "Newest first. Clients aren't named here; open the appointment code from the calendar.",
        columns: [text("Date"), text("Time"), text("Barber"), text("Services"), text("Status"), text("Booking method"), text("Platform"), text("Payment"), money("Booked"), money("Collected"), money("Tip"), text("Code")],
        rows: r.map((x) => ({
          shopId: x.shopId,
          cells: [
            x.day,
            x.time,
            staffName(loc, x.staffId),
            x.services,
            APPOINTMENT_STATUS_LABEL[x.status] ?? x.status,
            BOOKING_METHOD_LABEL[x.source] ?? x.source,
            PLATFORM_LABEL[platformOf(x.source)],
            PAYMENT_LABEL[paymentOf(x.methods)],
            x.estimateCents,
            x.totalCents,
            x.tipCents,
            x.code,
          ],
        })),
        keepShop: loc.shops.length > 1,
      }),
    ],
  };
}
