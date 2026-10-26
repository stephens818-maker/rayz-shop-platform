import { and, asc, eq, inArray, isNull, lte, gte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { callIns, morningDashboardSends, notificationJobs, roles, shopClosures, shopHours, shops, staff, staffAccessShops, staffMilestones, staffSchedules, staffShops } from "@/db/schema";
import { todayLine, visibleBadges } from "@/domain/badges";
import { NO_BARBER } from "@/domain/barbers";
import type { FieldKey } from "@/domain/client-privacy";
import {
  BarberSales,
  BarberTime,
  CMP_KEYS,
  ExceptionCategory,
  ExceptionItem,
  ExceptionsBlock,
  LoyaltyBlock,
  MarketingBlock,
  MilestonesBlock,
  MorningDashboard,
  MorningSection,
  MorningSettings,
  Period,
  RebookBlock,
  ReviewsBlock,
  SalesBlock,
  ShopRef,
  TodayBlock,
  TodayShop,
  TrafficBlock,
  UtilizationBlock,
  VersionPlan,
  cmpOf,
  dollars,
  hasContent,
  hoursLabel,
  morningPeriods,
  plural,
  ratioCmp,
  versionPlans,
} from "@/domain/morning-dashboard";
import { recordedSentence, upcomingSentence } from "@/domain/milestones";
import { type RebookCounts, zeroCounts } from "@/domain/rebook";
import { renderMorningHtml, renderMorningPdf, renderMorningSms, renderMorningText } from "@/domain/morning-render";
import { weekStartOf } from "@/domain/payroll/overtime";
import { type Permission, reportView } from "@/domain/permissions";
import { TOTAL, segKey } from "@/domain/report-views";
import { appBaseUrl } from "@/lib/deployment";
import { LocalDate, addDays, endOfLocalDay, formatDate, formatTime, minutesToLabel, startOfLocalDay, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";
import { settingAt, settingFor } from "./brand-sync/settings";
import { StaffAccess, loadStaffAccess } from "./auth/access";
import { loadBadgeSettings } from "./badge-settings";
import { badgeCounts } from "./badges";
import { levelsFor, makePolicy, rulesFor } from "./client-privacy";
import { AppError } from "./errors";
import { attributedSends } from "./marketing/report";
import { loadMarketingSettings } from "./marketing/settings";
import { loadMilestoneSettings, teamAt, upcomingFor } from "./milestones/engine";
import { processDueJobs } from "./notifications/queue";
import { brandShopIds, rebookAt } from "./rebook-report";
import { loadSettings as loadPayrollSettings } from "./payroll/groups";
import { ZERO_SALES, availableMinutesAt, dailyTotals, giftCardTotalsByShop, kpisAt, loyaltyActivity, refundTotals, salesTotalsAt } from "./reports";
import { stockLevels } from "./inventory/stock";
import { morningReportsFor } from "./report-builder/deliver";
import { rows as sqlRows, uuids } from "./report-sql";
import { timedAppointments } from "./service-times-report";
import { staffingFor } from "./staff-time";
import { attendanceRows, ftOverview } from "./time-clock";
import { openChairTime } from "./today";

/** Nothing goes out after noon, so a late deploy doesn't send a stale dashboard. */
const SEND_BY_MIN = 12 * 60;
/** A claim this old that never got queued belongs to a run that died; the next run may take it. */
const STALE_CLAIM_MS = 10 * 60_000;

/** The Morning Dashboard email settings (the digest setting): one for the whole brand. */
export const loadMorningSettings = (): Promise<MorningSettings> => settingAt<MorningSettings>("digest");

/** Shares query results across everyone's dashboards in one run: the same shops and days are asked for again and again. */
export class Memo {
  private m = new Map<string, Promise<unknown>>();
  get<T>(key: string, f: () => Promise<T>): Promise<T> {
    if (!this.m.has(key)) this.m.set(key, f());
    return this.m.get(key) as Promise<T>;
  }
}

// ───────────────────────────── Shop calendars ─────────────────────────────

interface ShopCal {
  id: string;
  name: string;
  status: string;
  hours: Map<number, { openMin: number; closeMin: number }>;
  closures: Map<LocalDate, string>;
}

async function shopCalendars(around: LocalDate): Promise<Map<string, ShopCal>> {
  const [list, hours, closed] = await Promise.all([
    db.select({ id: shops.id, name: shops.name, status: shops.status }).from(shops).orderBy(asc(shops.name)),
    db.select().from(shopHours),
    db
      .select({ shopId: shopClosures.shopId, date: shopClosures.date, reason: shopClosures.reason })
      .from(shopClosures)
      .where(and(gte(shopClosures.date, addDays(around, -14)), lte(shopClosures.date, addDays(around, 7)))),
  ]);
  return new Map(
    list.map((s) => [
      s.id,
      {
        ...s,
        hours: new Map(hours.filter((h) => h.shopId === s.id).map((h) => [h.weekday, { openMin: h.openMin, closeMin: h.closeMin }])),
        closures: new Map(closed.filter((c) => c.shopId === s.id).map((c) => [c.date, c.reason ?? "Closed"])),
      },
    ]),
  );
}

const openOn = (c: ShopCal | undefined, d: LocalDate) => !!c && c.hours.has(weekdayOf(d)) && !c.closures.has(d);
/** Live shops and temporarily closed ones have numbers; shops being set up or archived don't get a dashboard. */
const REPORTING = new Set(["live", "closed"]);

// ───────────────────────────── Recipients ─────────────────────────────

export interface MorningRecipient {
  staffId: string;
  firstName: string;
  label: string;
  role: string;
  email: string | null;
  phone: string | null;
  plans: VersionPlan[];
}

const canAt = (a: StaffAccess, shopId: string, p: Permission) => a.byShop.get(shopId)?.permissions.has(p) ?? false;

/** Their shops (live or temporarily closed) where they may see the Morning Dashboard. */
export const morningShops = (a: StaffAccess) => a.shops.filter((s) => REPORTING.has(s.status) && canAt(a, s.id, reportView("morning_dashboard"))).map((s) => s.id);

/**
 * Active people whose role (main or at one of their shops) is on the list, plus anyone added, less
 * anyone removed, who may see the dashboard for at least one shop, with the versions they get.
 */
export async function morningRecipients(s: MorningSettings): Promise<MorningRecipient[]> {
  const people = await db
    .select({ id: staff.id, firstName: staff.firstName, label: staff.displayLabel, email: staff.email, phone: staff.phone, roleKey: roles.key, roleName: roles.name })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.active, true), eq(staff.kind, "person")))
    .orderBy(asc(staff.displayLabel));
  const shopRoles = await db.select({ staffId: staffAccessShops.staffId, key: roles.key }).from(staffAccessShops).innerJoin(roles, eq(roles.id, staffAccessShops.roleId));
  const out: MorningRecipient[] = [];
  for (const p of people) {
    if (s.exclude.includes(p.id)) continue;
    const byRole = s.roles.includes(p.roleKey ?? "") || shopRoles.some((r) => r.staffId === p.id && s.roles.includes(r.key ?? ""));
    if (!byRole && !s.include.includes(p.id)) continue;
    const access = await loadStaffAccess(p.id);
    if (!access) continue;
    const plans = versionPlans(morningShops(access), s.versions[p.id]);
    if (plans.length) out.push({ staffId: p.id, firstName: p.firstName, label: p.label, role: p.roleName, email: p.email, phone: p.phone, plans });
  }
  return out;
}

// ───────────────────────────── Building one dashboard ─────────────────────────────

