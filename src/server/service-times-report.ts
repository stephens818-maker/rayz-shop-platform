import { and, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { services, shopServices, staffServiceDurations } from "@/db/schema";
import { Cell, Column, ColumnKind, Metric, ReportTable, TOTAL, ViewCtx, metricTable, segKey, staffName } from "@/domain/report-views";
import {
  DurationSuggestion,
  FINISHED_VIA_LABEL,
  FLAG_LABEL,
  FinishedVia,
  ON_TIME_TOLERANCE_MIN,
  OUTLIER_OVER_FACTOR,
  REVIEW_LABEL,
  Sample,
  TimingFlag,
  TimingReview,
  TimingSummary,
  WAIT_MAX_MIN,
  actualMinutes,
  counts,
  formatDelta,
  formatMinutes,
  suggestDuration,
  summarize,
  timingFlags,
  waitMinutes,
} from "@/domain/service-times";
import { resolveDuration } from "@/domain/timing";
import { LocalDate, addDays, diffDays, endOfLocalDay, formatDate, formatTime, localDateOf, startOfLocalDay, weekdayOf } from "@/lib/time";
import type { ReportData, ReportStat } from "./report-data";
import { ReportScope, staffSelection } from "./reports";

/**
 * The service times report: actual time in the chair per barber, service and shop against the
 * booked time, with medians, sample sizes, wait times, a weekly trend, flagged times and
 * suggested booked durations. Averages and medians don't add up, so each grain is worked out from
 * its own appointments rather than from the grains under it.
 */

interface Row {
  id: string;
  code: string;
  shop_id: string;
  staff_id: string;
  status: string;
  starts_at: Date | string;
  booked_min: number;
  service_id: string | null;
  services: string | null;
  addons: number;
  arrived_at: Date | string | null;
  started_at: Date | string | null;
  started_by: string | null;
  finished_at: Date | string | null;
  finished_by: string | null;
  finished_via: FinishedVia | null;
  checked_out_at: Date | string | null;
  review: TimingReview | null;
  corrected_at: Date | string | null;
}

export interface TimedAppointment {
  id: string;
  code: string;
  shopId: string;
  staffId: string;
  status: string;
  date: LocalDate;
  startsAt: Date;
  bookedMin: number;
  serviceId: string | null;
  service: string;
  addons: number;
  arrivedAt: Date | null;
  startedAt: Date | null;
  startedBy: string | null;
  finishedAt: Date | null;
  finishedBy: string | null;
  finishedVia: FinishedVia | null;
  checkedOutAt: Date | null;
  review: TimingReview | null;
  corrected: boolean;
  actualMin: number | null;
  waitMin: number | null;
  flags: TimingFlag[];
  counted: boolean;
}

const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const at = (x: Date | string | null) => (x === null ? null : new Date(x));

/** Every appointment in range that wasn't cancelled or a no-show, with whatever times were recorded. */
export async function timedAppointments(s: ReportScope, now = new Date()): Promise<TimedAppointment[]> {
  const sel = staffSelection(s);
  const rows = (await db.execute(sql`
    select a.id, a.code, a.shop_id, a.staff_id, a.status, a.starts_at,
      round(extract(epoch from (a.ends_at - a.starts_at)) / 60)::int booked_min,
      (select i.service_id from appointment_items i where i.appointment_id = a.id and i.kind = 'service' order by i.name limit 1) service_id,
      (select string_agg(i.name, ' + ' order by i.kind = 'addon', i.name) from appointment_items i where i.appointment_id = a.id) services,
      (select count(*) from appointment_items i where i.appointment_id = a.id and i.kind = 'addon')::int addons,
      t.arrived_at, t.started_at, sb.display_label started_by, t.finished_at, fb.display_label finished_by, t.finished_via,
      t.checked_out_at, t.review, t.corrected_at
    from appointments a
    left join appointment_times t on t.appointment_id = a.id
    left join staff sb on sb.id = t.started_by
    left join staff fb on fb.id = t.finished_by
    where a.shop_id in ${uuids(s.shopIds)}
      and a.starts_at >= ${startOfLocalDay(s.from).toISOString()} and a.starts_at < ${endOfLocalDay(s.to).toISOString()}
      and a.status not in ('cancelled', 'no_show')
      ${sel ? sql`and a.staff_id in ${uuids(sel)}` : sql``}
      -- Barbers whose time isn't tracked (their "Track time" booking option, this shop then all shops) are left out.
      and coalesce(
        (select (ss.booking_options->>'trackTime')::boolean from staff_shops ss where ss.staff_id = a.staff_id and ss.shop_id = a.shop_id),
        (select (st.booking_options->>'trackTime')::boolean from staff st where st.id = a.staff_id),
        true)
    order by a.starts_at`)) as unknown as Row[];
  return rows.map((r) => {
    const t = { bookedMin: r.booked_min, arrivedAt: at(r.arrived_at), startedAt: at(r.started_at), finishedAt: at(r.finished_at), review: r.review };
    const startsAt = new Date(r.starts_at);
    return {
      id: r.id,
      code: r.code,
      shopId: r.shop_id,
      staffId: r.staff_id,
      status: r.status,
      date: localDateOf(startsAt),
      startsAt,
      bookedMin: r.booked_min,
      serviceId: r.service_id,
      service: r.services ?? "No service",
      addons: r.addons,
      arrivedAt: t.arrivedAt,
      startedAt: t.startedAt,
      startedBy: r.started_by,
      finishedAt: t.finishedAt,
      finishedBy: r.finished_by,
      finishedVia: r.finished_via,
      checkedOutAt: at(r.checked_out_at),
      review: r.review,
      corrected: r.corrected_at !== null,
      actualMin: actualMinutes(t),
      waitMin: waitMinutes(t),
      flags: timingFlags(t, now),
      counted: counts(t, now),
    };
  });
}

const sampleOf = (a: TimedAppointment): Sample => ({ actualMin: a.actualMin!, bookedMin: a.bookedMin, waitMin: a.waitMin });

interface Group {
  summary: TimingSummary;
  /** Started and finished but not counted: flagged, or left out by a manager. */
  leftOut: number;
  /** Checked out without a start and a finish. */
  notTimed: number;
}

function groupOf(list: TimedAppointment[]): Group {
  return {
    summary: summarize(list.filter((a) => a.counted).map(sampleOf)),
    leftOut: list.filter((a) => a.actualMin !== null && !a.counted).length,
    notTimed: list.filter((a) => a.status === "completed" && a.actualMin === null).length,
  };
}

function groupBy(list: TimedAppointment[], key: (a: TimedAppointment) => string | string[]): Map<string, TimedAppointment[]> {
  const out = new Map<string, TimedAppointment[]>();
  for (const a of list) for (const k of [key(a)].flat()) out.set(k, [...(out.get(k) ?? []), a]);
  return out;
}

const STAT_COLUMNS: Column[] = [
  { label: "Counted", kind: "int" },
  { label: "Avg actual (min)", kind: "minutes" },
  { label: "Median actual (min)", kind: "minutes" },
  { label: "Avg booked (min)", kind: "minutes" },
  { label: "Avg vs booked (min)", kind: "minutes_delta" },
  { label: "On time", kind: "pct" },
  { label: "Ran over", kind: "pct" },
  { label: "Ran under", kind: "pct" },
  { label: "Avg wait (min)", kind: "minutes" },
  { label: "Median wait (min)", kind: "minutes" },
  { label: "Left out", kind: "int" },
];
const statCells = (g: Group): Cell[] => [
  g.summary.n,
  g.summary.avgMin,
  g.summary.medianMin,
  g.summary.avgBookedMin,
  g.summary.avgVarianceMin,
  g.summary.onTime,
  g.summary.over,
  g.summary.under,
  g.summary.avgWaitMin,
  g.summary.medianWaitMin,
  g.leftOut,
];

/** Monday of the week a date falls in. */
export const weekOf = (d: LocalDate) => addDays(d, -((weekdayOf(d) + 6) % 7));

export interface SuggestionRow {
  staffId: string;
  barber: string;
  shopId: string;
  shop: string;
  serviceId: string;
  service: string;
  stepMin: number;
  suggestion: DurationSuggestion;
}

/**
 * Per barber, per shop, per service: counted appointments of that service alone (no add-ons, so
 * the booked time is the service's), against what the barber's next booking of it would hold.
 */
export async function durationSuggestions(list: TimedAppointment[], loc: Pick<ViewCtx, "shops" | "barbers" | "staffNames">): Promise<SuggestionRow[]> {
  const plain = list.filter((a) => a.counted && a.serviceId && a.addons === 0);
  if (!plain.length) return [];
  const serviceIds = [...new Set(plain.map((a) => a.serviceId!))];
  const staffIds = [...new Set(plain.map((a) => a.staffId))];
  const shopIds = [...new Set(plain.map((a) => a.shopId))];
  const [svc, menu, own] = await Promise.all([
    db.select({ id: services.id, name: services.name, durationMin: services.defaultDurationMin, stepMin: services.durationStepMin }).from(services).where(inArray(services.id, serviceIds)),
    db.select().from(shopServices).where(and(inArray(shopServices.shopId, shopIds), inArray(shopServices.serviceId, serviceIds))),
    db.select().from(staffServiceDurations).where(and(inArray(staffServiceDurations.staffId, staffIds), inArray(staffServiceDurations.serviceId, serviceIds))),
  ]);
  const svcById = new Map(svc.map((s) => [s.id, s]));
  const out: SuggestionRow[] = [];
  for (const [k, group] of groupBy(plain, (a) => `${a.staffId}|${a.shopId}|${a.serviceId}`)) {
    const [staffId, shopId, serviceId] = k.split("|");
    const s = svcById.get(serviceId);
    if (!s) continue;
    const m = menu.find((x) => x.shopId === shopId && x.serviceId === serviceId);
    const mine = own.filter((x) => x.staffId === staffId && x.serviceId === serviceId);
    const current = resolveDuration({
      service: s.durationMin,
      shop: m?.durationMin,
      barber: mine.find((x) => x.shopId === null)?.durationMin,
      barberAtShop: mine.find((x) => x.shopId === shopId)?.durationMin,
    }).minutes;
    const suggestion = suggestDuration({ currentMin: current, actualMin: group.map((a) => a.actualMin!), stepMin: s.stepMin });
    if (!suggestion) continue;
    out.push({
      staffId,
      barber: staffName(loc as ViewCtx, staffId),
      shopId,
      shop: loc.shops.find((x) => x.id === shopId)?.name ?? "Unknown",
      serviceId,
      service: m?.nameOverride ?? s.name,
      stepMin: s.stepMin,
      suggestion,
    });
  }
  return out.sort((a, b) => Math.abs(b.suggestion.avgMin - b.suggestion.currentMin) - Math.abs(a.suggestion.avgMin - a.suggestion.currentMin));
}

const flagText = (a: TimedAppointment) =>
  [...a.flags.map((f) => FLAG_LABEL[f]), ...(a.review ? [REVIEW_LABEL[a.review]] : [])].join("; ") || (a.startedAt && !a.finishedAt ? "Timer running" : "");

export async function serviceTimesData(scope: ReportScope, loc: ViewCtx, now = new Date()): Promise<ReportData & { suggestions: SuggestionRow[] }> {
  const list = await timedAppointments(scope, now);
  const shopName = (id: string) => loc.shops.find((s) => s.id === id)?.name ?? "Unknown";
  const barber = (id: string) => staffName(loc, id);

  const byKey = groupBy(list, (a) => [TOTAL, segKey(a.shopId, null), segKey(null, a.staffId), segKey(a.shopId, a.staffId)]);
  const groups = new Map([...byKey].map(([k, v]) => [k, groupOf(v)]));
  const total = groups.get(TOTAL) ?? groupOf([]);
  const metric = (label: string, kind: ColumnKind, f: (g: Group) => number | null): Metric => ({
    label,
    kind,
    additive: false,
    at: { ...Object.fromEntries([...groups].map(([k, g]) => [k, f(g)])), [TOTAL]: f(total) },
  });

  const summary = metricTable(loc, {
    id: "summary",
    title: "Actual service time",
    subtitle: "Start to finish, against the booked time. Flagged times are left out.",
    metrics: [
      metric("Counted services", "int", (g) => g.summary.n),
      metric("Avg actual (min)", "minutes", (g) => g.summary.avgMin),
      metric("Median actual (min)", "minutes", (g) => g.summary.medianMin),
      metric("Avg booked (min)", "minutes", (g) => g.summary.avgBookedMin),
      metric("Avg vs booked (min)", "minutes_delta", (g) => g.summary.avgVarianceMin),
      metric("Median vs booked (min)", "minutes_delta", (g) => g.summary.medianVarianceMin),
      metric("Finished on time", "pct", (g) => g.summary.onTime),
      metric("Ran over", "pct", (g) => g.summary.over),
      metric("Ran under", "pct", (g) => g.summary.under),
      metric("Avg wait (min)", "minutes", (g) => g.summary.avgWaitMin),
      metric("Median wait (min)", "minutes", (g) => g.summary.medianWaitMin),
      metric("Waits measured", "int", (g) => g.summary.waitN),
      metric("Left out (flagged)", "int", (g) => g.leftOut),
      metric("Checked out, not timed", "int", (g) => g.notTimed),
    ],
  });

  const totalRow = (label: string, lead: number) => [label, ...Array(lead - 1).fill(null), ...statCells(total)];
  const byService = [...groupBy(list, (a) => a.service)].map(([name, g]) => ({ name, g: groupOf(g) })).filter((x) => x.g.summary.n + x.g.leftOut > 0);
  byService.sort((a, b) => b.g.summary.n - a.g.summary.n || a.name.localeCompare(b.name));
  const servicesTable: ReportTable = {
    id: "services",
    title: "By service",
    subtitle: "Add-ons booked with a service are their own row, since the booked time includes them.",
    columns: [{ label: "Service" }, ...STAT_COLUMNS],
    rows: [...byService.map((x) => [x.name, ...statCells(x.g)]), ...(byService.length ? [totalRow("All services", 1)] : [])],
    rowStyles: [...byService.map(() => undefined), ...(byService.length ? (["total"] as const) : [])],
  };

  const oneBarber = new Set(list.map((a) => a.staffId)).size <= 1;
  const pairs = [...groupBy(list, (a) => `${a.staffId}|${a.service}`)]
    .map(([k, g]) => ({ staffId: k.split("|")[0], name: g[0].service, g: groupOf(g) }))
    .filter((x) => x.g.summary.n + x.g.leftOut > 0)
    .sort((a, b) => barber(a.staffId).localeCompare(barber(b.staffId)) || b.g.summary.n - a.g.summary.n);
  const barberServices: ReportTable = {
    id: "barber_services",
    title: "By barber and service",
    columns: [{ label: "Barber" }, { label: "Service" }, ...STAT_COLUMNS],
    rows: pairs.map((x) => [barber(x.staffId), x.name, ...statCells(x.g)]),
  };

  const weekly = diffDays(scope.to, scope.from) >= 14;
  const bucket = (d: LocalDate) => (weekly ? weekOf(d) : d);
  const trendRows = [...groupBy(list, (a) => bucket(a.date))].sort(([a], [b]) => a.localeCompare(b)).map(([d, g]) => ({ d, g: groupOf(g) }));
  const trend: ReportTable = {
    id: "trend",
    title: weekly ? "Trend by week" : "Trend by day",
    subtitle: weekly ? "Weeks start on Monday." : undefined,
    columns: [{ label: weekly ? "Week of" : "Date" }, ...STAT_COLUMNS],
    rows: trendRows.map((x) => [x.d, ...statCells(x.g)]),
  };

  const suggestions = await durationSuggestions(list, loc);
  const suggestionsTable: ReportTable = {
    id: "suggestions",
    title: "Suggested booked times",
    columns: [
      { label: "Barber" },
      { label: "Location" },
      { label: "Service" },
      { label: "Booked now (min)", kind: "int", sum: false },
      { label: "Counted", kind: "int", sum: false },
      { label: "Avg actual (min)", kind: "minutes" },
      { label: "Median actual (min)", kind: "minutes" },
      { label: "Same side", kind: "pct" },
      { label: "Suggested (min)", kind: "int", sum: false },
    ],
    rows: suggestions.map((x) => [x.barber, x.shop, x.service, x.suggestion.currentMin, x.suggestion.n, x.suggestion.avgMin, x.suggestion.medianMin, x.suggestion.consistency, x.suggestion.minutes]),
  };

  const flaggedList = list.filter((a) => a.flags.length || a.review);
  const flagged: ReportTable = {
    id: "flagged",
    title: "Flagged and reviewed times",
    subtitle: "Flagged times are left out of averages unless a manager counts them. Open the appointment on the calendar to correct it.",
    columns: [
      { label: "Date" },
      { label: "Location" },
      { label: "Barber" },
      { label: "Service" },
      { label: "Code" },
      { label: "Booked (min)", kind: "int", sum: false },
      { label: "Actual (min)", kind: "minutes" },
      { label: "Why" },
      { label: "Counted", kind: "bool" },
    ],
    rows: flaggedList.map((a) => [a.date, shopName(a.shopId), barber(a.staffId), a.service, a.code, a.bookedMin, a.actualMin, flagText(a), a.counted]),
  };

  const stamp = (d: Date | null) => (d ? formatTime(d) : null);
  const times: ReportTable = {
    id: "times",
    title: "Every appointment's times",
    exportOnly: true,
    columns: [
      { label: "Date" },
      { label: "Location" },
      { label: "Barber" },
      { label: "Service" },
      { label: "Code" },
      { label: "Status" },
      { label: "Booked start" },
      { label: "Booked (min)", kind: "int", sum: false },
      { label: "Arrived" },
      { label: "Started" },
      { label: "Started by" },
      { label: "Finished" },
      { label: "Finished by" },
      { label: "How it finished" },
      { label: "Checked out" },
      { label: "Actual (min)", kind: "minutes" },
      { label: "Wait (min)", kind: "minutes" },
      { label: "Flags" },
      { label: "Counted", kind: "bool" },
      { label: "Corrected", kind: "bool" },
    ],
    rows: list.map((a) => [
      a.date,
      shopName(a.shopId),
      barber(a.staffId),
      a.service,
      a.code,
      a.status,
      formatTime(a.startsAt),
      a.bookedMin,
      stamp(a.arrivedAt),
      stamp(a.startedAt),
      a.startedBy,
      stamp(a.finishedAt),
      a.finishedBy,
      a.finishedVia ? FINISHED_VIA_LABEL[a.finishedVia] : null,
      stamp(a.checkedOutAt),
      a.actualMin,
      a.waitMin,
      flagText(a),
      a.counted,
      a.corrected,
    ]),
  };

  const s = total.summary;
  const timed = s.n + total.leftOut;
  const stats: ReportStat[] = [
    { label: "Avg actual service", value: formatMinutes(s.avgMin), hint: `Median ${formatMinutes(s.medianMin)} · ${s.n} counted` },
    {
      label: "Vs booked",
      value: formatDelta(s.avgVarianceMin),
      hint: s.n ? `${Math.round((s.onTime ?? 0) * 100)}% on time · ${Math.round((s.over ?? 0) * 100)}% over · ${Math.round((s.under ?? 0) * 100)}% under` : undefined,
      tone: s.avgVarianceMin === null ? undefined : s.avgVarianceMin > 0 ? "down" : "up",
    },
    { label: "Avg wait", value: formatMinutes(s.avgWaitMin), hint: `Arrival to start · median ${formatMinutes(s.medianWaitMin)} · ${s.waitN} measured` },
    {
      label: "Timed",
      value: timed + total.notTimed ? `${Math.round((timed / (timed + total.notTimed)) * 100)}%` : "—",
      hint: `${total.leftOut} left out as flagged · ${total.notTimed} checked out without a timer`,
    },
  ];

  return {
    stats,
    tables: [summary, servicesTable, ...(oneBarber ? [] : [barberServices]), trend, suggestionsTable, flagged, times],
    suggestions,
    notes: [
      `On time is within ${ON_TIME_TOLERANCE_MIN} minutes of the booked time. Times over ${OUTLIER_OVER_FACTOR}× the booked time, under a quarter of it, or with a timer left running are flagged and left out unless a manager counts them.`,
      `When Finish wasn't tapped, checkout stands in for the end of the service. Waits over ${WAIT_MAX_MIN / 60} hours (arrival to start) are left out of wait times.`,
      `Booked times are each appointment's own service time as booked, without prep or cleanup buffers. Dates are the appointment's day, ${formatDate(scope.from, "MMM d")} to ${formatDate(scope.to, "MMM d")}.`,
    ],
  };
}