interface Ctx {
  access: StaffAccess;
  shops: ShopRef[];
  p: ReturnType<typeof morningPeriods>;
  now: Date;
  memo: Memo;
  cals: Map<string, ShopCal>;
  /** Shops of this version where they have the permission. */
  allowed: (perm: Permission) => ShopRef[];
  label: (staffId: string) => Promise<string>;
}

const RANGES = (p: Ctx["p"]): Record<Period, [LocalDate, LocalDate]> => ({
  day: [p.reportDay, p.reportDay],
  prior: [p.compareDay, p.compareDay],
  wtd: [p.wtdFrom, p.reportDay],
  wtdPrior: [p.wtdPriorFrom, p.wtdPriorTo],
});

async function per<T>(c: Ctx, f: (from: LocalDate, to: LocalDate) => Promise<T>): Promise<Record<Period, T>> {
  const r = RANGES(c.p);
  const out = await Promise.all(CMP_KEYS.map((k) => f(r[k][0], r[k][1])));
  return Object.fromEntries(CMP_KEYS.map((k, i) => [k, out[i]])) as Record<Period, T>;
}

const key = (...xs: unknown[]) => xs.map((x) => (Array.isArray(x) ? x.join(",") : String(x ?? ""))).join("|");
const idsOf = (xs: readonly ShopRef[]) => xs.map((s) => s.id);
const intersect = (a: readonly ShopRef[], b: readonly ShopRef[]) => a.filter((x) => b.some((y) => y.id === x.id));

async function salesBlock(c: Ctx): Promise<SalesBlock | null> {
  const shops = c.allowed(reportView("sales_summary"));
  if (!shops.length) return null;
  const ids = idsOf(shops);
  const grains = shops.length > 1 ? [{}, { byShop: true }] : [{}];
  const t = await per(c, (from, to) => c.memo.get(key("sales", ids, from, to), () => salesTotalsAt({ shopIds: ids, from, to }, grains)));
  const at = (p: Period, k: string) => t[p][k] ?? ZERO_SALES();
  const f = (field: keyof ReturnType<typeof ZERO_SALES>, k = TOTAL) => cmpOf((p) => at(p, k)[field]);

  const voidShops = intersect(shops, c.allowed(reportView("discounts_refunds")));
  const voids = voidShops.length
    ? await per(c, (from, to) => c.memo.get(key("voids", idsOf(voidShops), from, to), () => refundTotals({ shopIds: idsOf(voidShops), from, to }))).then((r) =>
        cmpOf((p) => r[p].filter((x) => x.kind === "void").reduce((a, x) => a + x.amountCents, 0)),
      )
    : null;

  const barberShops = intersect(shops, c.allowed(reportView("sales_by_barber")));
  const ownOnly = barberShops.some((s) => !canAt(c.access, s.id, "reports.all_staff"));
  let byBarber: BarberSales[] | null = null;
  if (barberShops.length) {
    const bIds = idsOf(barberShops);
    const staffIds = ownOnly ? [c.access.staffId] : null;
    const [day, wtd] = await Promise.all(
      [RANGES(c.p).day, RANGES(c.p).wtd].map(([from, to]) => c.memo.get(key("salesStaff", bIds, from, to, staffIds), () => salesTotalsAt({ shopIds: bIds, from, to, staffIds }, [{ byStaff: true }]))),
    );
    const staffKeys = [...new Set([...Object.keys(day), ...Object.keys(wtd)])];
    byBarber = await Promise.all(
      staffKeys.map(async (k) => {
        const staffId = k.split("|")[1];
        const d = day[k] ?? ZERO_SALES();
        return {
          staffId,
          label: staffId === NO_BARBER ? "No barber" : await c.label(staffId),
          net: d.netSalesCents,
          services: d.netServicesCents,
          products: d.netProductsCents,
          tips: d.tipsCents,
          tickets: d.tickets,
          netWtd: (wtd[k] ?? ZERO_SALES()).netSalesCents,
        };
      }),
    );
    byBarber.sort((a, b) => b.net - a.net || b.netWtd - a.netWtd || a.label.localeCompare(b.label));
  }

  const daily = await c.memo.get(key("daily", ids, c.p.wtdPriorFrom, c.p.reportDay), () => dailyTotals({ shopIds: ids, from: c.p.wtdPriorFrom, to: c.p.reportDay }));
  const netOn = (d: LocalDate) => daily.filter((x) => x.day === d).reduce((a, x) => a + x.netCents, 0);
  const days: SalesBlock["daily"] = [];
  for (let d = c.p.wtdFrom; d <= c.p.reportDay; d = addDays(d, 1)) days.push({ date: d, net: netOn(d), prior: netOn(addDays(d, -7)) });

  return {
    shops,
    gross: f("grossSalesCents"),
    net: f("netSalesCents"),
    services: f("netServicesCents"),
    products: f("netProductsCents"),
    tips: f("tipsCents"),
    cardFees: f("cardFeeCents"),
    refunds: f("refundCents"),
    tickets: f("tickets"),
    avgTicket: f("avgTicketCents"),
    voids,
    byShop: shops.length > 1 ? shops.map((s) => ({ shop: s, net: f("netSalesCents", segKey(s.id, null)), tickets: f("tickets", segKey(s.id, null)) })) : [],
    byBarber,
    ownOnly,
    daily: days,
  };
}

async function bookingsMade(ids: string[], from: LocalDate, to: LocalDate) {
  const [r] = await sqlRows<{ total: number; online: number; walk_in: number; desk: number }>(sql`
    select count(*)::int total, count(*) filter (where source in ('online', 'api'))::int online, count(*) filter (where source = 'walk_in')::int walk_in,
      count(*) filter (where source in ('staff', 'rebook'))::int desk
    from appointments where shop_id in ${uuids(ids)} and source <> 'import'
      and created_at >= ${startOfLocalDay(from).toISOString()} and created_at < ${endOfLocalDay(to).toISOString()}`);
  return r ?? { total: 0, online: 0, walk_in: 0, desk: 0 };
}

async function trafficBlock(c: Ctx): Promise<TrafficBlock | null> {
  const shops = c.allowed(reportView("kpis"));
  if (!shops.length) return null;
  const ids = idsOf(shops);
  const [k, b] = await Promise.all([
    per(c, (from, to) => c.memo.get(key("kpis", ids, from, to), () => kpisAt({ shopIds: ids, from, to }, [{}]))),
    per(c, (from, to) => c.memo.get(key("bookings", ids, from, to), () => bookingsMade(ids, from, to))),
  ]);
  const kp = (f: (x: NonNullable<(typeof k)["day"][string]>) => number) => cmpOf((p) => (k[p][TOTAL] ? f(k[p][TOTAL]) : 0));
  return {
    shops,
    newClients: kp((x) => x.newClients),
    returningClients: kp((x) => x.returningClients),
    bookingsMade: cmpOf((p) => b[p].total),
    online: cmpOf((p) => b[p].online),
    walkIns: cmpOf((p) => b[p].walk_in),
    frontDesk: cmpOf((p) => b[p].desk),
    visits: kp((x) => x.appointments),
    cancellations: kp((x) => x.cancellations.n),
    noShows: kp((x) => x.noShows.n),
  };
}

async function utilizationBlock(c: Ctx): Promise<UtilizationBlock | null> {
  const shops = c.allowed(reportView("sales_by_barber"));
  if (!shops.length) return null;
  const ids = idsOf(shops);
  const ownOnly = shops.some((s) => !canAt(c.access, s.id, "reports.all_staff"));
  const staffIds = ownOnly ? [c.access.staffId] : null;
  const grains = ownOnly ? [{}] : [{}, { byStaff: true }];
  const [k, avail] = await Promise.all([
    per(c, (from, to) => c.memo.get(key("kpisStaff", ids, from, to, staffIds), () => kpisAt({ shopIds: ids, from, to, staffIds }, grains))),
    per(c, (from, to) => c.memo.get(key("avail", ids, from, to, staffIds), () => availableMinutesAt({ shopIds: ids, from, to, staffIds }, grains))),
  ]);
  const booked = cmpOf((p) => k[p][TOTAL]?.bookedMinutes ?? 0);
  const available = cmpOf((p) => avail[p][TOTAL] ?? 0);

  const cutShops = intersect(shops, c.allowed(reportView("service_times")));
  const timed = cutShops.length
    ? (await c.memo.get(key("timed", idsOf(cutShops), c.p.reportDay, staffIds), () => timedAppointments({ shopIds: idsOf(cutShops), from: c.p.reportDay, to: c.p.reportDay, staffIds }, c.now))).filter(
        (a) => a.counted && a.actualMin !== null,
      )
    : null;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

  const staffKeys = ownOnly ? [segKey(null, c.access.staffId)] : [...new Set([...Object.keys(k.day), ...Object.keys(avail.day), ...Object.keys(avail.wtd)])].filter((x) => x !== TOTAL && !x.endsWith(`|${NO_BARBER}`));
  const barbers: BarberTime[] = (
    await Promise.all(
      staffKeys.map(async (sk) => {
        const staffId = sk.split("|")[1];
        const kk = ownOnly ? TOTAL : sk;
        const bookedMin = k.day[kk]?.bookedMinutes ?? 0;
        const availableMin = avail.day[kk] ?? 0;
        const bw = k.wtd[kk]?.bookedMinutes ?? 0;
        const aw = avail.wtd[kk] ?? 0;
        const mine = timed?.filter((a) => a.staffId === staffId) ?? [];
        return {
          staffId,
          label: await c.label(staffId),
          bookedMin,
          availableMin,
          utilization: availableMin ? bookedMin / availableMin : null,
          utilizationWtd: aw ? bw / aw : null,
          avgActualMin: timed ? avg(mine.map((a) => a.actualMin!)) : null,
          avgBookedMin: timed ? avg(mine.map((a) => a.bookedMin)) : null,
          timed: mine.length,
        };
      }),
    )
  ).filter((b) => b.availableMin > 0 || b.bookedMin > 0);
  barbers.sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1) || a.label.localeCompare(b.label));
  return {
    shops,
    booked,
    available,
    utilization: ratioCmp(booked, available),
    barbers,
    ownOnly,
    cutTimes: timed ? { avgActualMin: avg(timed.map((a) => a.actualMin!)), avgBookedMin: avg(timed.map((a) => a.bookedMin)), n: timed.length } : null,
  };
}

async function loyaltyBlock(c: Ctx): Promise<LoyaltyBlock | null> {
  const lo = c.allowed(reportView("loyalty"));
  const gc = c.allowed(reportView("gift_cards"));
  if (!lo.length && !gc.length) return null;
  const everyShop = c.access.scope === "all" && [...c.cals.values()].filter((s) => s.status !== "archived").every((s) => lo.some((x) => x.id === s.id));
  const [l, g] = await Promise.all([
    lo.length ? per(c, (from, to) => c.memo.get(key("loyalty", idsOf(lo), from, to, everyShop), () => loyaltyActivity({ shopIds: idsOf(lo), from, to }, everyShop))) : null,
    gc.length ? per(c, (from, to) => c.memo.get(key("gift", idsOf(gc), from, to), () => giftCardTotalsByShop({ shopIds: idsOf(gc), from, to }))) : null,
  ]);
  const gsum = (p: Period, f: (x: Awaited<ReturnType<typeof giftCardTotalsByShop>>[string]) => number) => Object.values(g![p]).reduce((a, x) => a + f(x), 0);
  return {
    loyalty: l
      ? {
          shops: lo,
          rewardsIssued: cmpOf((p) => l[p].rewardsIssued),
          rewardsRedeemed: cmpOf((p) => l[p].rewardsRedeemed),
          redeemedCents: cmpOf((p) => l[p].rewardsRedeemedCents),
          members: cmpOf((p) => l[p].members),
        }
      : null,
    giftCards: g
      ? {
          shops: gc,
          soldN: cmpOf((p) => gsum(p, (x) => x.issuedN)),
          soldCents: cmpOf((p) => gsum(p, (x) => x.issuedCents)),
          redeemedCents: cmpOf((p) => gsum(p, (x) => x.redeemedCents)),
          outstandingCents: gsum("day", (x) => x.outstandingCents),
        }
      : null,
  };
}

async function marketingBlock(c: Ctx): Promise<MarketingBlock | null> {
  const cc = c.allowed(reportView("campaign_center"));
  const op = c.allowed(reportView("openings"));
  const shops = cc.length ? cc : op;
  if (!shops.length) return null;
  const openingsOnly = !cc.length;
  const ids = idsOf(shops);
  const days = await c.memo.get("attributionDays", async () => (await loadMarketingSettings()).attributionDays);
  const r = await per(c, async (from, to) => (await c.memo.get(key("sends", ids, from, to), () => attributedSends({ shopIds: ids, from, to }, days))).filter((x) => !openingsOnly || x.campaign_kind === "openings"));
  const sum = (f: (x: (typeof r)["day"][number]) => number) => cmpOf((p) => r[p].reduce((a, x) => a + Number(f(x) || 0), 0));
  return { shops, openingsOnly, sends: cmpOf((p) => r[p].length), clicks: sum((x) => x.clicks), bookings: sum((x) => x.bookings), redemptions: sum((x) => x.redemptions), revenue: sum((x) => x.revenue) };
}

async function reviewCounts(ids: string[], from: LocalDate, to: LocalDate) {
  const start = startOfLocalDay(from).toISOString();
  const end = endOfLocalDay(to).toISOString();
  return sqlRows<{ shop_id: string; clicks: number; follow_ups: number }>(sql`
    with c as (select shop_id, count(*)::int n from review_clicks where shop_id in ${uuids(ids)} and created_at >= ${start} and created_at < ${end} group by 1),
    f as (select shop_id, count(*)::int n from receipt_deliveries where purpose = 'review' and skipped is null and shop_id in ${uuids(ids)} and created_at >= ${start} and created_at < ${end} group by 1)
    select coalesce(c.shop_id, f.shop_id) shop_id, coalesce(c.n, 0) clicks, coalesce(f.n, 0) follow_ups from c full join f on f.shop_id = c.shop_id`);
}

async function reviewsBlock(c: Ctx): Promise<ReviewsBlock | null> {
  const shops = c.allowed(reportView("google_reviews"));
  if (!shops.length) return null;
  const ids = idsOf(shops);
  const r = await per(c, (from, to) => c.memo.get(key("reviews", ids, from, to), () => reviewCounts(ids, from, to)));
  const of = (shopId: string | null, f: "clicks" | "follow_ups") => cmpOf((p) => r[p].filter((x) => !shopId || x.shop_id === shopId).reduce((a, x) => a + x[f], 0));
  return { shops, clicks: of(null, "clicks"), followUps: of(null, "follow_ups"), byShop: shops.length > 1 ? shops.map((s) => ({ shop: s, clicks: of(s.id, "clicks") })) : [] };
}

const span = (a: number, b: number) => `${minutesToLabel(a)}–${minutesToLabel(b % 1440)}`;

async function todayBlock(c: Ctx): Promise<TodayBlock | null> {
  const shops = c.allowed(reportView("staffing"));
  if (!shops.length) return null;
  const ids = idsOf(shops);
  const today = c.p.today;
  // Open time counts from now on the morning itself, and from opening for any other day.
  const from = todayLocal(c.now) === today ? c.now : startOfLocalDay(today);
  const seesPrivate = c.access.permissions.has("blocks.private");
  const [staffing, chairs, scheds, calls] = await Promise.all([
    c.memo.get(key("staffing", ids, today, seesPrivate ? "p" : ""), () => staffingFor(ids, today, today, { staffId: c.access.staffId, seesPrivate })),
    c.memo.get(key("chairs", ids, from.toISOString()), () => openChairTime(ids, from, 0)),
    db
      .select({ staffId: staffSchedules.staffId, shopId: staffSchedules.shopId, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin })
      .from(staffSchedules)
      .where(and(inArray(staffSchedules.shopId, ids), eq(staffSchedules.weekday, weekdayOf(today)))),
    db
      .select({ staffId: callIns.staffId, shopId: callIns.shopId, kind: callIns.kind, startMin: callIns.startMin, endMin: callIns.endMin, fromDate: callIns.fromDate, toDate: callIns.toDate, label: staff.displayLabel })
      .from(callIns)
      .innerJoin(staff, eq(staff.id, callIns.staffId))
      .where(and(isNull(callIns.cancelledAt), lte(callIns.fromDate, today), gte(callIns.toDate, today), or(isNull(callIns.shopId), inArray(callIns.shopId, ids)))),
  ]);
  const worksAt = calls.length ? await db.select({ staffId: staffShops.staffId, shopId: staffShops.shopId }).from(staffShops).where(inArray(staffShops.staffId, calls.map((x) => x.staffId))) : [];
  const out: TodayShop[] = [];
  for (const s of shops) {
    const cal = c.cals.get(s.id);
    const h = cal?.hours.get(weekdayOf(today));
    const closure = cal?.closures.get(today);
    const open = cal?.status === "live" && !!h && !closure;
    const rows = staffing.filter((r) => r.shopId === s.id);
    const barbers = rows
      .filter((r) => r.status === "working" || r.status === "partly_off")
      .map((r) => {
        const free = chairs.find((x) => x.shopId === s.id && x.staffId === r.staffId)?.free ?? [];
        const openMin = Math.round(free.reduce((a, i) => a + (i.end - i.start), 0) / 60_000);
        const mine = scheds.filter((x) => x.shopId === s.id && x.staffId === r.staffId).sort((a, b) => a.startMin - b.startMin);
        return {
          staffId: r.staffId,
          label: r.label,
          hours: mine.map((x) => span(x.startMin, x.endMin)).join(", ") || hoursLabel(r.scheduledMin),
          partlyOff: r.status === "partly_off",
          booked: r.booked,
          openMin,
          open: free.map((i) => `${formatTime(new Date(i.start))}–${formatTime(new Date(i.end))}`),
        };
      });
    const off = rows
      .filter((r) => r.status === "off" || r.status === "partly_off")
      .map((r) => {
        const blocks = r.blocks.filter((b) => b.category === "time_off");
        const why = [...new Set(blocks.map((b) => b.label))].join(", ");
        const when = r.status === "partly_off" ? blocks.map((b) => span(b.startMin, b.endMin)).join(", ") : "";
        return { label: r.label, why: [why, when].filter(Boolean).join(", ") };
      });
    const here = calls.filter((x) => x.shopId === s.id || (x.shopId === null && worksAt.some((w) => w.staffId === x.staffId && w.shopId === s.id)));
    out.push({
      shop: s,
      open,
      hours: open ? span(h!.openMin, h!.closeMin) : closure ? `Closed today (${closure})` : cal?.status === "closed" ? "Temporarily closed" : "Closed today",
      appointments: rows.reduce((a, r) => a + r.booked, 0),
      barbers,
      off,
      callIns: here.map((x) => ({ label: x.label, kind: x.kind, when: x.startMin !== null && x.endMin !== null && x.fromDate === x.toDate ? span(x.startMin, x.endMin) : "all day" })),
      openMin: barbers.reduce((a, b) => a + b.openMin, 0),
    });
  }
  const clients = await todayClients(c, shops);
  return { date: today, shops: out, ...(clients.length ? { clients } : {}) };
}

const BADGE_FIELDS: FieldKey[] = ["birthday", "preferred_barber", "ratings", "phone", "email"];

/** Today's booked clients counted by the badges this recipient would see in the app, under their role at each of these shops. */
async function todayClients(c: Ctx, shops: ShopRef[]): Promise<NonNullable<TodayBlock["clients"]>> {
  const a = c.access;
  const working = shops.map((s) => {
    const r = a.byShop.get(s.id)?.role ?? a.role;
    return { shopId: s.id, roleId: r.id, roleKey: r.key, brandLevel: !!r.brandLevel };
  });
  const [settings, rules] = await Promise.all([c.memo.get("badgeSettings", () => loadBadgeSettings()), a.isOwner ? [] : rulesFor(a.staffId, [...new Set(working.map((w) => w.roleId))])]);
  const level = makePolicy({ staffId: a.staffId, isOwner: a.isOwner, canReveal: false, custom: [], levels: levelsFor(rules, a.staffId, working, BADGE_FIELDS) }).level;
  const keys = visibleBadges(settings, [], { isOwner: a.isOwner, roles: working.map((w) => ({ id: w.roleId, key: w.roleKey, brandLevel: w.brandLevel })), money: a.permissions.has("clients.view_all"), level });
  if (!keys.length) return [];
  const ids = idsOf(shops);
  const counts = await c.memo.get(key("badgeCounts", ids, c.p.today, keys), () => badgeCounts(ids, c.p.today, keys, { now: c.now }));
  return counts.map((x) => ({ ...x, label: todayLine(x.key, x.count) }));
}

// ───────────────────────────── Exceptions ─────────────────────────────

async function punchExceptions(c: Ctx, shops: ShopRef[]): Promise<ExceptionItem[]> {
  const ids = idsOf(shops);
  const day = c.p.reportDay;
  const rows = await c.memo.get(key("attendance", ids, day), () => attendanceRows(ids, day, day, null, c.now));
  const out: ExceptionItem[] = [];
  for (const r of rows) {
    const shop = shops.find((s) => s.id === r.shopId)?.name ?? null;
    const href = `/admin/reports/attendance?from=${day}&to=${day}&shop=${r.shopId}`;
    const who = await c.label(r.staffId);
    if (r.scheduledNoShow) out.push({ category: "punches", severity: "medium", shop, title: `${who} was scheduled ${formatDate(day, "EEEE")} but never clocked in`, href });
    if (r.missed) out.push({ category: "punches", severity: "medium", shop, title: `${who}: ${plural(r.missed, "missed punch", "missed punches")} ${formatDate(day, "EEEE")}`, detail: "Fix it on their timesheet before payroll.", href: "/admin/timesheets" });
    if (r.forgotOut) out.push({ category: "punches", severity: "medium", shop, title: `${who} didn't clock out ${formatDate(day, "EEEE")}`, href: "/admin/timesheets" });
  }
  return out;
}

async function overtimeExceptions(c: Ctx, shops: ShopRef[]): Promise<ExceptionItem[]> {
  const ids = idsOf(shops);
  const today = c.p.today;
  const weekStart = weekStartOf(today);
  const weekEnd = addDays(weekStart, 6);
  const people = await db
    .selectDistinct({ id: staffShops.staffId, shopId: staffShops.shopId })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(inArray(staffShops.shopId, ids), eq(staff.active, true), eq(staff.kind, "person")));
  const staffIds = [...new Set(people.map((p) => p.id))];
  if (!staffIds.length) return [];
  const settings = await c.memo.get("payrollSettings", () => loadPayrollSettings());
  const [worked, ahead, ft] = await Promise.all([
    c.memo.get(key("workedWeek", staffIds, weekStart, today), () =>
      sqlRows<{ staff_id: string; minutes: number }>(sql`
        select staff_id, coalesce(sum(extract(epoch from least(ends_at, ${startOfLocalDay(today).toISOString()}::timestamptz) - starts_at) / 60), 0)::int minutes
        from time_entries where staff_id in ${uuids(staffIds)} and kind in ('worked', 'training')
          and starts_at >= ${startOfLocalDay(weekStart).toISOString()} and starts_at < ${startOfLocalDay(today).toISOString()}
        group by 1`),
    ),
    c.memo.get(key("weekAhead", ids, today, weekEnd), () => staffingFor(ids, today, weekEnd, { staffId: c.access.staffId, seesPrivate: false }, staffIds)),
    c.memo.get(key("ft", staffIds, today), () => ftOverview(staffIds, today, settings.ftWindowWeeks, settings)),
  ]);
  const out: ExceptionItem[] = [];
  for (const id of staffIds) {
    const so = (worked.find((w) => w.staff_id === id)?.minutes ?? 0) / 60;
    const left = ahead.filter((r) => r.staffId === id).reduce((a, r) => a + Math.max(0, r.scheduledMin - r.offMin), 0) / 60;
    const projected = Math.round((so + left) * 10) / 10;
    const home = people.find((p) => p.id === id)!.shopId;
    const shop = shops.find((s) => s.id === home)?.name ?? null;
    const detail = `${so.toFixed(1)}h worked since ${formatDate(weekStart, "EEEE")} and ${left.toFixed(1)}h still scheduled.`;
    const partTime = ft.rows.find((r) => r.staffId === id)?.status !== "full_time";
    if (projected > settings.otThresholdHours)
      out.push({ category: "overtime", severity: "high", shop, title: `${await c.label(id)} is on track for ${projected}h this week, over ${settings.otThresholdHours}`, detail, href: "/admin/timesheets" });
    else if (partTime && projected > settings.ftHoursPerWeek)
      out.push({ category: "overtime", severity: "medium", shop, title: `${await c.label(id)} (part time) is on track for ${projected}h, over ${settings.ftHoursPerWeek}`, detail, href: "/admin/timesheets" });
  }
  return out;
}

async function stockExceptions(c: Ctx, shops: ShopRef[]): Promise<ExceptionItem[]> {
  const ids = idsOf(shops);
  const rows = (await c.memo.get(key("stock", ids), () => stockLevels(ids))).filter((r) => r.active && r.low);
  return shops.flatMap((s) => {
    const low = rows.filter((r) => r.shopId === s.id);
    if (!low.length) return [];
    const names = low.slice(0, 3).map((r) => r.name);
    return [
      {
        category: "stock" as const,
        severity: low.some((r) => r.available <= 0) ? ("high" as const) : ("medium" as const),
        shop: s.name,
        title: `${plural(low.length, "product")} at or below the reorder point`,
        detail: `${names.join(", ")}${low.length > 3 ? ` and ${low.length - 3} more` : ""}${low.some((r) => r.available <= 0) ? `; ${low.filter((r) => r.available <= 0).length} out of stock` : ""}.`,
        href: `/admin/inventory/low-stock?shop=${s.id}`,
      },
    ];
  });
}

interface PoFacts {
  shop_id: string;
  drafts: number;
  over_limit: number;
  over_limit_cents: number;
  overdue: number;
  open: number;
}

async function poFacts(ids: string[], today: LocalDate) {
  const limitAt = await settingFor<number | null>("po_approval", ids);
  const limits = JSON.stringify(Object.fromEntries(ids.map((id) => [id, limitAt(id)])));
  return sqlRows<PoFacts>(sql`
    with t as (
      select po.id, po.shop_id, po.status, po.expected_on, coalesce((select sum(l.qty_ordered * l.unit_cost_cents) from purchase_order_lines l where l.purchase_order_id = po.id), 0)::int total
      from purchase_orders po where po.shop_id in ${uuids(ids)} and po.status in ('draft', 'approved', 'sent', 'partially_received')
    ), lim as (select key::uuid shop_id, (value #>> '{}')::int t from jsonb_each(${limits}::jsonb))
    select t.shop_id, count(*) filter (where status = 'draft')::int drafts,
      count(*) filter (where status = 'draft' and lim.t is not null and total > lim.t)::int over_limit,
      coalesce(sum(total) filter (where status = 'draft' and lim.t is not null and total > lim.t), 0)::int over_limit_cents,
      count(*) filter (where status <> 'draft' and expected_on < ${today})::int overdue,
      count(*) filter (where status <> 'draft')::int open
    from t left join lim on lim.shop_id = t.shop_id group by 1`);
}

async function purchasingExceptions(c: Ctx, shops: ShopRef[]): Promise<ExceptionItem[]> {
  const facts = await c.memo.get(key("po", idsOf(shops), c.p.today), () => poFacts(idsOf(shops), c.p.today));
  return facts.flatMap((f) => {
    const shop = shops.find((s) => s.id === f.shop_id)?.name ?? null;
    const out: ExceptionItem[] = [];
    if (f.overdue) out.push({ category: "purchasing", severity: "medium", shop, title: `${plural(f.overdue, "purchase order")} past the expected delivery date`, detail: `${f.open} open in all.`, href: "/admin/purchase-orders" });
    if (f.drafts) out.push({ category: "purchasing", severity: "low", shop, title: `${plural(f.drafts, "draft purchase order")} not sent yet`, href: "/admin/purchase-orders" });
    return out;
  });
}

async function tipExceptions(c: Ctx, shops: ShopRef[]): Promise<ExceptionItem[]> {
  const ids = idsOf(shops);
  const rows = await c.memo.get(key("tips", ids), () =>
    sqlRows<{ shop_id: string; pending: number; pending_cents: number; people: number; failed: number }>(sql`
      select shop_id, count(*) filter (where status in ('pending', 'held', 'approved', 'processing'))::int pending,
        coalesce(sum(net_cents) filter (where status in ('pending', 'held', 'approved', 'processing')), 0)::int pending_cents,
        count(distinct staff_id) filter (where status in ('pending', 'held', 'approved', 'processing'))::int people,
        count(*) filter (where status = 'failed')::int failed
      from tip_payouts where shop_id in ${uuids(ids)} group by 1`),
  );
  return rows.flatMap((r) => {
    const shop = shops.find((s) => s.id === r.shop_id)?.name ?? null;
    const out: ExceptionItem[] = [];
    if (r.failed) out.push({ category: "tips", severity: "high", shop, title: `${plural(r.failed, "tip payout")} failed`, detail: "Retry or pay another way.", href: "/admin/tips" });
    if (r.pending) out.push({ category: "tips", severity: "medium", shop, title: `${dollars(r.pending_cents)} in tip payouts pending for ${plural(r.people, "person", "people")}`, href: "/admin/tips" });
    return out;
  });
}

async function approvalExceptions(c: Ctx): Promise<{ items: ExceptionItem[]; any: boolean }> {
  const timeOff = c.shops.filter((s) => canAt(c.access, s.id, "timeoff.approve"));
  const po = c.shops.filter((s) => canAt(c.access, s.id, "po.approve"));
  const blasts = c.access.scope === "all" && c.shops.some((s) => canAt(c.access, s.id, "campaign_center.send")) ? c.shops : [];
  const items: ExceptionItem[] = [];
  if (timeOff.length) {
    const ids = idsOf(timeOff);
    const rows = await sqlRows<{ shop_id: string | null; n: number }>(sql`
      select coalesce(r.shop_id, ss.shop_id) shop_id, count(distinct r.id)::int n from time_off_requests r
      left join staff_shops ss on r.shop_id is null and ss.staff_id = r.staff_id and ss.shop_id in ${uuids(ids)}
      where r.status = 'pending' and r.ends_at > ${c.now.toISOString()} and (r.shop_id in ${uuids(ids)} or (r.shop_id is null and ss.shop_id is not null))
      group by 1`);
    for (const r of rows) items.push({ category: "approvals", severity: "medium", shop: timeOff.find((s) => s.id === r.shop_id)?.name ?? null, title: `${plural(r.n, "time off request")} waiting`, href: "/admin/time-off" });
  }
  if (blasts.length) {
    const rows = await sqlRows<{ shop_id: string; n: number }>(sql`
      select shop_ids->>0 shop_id, count(*)::int n from marketing_campaigns
      where kind = 'openings' and status = 'pending_approval' and shop_ids->>0 in (${sql.join(idsOf(blasts).map((i) => sql`${i}`), sql`, `)}) group by 1`);
    for (const r of rows) items.push({ category: "approvals", severity: "high", shop: blasts.find((s) => s.id === r.shop_id)?.name ?? null, title: `${plural(r.n, "We have openings blast")} waiting for the brand`, detail: "Openings are for today or tomorrow, so these go stale fast.", href: "/admin/campaign-center/openings" });
  }
  if (po.length) {
    const facts = await c.memo.get(key("po", idsOf(po), c.p.today), () => poFacts(idsOf(po), c.p.today));
    for (const f of facts.filter((x) => x.over_limit))
      items.push({ category: "approvals", severity: "medium", shop: po.find((s) => s.id === f.shop_id)?.name ?? null, title: `${plural(f.over_limit, "purchase order")} over the approval limit (${dollars(f.over_limit_cents)})`, href: "/admin/purchase-orders" });
  }
  return { items, any: timeOff.length > 0 || po.length > 0 || blasts.length > 0 };
}

async function payoutExceptions(c: Ctx, shops: ShopRef[]): Promise<ExceptionItem[]> {
  const ids = idsOf(shops);
  const today = c.p.today;
  const rows = await c.memo.get(key("payouts", ids, today, c.p.reportDay), () =>
    sqlRows<{ shop_id: string; status: string; amount_cents: number; arrival_date: string; failure_message: string | null }>(sql`
      select shop_id, status, amount_cents, to_char(arrival_date, 'YYYY-MM-DD') arrival_date, failure_message from shop_payouts
      where shop_id in ${uuids(ids)} and (
        (status = 'failed' and arrival_date >= ${addDays(today, -14)})
        or status in ('pending', 'in_transit')
        or (status = 'paid' and arrival_date between ${c.p.reportDay} and ${today}))
      order by arrival_date`),
  );
  return rows.map((r) => {
    const shop = shops.find((s) => s.id === r.shop_id)?.name ?? null;
    const href = `/admin/reports/shop-accounts?from=${addDays(today, -14)}&to=${today}&shop=${r.shop_id}`;
    if (r.status === "failed") return { category: "payouts" as const, severity: "high" as const, shop, title: `Payout of ${dollars(r.amount_cents)} failed`, detail: r.failure_message ?? "Check the bank account on the shop's Stripe account.", href };
    if (r.status === "paid") return { category: "payouts" as const, severity: "low" as const, shop, title: `${dollars(r.amount_cents)} deposited ${formatDate(r.arrival_date, "EEE MMM d")}`, href };
    return { category: "payouts" as const, severity: "low" as const, shop, title: `${dollars(r.amount_cents)} on the way, arriving ${formatDate(r.arrival_date, "EEE MMM d")}`, href };
  });
}

async function exceptionsBlock(c: Ctx): Promise<ExceptionsBlock | null> {
  const gated: [ExceptionCategory, Permission, (c: Ctx, shops: ShopRef[]) => Promise<ExceptionItem[]>][] = [
    ["punches", reportView("attendance"), punchExceptions],
    ["overtime", reportView("labor"), overtimeExceptions],
    ["stock", reportView("low_stock"), stockExceptions],
    ["purchasing", reportView("purchasing"), purchasingExceptions],
    ["tips", reportView("tip_payouts"), tipExceptions],
    ["payouts", reportView("shop_accounts"), payoutExceptions],
  ];
  const categories: ExceptionCategory[] = [];
  const parts = await Promise.all(
    gated.map(async ([cat, perm, f]) => {
      const shops = c.allowed(perm);
      if (!shops.length) return [];
      categories.push(cat);
      return f(c, shops);
    }),
  );
  const approvals = await approvalExceptions(c);
  if (approvals.any) categories.push("approvals");
  if (!categories.length) return null;
  const order = ["punches", "overtime", "stock", "purchasing", "tips", "approvals", "payouts"];
  return { categories: categories.sort((a, b) => order.indexOf(a) - order.indexOf(b)), items: [...parts.flat(), ...approvals.items] };
}

/** What the people at their shops reached from the day covered through this morning, and what's coming up. Never their own. */
async function milestonesBlock(c: Ctx): Promise<MilestonesBlock | null> {
  const shops = c.allowed("milestones.view");
  if (!shops.length) return null;
  const s = await c.memo.get("milestone-settings", loadMilestoneSettings);
  if (!s.enabled) return null;
  const ids = idsOf(shops);
  const team = (await c.memo.get(key("milestone-team", ids), () => teamAt(ids))).filter((p) => p.id !== c.access.staffId);
  if (!team.length) return null;
  const staffIds = team.map((p) => p.id);
  const label = new Map(team.map((p) => [p.id, p.label]));
  const names = new Map(c.shops.map((x) => [x.id, x.name]));
  const [reached, upcoming] = await Promise.all([
    c.memo.get(key("milestones", staffIds, c.p.reportDay, c.p.today), () =>
      db
        .select()
        .from(staffMilestones)
        .where(
          and(
            inArray(staffMilestones.staffId, staffIds),
            eq(staffMilestones.silent, false),
            gte(staffMilestones.achievedOn, c.p.reportDay),
            lte(staffMilestones.achievedOn, c.p.today),
            s.birthdays ? undefined : sql`${staffMilestones.kind} <> 'birthday'`,
          ),
        )
        .orderBy(sql`${staffMilestones.achievedOn} desc`, asc(staffMilestones.createdAt)),
    ),
    c.memo.get(key("milestones-up", staffIds, c.p.today), () => upcomingFor(team, c.now, s.upcomingDays, s)),
  ]);
  const achieved = reached.map((m) => ({ text: recordedSentence(label.get(m.staffId)!, m), on: m.achievedOn, shop: m.shopId && shops.length > 1 ? (names.get(m.shopId) ?? null) : null }));
  const soon = upcoming.slice(0, 10).map((u) => ({ text: upcomingSentence(label.get(u.staffId)!, u, c.p.today), on: u.on }));
  return achieved.length || soon.length ? { achieved, upcoming: soon } : null;
}

/**
 * Rebooked at checkout on the day and week to date, per barber, against the brand; appointments on
 * the books; and 2nd-visit retention of the new clients whose 60 days have just closed. Without
 * "every barber's numbers" at a shop, it's their own numbers, as in the report.
 */
async function rebookBlock(c: Ctx): Promise<RebookBlock | null> {
  const shops = c.allowed(reportView("rebook_rate"));
  if (!shops.length) return null;
  const ids = idsOf(shops);
  const ownOnly = shops.some((s) => !canAt(c.access, s.id, "reports.all_staff"));
  const staffIds = ownOnly ? [c.access.staffId] : null;
  const f = { serviceId: null, clients: "all" as const, window: 60 as const, now: c.now };
  const visitsOnly = { clients: false, future: false };
  const allIds = await c.memo.get("brand-shops", brandShopIds);
  const whole = !ownOnly && allIds.every((id) => ids.includes(id));
  const r = RANGES(c.p);
  const cohort = { from: addDays(c.p.reportDay, -89), to: addDays(c.p.reportDay, -60) };
  const [t, brandDay, brandWtd, future, second, brandSecond] = await Promise.all([
    per(c, (from, to) => c.memo.get(key("rebook", ids, from, to, staffIds), () => rebookAt({ shopIds: ids, from, to, staffIds }, f, [{}, { byStaff: true }], visitsOnly))),
    whole ? null : c.memo.get(key("rebook-brand", r.day), () => rebookAt({ shopIds: allIds, from: r.day[0], to: r.day[1] }, f, [{}], visitsOnly)),
    whole ? null : c.memo.get(key("rebook-brand", r.wtd), () => rebookAt({ shopIds: allIds, from: r.wtd[0], to: r.wtd[1] }, f, [{}], visitsOnly)),
    c.memo.get(key("rebook-future", ids, staffIds, c.p.today), () => rebookAt({ shopIds: ids, from: c.p.today, to: c.p.today, staffIds }, f, [{}], { clients: false })),
    c.memo.get(key("rebook-2nd", ids, staffIds, cohort.from), () => rebookAt({ shopIds: ids, ...cohort, staffIds }, f, [{}], { future: false })),
    whole ? null : c.memo.get(key("rebook-2nd-brand", cohort.from), () => rebookAt({ shopIds: allIds, ...cohort }, f, [{}], { future: false })),
  ]);
  const at = (p: Period, k = TOTAL) => t[p][k] ?? zeroCounts();
  const rate = (x: RebookCounts) => (x.known ? x.rebooked / x.known : null);
  const newRate = (x: RebookCounts) => (x.newKnown ? x.newRebooked / x.newKnown : 0);
  const staffKeys = [...new Set([...Object.keys(t.day), ...Object.keys(t.wtd)])].filter((k) => k !== TOTAL && !k.endsWith(`|${NO_BARBER}`));
  const byBarber = await Promise.all(
    staffKeys.map(async (k) => {
      const staffId = k.split("|")[1];
      return { staffId, label: await c.label(staffId), visits: at("day", k).known, rate: rate(at("day", k)), wtdVisits: at("wtd", k).known, wtdRate: rate(at("wtd", k)) };
    }),
  );
  byBarber.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.wtdRate ?? -1) - (a.wtdRate ?? -1) || a.label.localeCompare(b.label));
  const s2 = second[TOTAL] ?? zeroCounts();
  const b2 = brandSecond?.[TOTAL];
  return {
    shops,
    visits: cmpOf((p) => at(p).known),
    rebooked: cmpOf((p) => at(p).rebooked),
    rebook: cmpOf((p) => rate(at(p)) ?? 0),
    newRebook: cmpOf((p) => newRate(at(p))),
    brand: whole ? null : { day: rate(brandDay?.[TOTAL] ?? zeroCounts()), wtd: rate(brandWtd?.[TOTAL] ?? zeroCounts()) },
    future: (future[TOTAL] ?? zeroCounts()).future,
    secondVisit: { ...cohort, judged: s2.newJudged, back: s2.newBack, brand: b2 && b2.newJudged ? b2.newBack / b2.newJudged : null },
    byBarber: byBarber.length ? byBarber : null,
    ownOnly,
  };
}

// ───────────────────────────── Assembly ─────────────────────────────

const LOADERS: { [K in MorningSection]: (c: Ctx) => Promise<MorningDashboard[K]> } = {
  sales: salesBlock,
  traffic: trafficBlock,
  utilization: utilizationBlock,
  rebook: rebookBlock,
  loyalty: loyaltyBlock,
  marketing: marketingBlock,
  reviews: reviewsBlock,
  today: todayBlock,
  exceptions: exceptionsBlock,
  milestones: milestonesBlock,
};

export interface BuildInput {
  access: StaffAccess;
  firstName: string;
  /** The shops of this version; only those where they may see the dashboard are used. */
  shopIds: string[];
  now?: Date;
  /** The morning it's for; defaults to today. */
  today?: LocalDate;
  settings?: MorningSettings;
  memo?: Memo;
  /** For the in-app page: every section, whatever the email settings leave out. */
  allSections?: boolean;
  /** Add the custom reports they put in the dashboard: on the page, and on one version a day. */
  savedReports?: boolean;
}

/**
 * One person's dashboard for one version: each section shows only the shops where their reports
 * allow it, and a section they can't see anywhere is left out. Null when they have none of the shops.
 */
export async function buildMorningDashboard(input: BuildInput, cals?: Map<string, ShopCal>): Promise<MorningDashboard | null> {
  const now = input.now ?? new Date();
  const today = input.today ?? todayLocal(now);
  const settings = input.settings ?? (await loadMorningSettings());
  const memo = input.memo ?? new Memo();
  const calendars = cals ?? (await memo.get(key("cals", today), () => shopCalendars(today)));
  const access = input.access;
  const eligible = new Set(morningShops(access));
  const shopRefs = access.shops.filter((s) => input.shopIds.includes(s.id) && eligible.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
  if (!shopRefs.length) return null;
  const p = morningPeriods(today, (d) => shopRefs.some((s) => openOn(calendars.get(s.id), d)), settings.coverLastOpenDay);
  const labels = await memo.get("labels", async () => new Map((await db.select({ id: staff.id, label: staff.displayLabel }).from(staff)).map((s) => [s.id, s.label])));
  const c: Ctx = {
    access,
    shops: shopRefs,
    p,
    now,
    memo,
    cals: calendars,
    allowed: (perm) => shopRefs.filter((s) => canAt(access, s.id, perm)),
    label: async (id) => labels.get(id) ?? "Former staff",
  };
  const reportingShops = [...calendars.values()].filter((s) => REPORTING.has(s.status));
  const label =
    shopRefs.length === 1
      ? shopRefs[0].name
      : access.scope === "all" && reportingShops.every((s) => shopRefs.some((x) => x.id === s.id))
        ? "All locations"
        : shopRefs.length <= 3
          ? shopRefs.map((s) => s.name).join(", ")
          : `${shopRefs.length} locations`;
  const keys = Object.keys(LOADERS) as MorningSection[];
  const [blocks, savedReports] = await Promise.all([
    Promise.all(keys.map((k) => (input.allSections || settings.sections[k] ? LOADERS[k](c) : Promise.resolve(null)))),
    input.savedReports ? morningReportsFor(access.staffId, now) : Promise.resolve(null),
  ]);
  const d = {
    firstName: input.firstName,
    version: { scope: shopRefs.length === 1 ? shopRefs[0].id : "all", label, shops: shopRefs },
    periods: p,
    baseUrl: appBaseUrl(),
    ...Object.fromEntries(keys.map((k, i) => [k, blocks[i]])),
    savedReports,
  } as MorningDashboard;
  return d;
}

/** For the in-app page: the person's dashboard for these shops (or all theirs) on a morning. */
export async function morningDashboardFor(access: StaffAccess, firstName: string, shopIds: string[] | null, today: LocalDate, now = new Date()) {
  const ids = shopIds ?? morningShops(access);
  return buildMorningDashboard({ access, firstName, shopIds: ids, today, now, allSections: true, savedReports: true });
}

// ───────────────────────────── Sending ─────────────────────────────

async function claim(date: LocalDate, staffId: string, scope: string, channel: "email" | "sms", now: Date) {
  const r = await sqlRows<{ ok: number }>(sql`
    insert into morning_dashboard_sends (date, staff_id, scope, channel, status, claimed_at) values (${date}, ${staffId}, ${scope}, ${channel}, 'building', ${now.toISOString()})
    on conflict (date, staff_id, scope, channel) do update set claimed_at = excluded.claimed_at
      where morning_dashboard_sends.status = 'building' and morning_dashboard_sends.claimed_at < ${new Date(now.getTime() - STALE_CLAIM_MS).toISOString()}
    returning 1 ok`);
  return r.length > 0;
}

const sendRow = (date: LocalDate, staffId: string, scope: string, channel: "email" | "sms") =>
  and(eq(morningDashboardSends.date, date), eq(morningDashboardSends.staffId, staffId), eq(morningDashboardSends.scope, scope), eq(morningDashboardSends.channel, channel));

export interface Rendered {
  subject: string;
  body: string;
  html: string;
  pdf: Uint8Array | null;
  sms: string;
}

export function renderAll(d: MorningDashboard, o: { pdf: boolean }): Rendered {
  const t = renderMorningText(d);
  return { subject: t.subject, body: t.body, html: renderMorningHtml(d), pdf: o.pdf ? renderMorningPdf(d) : null, sms: renderMorningSms(d) };
}

const pdfAttachment = (d: MorningDashboard, pdf: Uint8Array) => ({
  filename: `morning-dashboard-${d.periods.today}${d.version.scope === "all" ? "" : `-${d.version.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}.pdf`,
  contentType: "application/pdf",
  content: Buffer.from(pdf).toString("base64"),
});

/** Whether any live shop opens on this day. */
function anyShopOpen(cals: Map<string, ShopCal>, day: LocalDate) {
  return [...cals.values()].some((c) => c.status === "live" && openOn(c, day));
}

/**
 * Run every minute by cron (and by the notifications cron as a fallback). Once it's past the send
 * time and before noon, builds and queues each recipient's versions that haven't gone out today,
 * then sends them. Each person, version and channel is claimed first, so overlapping or repeated
 * runs never send twice; a claim left by a run that died is taken over after ten minutes.
 */
export async function sendDueMorningDashboards(now: Date = new Date()) {
  const s = await loadMorningSettings();
  const none = { queued: 0, skipped: 0 };
  if (!s.enabled) return none;
  const today = todayLocal(now);
  if (now.getTime() < zonedWallTime(today, s.sendAtMin).toMillis() || now.getTime() > zonedWallTime(today, SEND_BY_MIN).toMillis()) return none;
  const memo = new Memo();
  const cals = await memo.get(key("cals", today), () => shopCalendars(today));
  if (s.skipClosedDays && !anyShopOpen(cals, today)) return none;
  const people = await morningRecipients(s);
  if (!people.length) return none;
  const done = await db
    .select({ staffId: morningDashboardSends.staffId, scope: morningDashboardSends.scope, channel: morningDashboardSends.channel })
    .from(morningDashboardSends)
    .where(and(eq(morningDashboardSends.date, today), inArray(morningDashboardSends.status, ["queued", "skipped"])));
  const isDone = (staffId: string, scope: string, channel: string) => done.some((x) => x.staffId === staffId && x.scope === scope && x.channel === channel);

  const jobIds: string[] = [];
  let skipped = 0;
  for (const person of people) {
    const access = await loadStaffAccess(person.staffId);
    if (!access) continue;
    // One text a day per person, for their broadest version.
    const smsScope = s.sms && person.phone ? person.plans[0].scope : null;
    for (const plan of person.plans) {
      const wantEmail = !!person.email && !isDone(person.staffId, plan.scope, "email");
      const wantSms = smsScope === plan.scope && !isDone(person.staffId, plan.scope, "sms");
      if (!wantEmail && !wantSms) continue;
      const email = wantEmail && (await claim(today, person.staffId, plan.scope, "email", now));
      const sms = wantSms && (await claim(today, person.staffId, plan.scope, "sms", now));
      if (!email && !sms) continue;
      const d = await buildMorningDashboard({ access, firstName: person.firstName, shopIds: plan.shopIds, now, today, settings: s, memo, savedReports: plan === person.plans[0] }, cals);
      const channels = [...(email ? (["email"] as const) : []), ...(sms ? (["sms"] as const) : [])];
      if (!d || !hasContent(d)) {
        for (const ch of channels) await db.update(morningDashboardSends).set({ status: "skipped" }).where(sendRow(today, person.staffId, plan.scope, ch));
        skipped += channels.length;
        continue;
      }
      const r = renderAll(d, { pdf: s.pdf && email });
      await db.transaction(async (tx) => {
        if (email) {
          const [job] = await tx
            .insert(notificationJobs)
            .values({ kind: "digest", channel: "email", to: person.email!, subject: r.subject, body: r.body, htmlBody: r.html, attachments: r.pdf ? [pdfAttachment(d, r.pdf)] : null, runAt: now })
            .returning({ id: notificationJobs.id });
          await tx.update(morningDashboardSends).set({ status: "queued", jobId: job.id, reportDate: d.periods.reportDay }).where(sendRow(today, person.staffId, plan.scope, "email"));
          jobIds.push(job.id);
        }
        if (sms) {
          const [job] = await tx.insert(notificationJobs).values({ kind: "digest", channel: "sms", to: person.phone!, body: r.sms, runAt: now }).returning({ id: notificationJobs.id });
          await tx.update(morningDashboardSends).set({ status: "queued", jobId: job.id, reportDate: d.periods.reportDay }).where(sendRow(today, person.staffId, plan.scope, "sms"));
          jobIds.push(job.id);
        }
      });
    }
  }
  if (jobIds.length) await processDueJobs({ ids: jobIds, now });
  return { queued: jobIds.length, skipped };
}

/** Emails this person each of their versions now, whatever the schedule says, marked as a test. */
export async function sendTestMorningDashboard(staffId: string, now: Date = new Date()) {
  const s = await loadMorningSettings();
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { firstName: true, email: true, phone: true } });
  const access = await loadStaffAccess(staffId);
  if (!person || !access) throw new AppError("not_found", "Staff member not found");
  if (!person.email) throw new AppError("bad_request", "Add an email address to your profile first");
  const plans = versionPlans(morningShops(access), s.versions[staffId]);
  if (!plans.length) throw new AppError("conflict", "You can't see the Morning Dashboard for any open shop, so there's nothing to send");
  const memo = new Memo();
  const ids: string[] = [];
  for (const plan of plans) {
    const d = await buildMorningDashboard({ access, firstName: person.firstName, shopIds: plan.shopIds, now, settings: s, memo, savedReports: plan === plans[0] });
    if (!d || !hasContent(d)) continue;
    const r = renderAll(d, { pdf: s.pdf });
    const [job] = await db
      .insert(notificationJobs)
      .values({ kind: "digest", channel: "email", to: person.email, subject: `[Test] ${r.subject}`, body: r.body, htmlBody: r.html, attachments: r.pdf ? [pdfAttachment(d, r.pdf)] : null, runAt: now })
      .returning({ id: notificationJobs.id });
    ids.push(job.id);
    if (s.sms && person.phone && plan === plans[0]) {
      const [t] = await db.insert(notificationJobs).values({ kind: "digest", channel: "sms", to: person.phone, body: `[Test] ${r.sms}`, runAt: now }).returning({ id: notificationJobs.id });
      ids.push(t.id);
    }
  }
  if (!ids.length) throw new AppError("conflict", "None of the sections you can see are turned on, so there's nothing to send");
  await processDueJobs({ ids, now });
  return { to: person.email, versions: plans.length };
}
