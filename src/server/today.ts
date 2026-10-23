import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  alertDismissals,
  appointments,
  cashDrawers,
  clientAccessAlerts,
  clientNudges,
  customers,
  notificationJobs,
  purchaseOrders,
  refunds,
  sales,
  shopPaymentAccounts,
  shopPayouts,
  shops,
  staff,
  staffSchedules,
  timeBlocks,
  vendors,
  waitlistEntries,
} from "@/db/schema";
import type { PaymentsMode, ShopStatus } from "@/db/schema";
import { takesCards } from "@/domain/connect";
import type { ReasonViewer } from "@/domain/block-reasons";
import { closedOn } from "@/domain/location-lifecycle";
import { type Permission, reportView } from "@/domain/permissions";
import { payPeriodFor } from "@/domain/payroll";
import { FT_LABEL } from "@/domain/time-clock";
import { callInHref } from "@/domain/clock-live";
import {
  Alert,
  DRAWER_VARIANCE_CENTS,
  IDLE_ALERT_MIN,
  Interval,
  PACE,
  UNUSUAL,
  durationLabel,
  freeIntervals,
  minutesIn,
  noShowRisk,
  paceChange,
  pctLabel,
  sortAlerts,
} from "@/domain/today";
import { formatCents } from "@/lib/money";
import { LocalDate, addDays, endOfLocalDay, formatDate, formatTime, localDateOf, localMinutesOf, startOfLocalDay, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";
import { type StaffContext, reasonViewer, reportShopIds } from "./auth/staff";
import { ACTIVE_STATUSES } from "./booking";
import { flaggedCount } from "./call-ins";
import { clockFallout, liveClock } from "./clock-live";
import { suggestionsFor } from "./inventory/purchasing";
import { locationSetup } from "./location-setup";
import { unreadCount } from "./messaging";
import { fillCandidates, marketingConsent, rebookCandidates } from "./outreach-campaigns";
import { listRequests } from "./staff-time";
import { clockAlertFacts } from "./time-clock";

/** Who is looking: their open shops in scope and what they may do. Alerts never cover anything else. */
export interface TodayViewer {
  staffId: string;
  shopIds: string[];
  permissions: ReadonlySet<Permission>;
  brandWide: boolean;
  reasons: ReasonViewer;
}

type ShopRow = { id: string; name: string; status: ShopStatus; closedUntil: string | null; taxRatesVerified: boolean; slug: string; paymentsMode: PaymentsMode };

const NONE = ["00000000-0000-0000-0000-000000000000"];
const ids = (xs: readonly string[]) => (xs.length ? [...xs] : NONE);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function todayAlerts(v: TodayViewer, now: Date = new Date()): Promise<Alert[]> {
  const has = (p: Permission) => v.permissions.has(p);
  const today = todayLocal(now);
  const shopRows: ShopRow[] = v.shopIds.length
    ? await db
        .select({ id: shops.id, name: shops.name, status: shops.status, closedUntil: shops.closedUntil, taxRatesVerified: shops.taxRatesVerified, slug: shops.slug, paymentsMode: shops.paymentsMode })
        .from(shops)
        .where(and(inArray(shops.id, v.shopIds), ne(shops.status, "archived")))
        .orderBy(asc(shops.name))
    : [];
  const scope = shopRows.map((s) => s.id);
  if (!scope.length) return [];
  const name = (id: string | null) => shopRows.find((s) => s.id === id)?.name ?? null;
  const open = shopRows.filter((s) => (s.status === "live" || s.status === "setup") && !closedOn(s, today));
  const ctx: Ctx = { v, has, now, today, shops: shopRows, open, name };

  const parts = await Promise.all([
    has("calendar.manage") ? chairAlerts(ctx) : [],
    has("po.create") ? stockAlerts(ctx) : [],
    has("timeoff.approve") ? timeOffAlerts(ctx) : [],
    has("callins.outreach") ? callInAlerts(ctx) : [],
    has("clients.campaigns") ? rebookAlerts(ctx) : [],
    has("drawer.manage") || has(reportView("cash_drawer")) ? drawerAlerts(ctx) : [],
    has(reportView("discounts_refunds")) ? unusualSalesAlerts(ctx) : [],
    has("clients.privacy") ? lookupAlerts(ctx) : [],
    has("settings.taxes") || has("locations.setup") || has("payments.accounts") ? setupAlerts(ctx) : [],
    has("sales.view") ? paceAlerts(ctx) : [],
    has("notifications.view") ? notificationAlerts(ctx) : [],
    has("checkout.any") ? openTicketAlerts(ctx) : [],
    has("inbox.view") ? inboxAlerts(ctx) : [],
    has("timesheet.edit") || has("timesheet.approve") || has("payroll.run") ? clockAlerts(ctx) : [],
    has("calendar.manage") || has("timesheet.edit") ? liveClockAlerts(ctx) : [],
  ]);
  const all = parts.flat();
  const keys = all.map((a) => a.key);
  const dismissed = new Set(
    (await db.select({ k: alertDismissals.alertKey }).from(alertDismissals).where(and(inArray(alertDismissals.alertKey, keys.length ? keys : ["-"]), gt(alertDismissals.until, now)))).map((d) => d.k),
  );
  return sortAlerts(all.filter((a) => !dismissed.has(a.key)));
}

interface Ctx {
  v: TodayViewer;
  has: (p: Permission) => boolean;
  now: Date;
  today: LocalDate;
  shops: ShopRow[];
  open: ShopRow[];
  name: (id: string | null) => string | null;
}

// ───────────────────────────── Chairs: gaps, running behind, no-show risk, booked with someone off ─────────────────────────────

export interface ChairFacts {
  shopId: string;
  staffId: string;
  label: string;
  free: Interval[];
}

/** Each barber working today at these shops, with their open stretches left after `now`. */
export async function openChairTime(shopIds: readonly string[], now: Date, minFree = IDLE_ALERT_MIN): Promise<ChairFacts[]> {
  const today = todayLocal(now);
  const wd = weekdayOf(today);
  const ds = startOfLocalDay(today);
  const de = endOfLocalDay(today);
  const scheds = await db
    .select({ staffId: staffSchedules.staffId, shopId: staffSchedules.shopId, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin, label: staff.displayLabel })
    .from(staffSchedules)
    .innerJoin(staff, eq(staff.id, staffSchedules.staffId))
    .where(and(inArray(staffSchedules.shopId, ids(shopIds)), eq(staffSchedules.weekday, wd), eq(staff.active, true), eq(staff.isBookable, true)));
  const staffIds = [...new Set(scheds.map((s) => s.staffId))];
  if (!staffIds.length) return [];
  const [appts, blocks] = await Promise.all([
    db
      .select({ staffId: appointments.staffId, startsAt: appointments.startsAt, endsAt: appointments.endsAt })
      .from(appointments)
      .where(and(inArray(appointments.staffId, staffIds), inArray(appointments.status, [...ACTIVE_STATUSES, "completed"]), lt(appointments.startsAt, de), gt(appointments.endsAt, ds))),
    db
      .select({ staffId: timeBlocks.staffId, shopId: timeBlocks.shopId, startsAt: timeBlocks.startsAt, endsAt: timeBlocks.endsAt })
      .from(timeBlocks)
      .where(and(inArray(timeBlocks.staffId, staffIds), lt(timeBlocks.startsAt, de), gt(timeBlocks.endsAt, ds))),
  ]);
  const from = Math.ceil(now.getTime() / 300_000) * 300_000;
  const out: ChairFacts[] = [];
  const pairs = new Map<string, typeof scheds>();
  for (const s of scheds) pairs.set(`${s.shopId}|${s.staffId}`, [...(pairs.get(`${s.shopId}|${s.staffId}`) ?? []), s]);
  // A break or an early clock-out isn't open chair time; an early clock-in is.
  const shopRows = await db.select({ id: shops.id, timeClock: shops.timeClock }).from(shops).where(inArray(shops.id, [...new Set(scheds.map((s) => s.shopId))]));
  const clocks = new Map(
    await Promise.all(shopRows.map(async (s) => [s.id, (await liveClock(s, today, [...new Set(scheds.filter((x) => x.shopId === s.id).map((x) => x.staffId))], now)).days] as const)),
  );
  for (const rows of pairs.values()) {
    const { shopId, staffId, label } = rows[0];
    const clock = clocks.get(shopId)?.get(staffId);
    const windows = rows.map((r) => ({ start: zonedWallTime(today, r.startMin).toMillis(), end: zonedWallTime(today, r.endMin).toMillis() }));
    if (clock?.early) windows.push({ start: clock.early.start.getTime(), end: clock.early.end.getTime() });
    const busy = [
      ...appts.filter((a) => a.staffId === staffId).map((a) => ({ start: a.startsAt.getTime(), end: a.endsAt.getTime() })),
      ...blocks.filter((b) => b.staffId === staffId && (!b.shopId || b.shopId === shopId)).map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })),
      ...(clock?.holds ?? []).map((h) => ({ start: h.start.getTime(), end: h.end.getTime() })),
    ];
    const free = freeIntervals(windows, busy, from);
    if (minutesIn(free) >= minFree) out.push({ shopId, staffId, label, free });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const span = (i: Interval) => `${formatTime(new Date(i.start))}–${formatTime(new Date(i.end))}`;

async function chairAlerts(c: Ctx): Promise<Alert[]> {
  const live = c.open.filter((s) => s.status === "live");
  const liveIds = live.map((s) => s.id);
  if (!liveIds.length) return [];
  const out: Alert[] = [];
  const ds = startOfLocalDay(c.today);
  const de = endOfLocalDay(c.today);
  const [chairs, consent, waiting, todays] = await Promise.all([
    openChairTime(liveIds, c.now),
    marketingConsent(),
    c.has("walkins.manage")
      ? db
          .select({ shopId: waitlistEntries.shopId, n: sql<number>`count(*)::int` })
          .from(waitlistEntries)
          .where(and(inArray(waitlistEntries.shopId, liveIds), eq(waitlistEntries.status, "waiting")))
          .groupBy(waitlistEntries.shopId)
      : Promise.resolve([]),
    db
      .select({
        id: appointments.id,
        code: appointments.code,
        shopId: appointments.shopId,
        staffId: appointments.staffId,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        status: appointments.status,
        customerId: appointments.customerId,
        first: customers.firstName,
        barber: staff.displayLabel,
      })
      .from(appointments)
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(and(inArray(appointments.shopId, liveIds), inArray(appointments.status, [...ACTIVE_STATUSES]), gte(appointments.startsAt, ds), lt(appointments.startsAt, de)))
      .orderBy(asc(appointments.startsAt)),
  ]);

  for (const s of live) {
    const here = chairs.filter((x) => x.shopId === s.id);
    if (!here.length) continue;
    const total = here.reduce((a, x) => a + minutesIn(x.free), 0);
    const candidates = c.has("clients.campaigns") ? await fillCandidates(s.id, c.now) : [];
    const textable = candidates.filter((x) => x.canText).length;
    const late = c.now.getTime() > zonedWallTime(c.today, 19 * 60).toMillis();
    out.push({
      key: `idle_chairs:${s.id}:${c.today}`,
      type: "idle_chairs",
      severity: total >= 180 ? "medium" : "low",
      shopId: s.id,
      shop: s.name,
      title: `${durationLabel(total)} of open chair time left today`,
      detail:
        candidates.length === 0
          ? "No clients are due for a cut right now."
          : textable
            ? `${plural(textable, "client")} due for a cut agreed to marketing texts.`
            : consent.sms
              ? `${plural(candidates.length, "client")} due for a cut, but none agreed to marketing texts. Call them through the shop line.`
              : `${plural(candidates.length, "client")} due for a cut. Marketing-text consent isn't collected yet, so call them through the shop line.`,
      items: here.map((x) => ({ label: x.label, sub: `${durationLabel(minutesIn(x.free))} open: ${x.free.map(span).join(", ")}` })),
      href: `/admin/calendar?shop=${s.id}`,
      linkLabel: "Calendar",
      action:
        textable && !late
          ? {
              kind: "fill",
              label: `Text ${plural(textable, "client")} due for a cut`,
              confirm: `Sends the "Open chair today" text to ${plural(textable, "client")} at ${s.name} who are due for a cut, agreed to marketing texts and haven't had one this week.`,
              payload: { shopId: s.id },
            }
          : undefined,
    });
    const w = waiting.find((x) => x.shopId === s.id)?.n ?? 0;
    if (w)
      out.push({
        key: `waitlist_match:${s.id}:${c.today}`,
        type: "waitlist_match",
        severity: "medium",
        shopId: s.id,
        shop: s.name,
        title: `${plural(w, "client")} on the waitlist while chairs are open`,
        detail: `${here.map((x) => x.label).join(", ")} ${here.length === 1 ? "has" : "have"} open time now.`,
        href: "/admin/walk-ins",
        linkLabel: "Walk-ins",
      });
  }

  // Running behind: someone who should have started isn't, or a service is running past its end.
  const behind = new Map<string, { label: string; shopId: string; delay: number; next: typeof todays }>();
  for (const a of todays) {
    const startLate = a.status === "checked_in" ? c.now.getTime() - a.startsAt.getTime() : 0;
    const overrun = a.status === "in_service" ? c.now.getTime() - a.endsAt.getTime() : 0;
    const delay = Math.round(Math.max(startLate, overrun) / 60_000);
    if (delay < 15) continue;
    const k = `${a.shopId}|${a.staffId}`;
    if ((behind.get(k)?.delay ?? 0) < delay) behind.set(k, { label: a.barber, shopId: a.shopId, delay, next: [] });
  }
  for (const [k, b] of behind) {
    const [, staffId] = k.split("|");
    b.next = todays.filter((a) => a.staffId === staffId && a.startsAt > c.now && a.startsAt.getTime() < c.now.getTime() + 3 * 3_600_000 && (a.status === "booked" || a.status === "confirmed"));
    const told = b.next.length
      ? new Set(
          (
            await db
              .select({ id: clientNudges.appointmentId })
              .from(clientNudges)
              .where(and(inArray(clientNudges.appointmentId, b.next.map((a) => a.id)), eq(clientNudges.kind, "running_late")))
          ).map((r) => r.id),
        )
      : new Set();
    const toTell = b.next.filter((a) => !told.has(a.id));
    out.push({
      key: `running_behind:${k}:${c.today}`,
      type: "running_behind",
      severity: b.delay >= 30 ? "high" : "medium",
      shopId: b.shopId,
      shop: c.name(b.shopId),
      title: `${b.label} is about ${durationLabel(b.delay)} behind`,
      detail: b.next.length ? `${plural(b.next.length, "client")} booked with ${b.label} in the next 3 hours.` : "Nobody else booked with them in the next 3 hours.",
      items: b.next.map((a) => ({ label: `${formatTime(a.startsAt)} ${a.first ?? "Walk-in"}`, sub: a.code })),
      href: `/admin/calendar?shop=${b.shopId}`,
      linkLabel: "Calendar",
      action: toTell.length
        ? {
            kind: "running_late",
            label: `Tell ${plural(toTell.length, "client")} they can come later`,
            confirm: `Texts or emails ${b.label}'s next ${plural(toTell.length, "client")} (those who get appointment messages) that ${b.label} is running about ${durationLabel(b.delay)} behind.`,
            payload: { appointmentIds: toTell.map((a) => a.id), delayMin: b.delay },
          }
        : undefined,
    });
  }

  // No-show risk among clients still to come today.
  const upcoming = todays.filter((a) => a.customerId && a.startsAt.getTime() > c.now.getTime() + 30 * 60_000 && (a.status === "booked" || a.status === "confirmed"));
  if (upcoming.length) {
    const custIds = [...new Set(upcoming.map((a) => a.customerId!))];
    const hist = await db
      .select({
        customerId: appointments.customerId,
        noShows: sql<number>`count(*) filter (where ${appointments.status} = 'no_show')::int`,
        lateCancels: sql<number>`count(*) filter (where ${appointments.status} = 'cancelled' and ${appointments.cancelledAt} > ${appointments.startsAt} - interval '2 hours')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(appointments)
      .where(and(inArray(appointments.customerId, custIds), gte(appointments.startsAt, new Date(c.now.getTime() - 365 * 86_400_000)), lt(appointments.startsAt, ds)))
      .groupBy(appointments.customerId);
    const reminded = new Set(
      (
        await db
          .select({ id: clientNudges.appointmentId })
          .from(clientNudges)
          .where(and(inArray(clientNudges.appointmentId, upcoming.map((a) => a.id)), eq(clientNudges.kind, "no_show_reminder")))
      ).map((r) => r.id),
    );
    for (const s of live) {
      const risky = upcoming
        .filter((a) => a.shopId === s.id)
        .map((a) => {
          const h = hist.find((x) => x.customerId === a.customerId);
          return { a, h, risk: h ? noShowRisk(h) : null };
        })
        .filter((x) => x.risk);
      if (!risky.length) continue;
      const toRemind = risky.filter((x) => !reminded.has(x.a.id));
      out.push({
        key: `no_show_risk:${s.id}:${c.today}`,
        type: "no_show_risk",
        severity: risky.some((x) => x.risk === "high") ? "medium" : "low",
        shopId: s.id,
        shop: s.name,
        title: `${plural(risky.length, "client")} today with a history of no-shows`,
        detail: toRemind.length ? "An extra reminder an hour or two ahead cuts no-shows." : "All of them have had an extra reminder.",
        items: risky.map(({ a, h }) => ({
          label: `${formatTime(a.startsAt)} ${a.first ?? ""} with ${a.barber}`,
          sub: `${plural(h!.noShows, "no-show")}${h!.lateCancels ? `, ${plural(h!.lateCancels, "late cancel")}` : ""} in the last year${reminded.has(a.id) ? " · reminded" : ""}`,
          href: `/admin/calendar?appt=${a.id}`,
        })),
        action: toRemind.length
          ? {
              kind: "no_show_reminder",
              label: `Send ${plural(toRemind.length, "extra reminder")}`,
              confirm: `Sends the "Extra reminder" message now to ${plural(toRemind.length, "client")}, on the channels they get appointment messages on.`,
              payload: { appointmentIds: toRemind.map((x) => x.a.id) },
            }
          : undefined,
      });
    }
  }

  // Booked with a barber who is off (approved time off or a call-in) and not moved yet.
  if (c.has("timeoff.approve") && todays.length) {
    const offBlocks = await db
      .select({ staffId: timeBlocks.staffId, shopId: timeBlocks.shopId, startsAt: timeBlocks.startsAt, endsAt: timeBlocks.endsAt })
      .from(timeBlocks)
      .where(
        and(
          inArray(timeBlocks.staffId, [...new Set(todays.map((a) => a.staffId))]),
          or(eq(timeBlocks.category, "time_off"), eq(timeBlocks.kind, "day_off")),
          lt(timeBlocks.startsAt, de),
          gt(timeBlocks.endsAt, ds),
        ),
      );
    const stuck = todays.filter((a) => a.startsAt > c.now && offBlocks.some((b) => b.staffId === a.staffId && (!b.shopId || b.shopId === a.shopId) && b.startsAt < a.endsAt && b.endsAt > a.startsAt));
    for (const s of live) {
      const mine = stuck.filter((a) => a.shopId === s.id);
      if (!mine.length) continue;
      out.push({
        key: `off_but_booked:${s.id}:${c.today}`,
        type: "off_but_booked",
        severity: "high",
        shopId: s.id,
        shop: s.name,
        title: `${plural(mine.length, "appointment")} today with a barber who's off`,
        detail: "Move them to another barber or ask the clients to pick a new time.",
        items: mine.map((a) => ({ label: `${formatTime(a.startsAt)} ${a.first ?? "Walk-in"} with ${a.barber}`, sub: a.code, href: `/admin/calendar?appt=${a.id}` })),
        href: "/admin/time-off",
        linkLabel: "Time off",
      });
    }
  }
  return out;
}

// ───────────────────────────── Stock ─────────────────────────────

async function stockAlerts(c: Ctx): Promise<Alert[]> {
  const shopIds = c.open.map((s) => s.id);
  const [suggested, drafts, late] = await Promise.all([
    suggestionsFor(shopIds),
    db
      .select({ id: purchaseOrders.id, number: purchaseOrders.number, shopId: purchaseOrders.shopId, status: purchaseOrders.status, vendor: vendors.name })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(inArray(purchaseOrders.shopId, ids(shopIds)), inArray(purchaseOrders.status, ["draft", "approved"])))
      .orderBy(asc(purchaseOrders.number)),
    db
      .select({ id: purchaseOrders.id, number: purchaseOrders.number, shopId: purchaseOrders.shopId, expectedOn: purchaseOrders.expectedOn, vendor: vendors.name })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(inArray(purchaseOrders.shopId, ids(shopIds)), inArray(purchaseOrders.status, ["sent", "partially_received"]), isNotNull(purchaseOrders.expectedOn), lt(purchaseOrders.expectedOn, c.today))),
  ]);
  const out: Alert[] = [];
  for (const s of suggested) {
    const lines = s.orders.flatMap((o) => o.lines);
    if (!lines.length && !s.noVendor.length) continue;
    out.push({
      key: `low_stock:${s.shopId}:${c.today}`,
      type: "low_stock",
      severity: lines.some((l) => l.position.onHand <= 0) ? "medium" : "low",
      shopId: s.shopId,
      shop: s.shop,
      title: `${plural(lines.length + s.noVendor.length, "product")} at or below the reorder point`,
      detail: s.orders.length
        ? `Suggested: ${s.orders.map((o) => `${o.vendorName} ${formatCents(o.totalCents)}${o.belowMinimum ? " (under minimum)" : ""}`).join(", ")}.${s.noVendor.length ? ` ${plural(s.noVendor.length, "product")} ha${s.noVendor.length === 1 ? "s" : "ve"} no vendor.` : ""}`
        : "None of them has a vendor yet.",
      items: [...lines.slice(0, 8).map((l) => ({ label: l.name, sub: `${l.position.onHand} on hand, order ${l.qty}` })), ...s.noVendor.slice(0, 3).map((l) => ({ label: l.name, sub: "no vendor" }))],
      href: "/admin/inventory/low-stock",
      linkLabel: "Low stock",
      action: s.orders.length
        ? {
            kind: "draft_po",
            label: s.orders.length === 1 ? "Draft the purchase order" : `Draft ${s.orders.length} purchase orders`,
            confirm: `Creates draft orders filled with the suggested quantities for ${s.shop}. Nothing is sent until you review and send them.`,
            payload: { shopId: s.shopId, vendorIds: s.orders.map((o) => o.vendorId) },
          }
        : undefined,
    });
  }
  for (const shopId of [...new Set(drafts.map((d) => d.shopId))]) {
    const mine = drafts.filter((d) => d.shopId === shopId);
    out.push({
      key: `draft_pos:${shopId}:${c.today}:${mine.map((d) => d.number).join(",")}`,
      type: "draft_pos",
      severity: "low",
      shopId,
      shop: c.name(shopId),
      title: `${plural(mine.length, "purchase order")} ready to review and send`,
      detail: "Drafts don't reach the vendor until someone sends them.",
      items: mine.map((d) => ({ label: `PO ${d.number} · ${d.vendor}`, sub: d.status === "approved" ? "approved" : "draft", href: `/admin/purchase-orders/${d.id}` })),
      href: "/admin/purchase-orders",
      linkLabel: "Purchase orders",
    });
  }
  for (const shopId of [...new Set(late.map((d) => d.shopId))]) {
    const mine = late.filter((d) => d.shopId === shopId);
    out.push({
      key: `overdue_deliveries:${shopId}:${c.today}`,
      type: "overdue_deliveries",
      severity: "low",
      shopId,
      shop: c.name(shopId),
      title: `${plural(mine.length, "order")} past the expected delivery date`,
      detail: "Chase the vendor, or receive what arrived.",
      items: mine.map((d) => ({ label: `PO ${d.number} · ${d.vendor}`, sub: `expected ${formatDate(d.expectedOn!)}`, href: `/admin/purchase-orders/${d.id}` })),
    });
  }
  return out;
}

// ───────────────────────────── Team ─────────────────────────────

async function timeOffAlerts(c: Ctx): Promise<Alert[]> {
  const pending = await listRequests({ shopIds: c.shops.map((s) => s.id), brandWide: false }, { viewer: c.v.reasons, statuses: ["pending"], limit: 50 });
  if (!pending.length) return [];
  const soon = pending.filter((r) => r.fromDate <= addDays(c.today, 7));
  return [
    {
      key: `time_off_pending:all:${c.today}:${pending.length}`,
      type: "time_off_pending",
      severity: soon.length ? "medium" : "low",
      shopId: null,
      shop: null,
      title: `${plural(pending.length, "time off request")} waiting for a decision`,
      detail: soon.length ? `${soon.length} start${soon.length === 1 ? "s" : ""} within a week.` : "None start this week.",
      items: pending.slice(0, 6).map((r) => ({ label: `${r.staffLabel}: ${r.range}`, sub: r.reason.label })),
      href: "/admin/time-off",
      linkLabel: "Review",
    },
  ];
}

async function clockAlerts(c: Ctx): Promise<Alert[]> {
  const { forgotten, ftChanges } = await clockAlertFacts(c.shops.map((s) => s.id), c.now);
  const out: Alert[] = [];
  if (forgotten.length && c.has("timesheet.edit")) {
    out.push({
      key: `forgot_clock_out:all:${c.today}:${forgotten.length}`,
      type: "forgot_clock_out",
      severity: "high",
      shopId: null,
      shop: null,
      title: `${plural(forgotten.length, "shift")} never clocked out`,
      detail: "Those shifts count no hours until a clock-out is added on the timesheet, with a reason.",
      items: forgotten.slice(0, 8).map((f) => ({ label: `${f.label}: in at ${formatTime(f.at)} ${formatDate(f.at)}`, sub: c.name(f.shopId) ?? undefined, href: `/admin/timesheets/${f.staffId}?period=${payPeriodFor(localDateOf(f.at)).start}` })),
      href: "/admin/timesheets",
      linkLabel: "Timesheets",
    });
  }
  if (ftChanges.length && (c.has("timesheet.approve") || c.has("payroll.run"))) {
    out.push({
      key: `ft_change:all:${c.today}:${ftChanges.length}`,
      type: "ft_change",
      severity: "medium",
      shopId: null,
      shop: null,
      title: `${plural(ftChanges.length, "person", "people")} crossed the full-time line`,
      detail: "Their rolling average weekly hours moved across the full-time threshold this week.",
      items: ftChanges.map((f) => ({ label: `${f.label}: now ${FT_LABEL[f.to].toLowerCase()}`, sub: `${Number(f.average).toFixed(2)} h/week over ${f.windowWeeks} weeks` })),
      href: "/admin/timesheets",
      linkLabel: "See hours",
    });
  }
  return out;
}

/** From the time clock, live: barbers not clocked in for their first client, and clients booked over a break or after an early clock-out. */
async function liveClockAlerts(c: Ctx): Promise<Alert[]> {
  const live = c.open.filter((s) => s.status === "live").map((s) => s.id);
  const out: Alert[] = [];
  for (const f of await clockFallout(live, c.now)) {
    if (f.late.length)
      out.push({
        key: `late_clock_in:${f.shopId}:${c.today}:${f.late.map((l) => l.staffId).join(",")}`,
        type: "late_clock_in",
        severity: f.late.some((l) => l.minutesToGo <= 0) ? "high" : "medium",
        shopId: f.shopId,
        shop: f.shop,
        title: f.late.length === 1 ? `${f.late[0].label} isn't clocked in for their first client` : `${plural(f.late.length, "barber")} not clocked in for their first client`,
        detail: "Check they're on the way, or move their first clients.",
        items: f.late.map((l) => ({
          label: `${l.label}: ${l.appt.first ?? "Walk-in"} at ${formatTime(l.appt.startsAt)}`,
          sub: l.minutesToGo > 0 ? `in ${durationLabel(l.minutesToGo)}` : l.minutesToGo === 0 ? "now" : `${durationLabel(-l.minutesToGo)} ago`,
          href: `/admin/calendar?shop=${f.shopId}&appt=${l.appt.id}`,
        })),
        href: `/admin/calendar?shop=${f.shopId}`,
        linkLabel: "Calendar",
      });
    for (const a of f.affected) {
      const what = a.why === "break" ? `${a.label} is on a break` : `${a.label} clocked out early`;
      out.push({
        key: `clock_affected:${f.shopId}:${a.staffId}:${c.today}:${a.start.getTime()}`,
        type: "clock_affected",
        severity: "high",
        shopId: f.shopId,
        shop: f.shop,
        title: `${what}: ${plural(a.appts.length, "client")} booked in that time`,
        detail:
          a.why === "break"
            ? `Online booking is held until ${formatTime(a.end)}. Move ${a.appts.length === 1 ? "this client" : "these clients"} or ask them to pick a new time.`
            : "Online booking is closed for the rest of the day. Move these clients to another barber or ask them to pick a new time.",
        items: a.appts.map((x) => ({ label: `${formatTime(x.startsAt)} ${x.first ?? "Walk-in"}`, sub: x.code, href: `/admin/calendar?shop=${f.shopId}&appt=${x.id}` })),
        ...(c.has("callins.mark")
          ? { href: callInHref(a.staffId, f.shopId, { why: a.why, startMin: localMinutesOf(a.start), endMin: localDateOf(a.end) > c.today ? 24 * 60 : localMinutesOf(a.end) }), linkLabel: "Reassign or rebook" }
          : { href: `/admin/calendar?shop=${f.shopId}`, linkLabel: "Calendar" }),
      });
    }
  }
  return out;
}

async function callInAlerts(c: Ctx): Promise<Alert[]> {
  const n = await flaggedCount(c.shops.map((s) => s.id));
  if (!n) return [];
  return [
    {
      key: `callin_fallout:all:${c.today}:${n}`,
      type: "callin_fallout",
      severity: "high",
      shopId: null,
      shop: null,
      title: `${plural(n, "client")} from a call-in still need${n === 1 ? "s" : ""} a call`,
      detail: "Outreach couldn't reach them or got no answer.",
      href: "/admin/call-ins",
      linkLabel: "Call-ins",
    },
  ];
}

async function rebookAlerts(c: Ctx): Promise<Alert[]> {
  const out: Alert[] = [];
  const late = c.now.getTime() > zonedWallTime(c.today, 19 * 60).toMillis();
  for (const s of c.shops.filter((x) => x.status === "live")) {
    const due = await rebookCandidates(s.id, c.now);
    if (due.length < 1) continue;
    const textable = due.filter((d) => d.canText).length;
    out.push({
      key: `overdue_rebook:${s.id}:${c.today}`,
      type: "overdue_rebook",
      severity: "low",
      shopId: s.id,
      shop: s.name,
      title: `${plural(due.length, "regular")} overdue to rebook`,
      detail: textable ? `${textable} agreed to marketing texts.` : "None has agreed to marketing texts, so reach them by phone.",
      items: due.slice(0, 6).map((d) => ({ label: d.firstName, sub: `usually every ${d.usualDays} days, last in ${d.sinceDays} days ago`, href: `/admin/customers/${d.customerId}` })),
      action:
        textable && !late
          ? {
              kind: "rebook",
              label: `Text ${plural(textable, "regular")}`,
              confirm: `Sends the "Due to rebook" text to ${plural(textable, "regular")} at ${s.name} who agreed to marketing texts and haven't had one this week.`,
              payload: { shopId: s.id },
            }
          : undefined,
    });
  }
  return out;
}

// ───────────────────────────── Money ─────────────────────────────

async function drawerAlerts(c: Ctx): Promise<Alert[]> {
  const shopIds = c.shops.map((s) => s.id);
  const since = addDays(c.today, -2);
  const [variances, open] = await Promise.all([
    db
      .select({ shopId: cashDrawers.shopId, date: cashDrawers.businessDate, variance: cashDrawers.varianceCents, notes: cashDrawers.notes })
      .from(cashDrawers)
      .where(and(inArray(cashDrawers.shopId, shopIds), gte(cashDrawers.businessDate, since), isNotNull(cashDrawers.closedAt), sql`abs(${cashDrawers.varianceCents}) >= ${DRAWER_VARIANCE_CENTS}`)),
    db
      .select({ shopId: cashDrawers.shopId, date: cashDrawers.businessDate })
      .from(cashDrawers)
      .where(and(inArray(cashDrawers.shopId, shopIds), lt(cashDrawers.businessDate, c.today), isNull(cashDrawers.closedAt))),
  ]);
  return [
    ...variances.map(
      (d): Alert => ({
        key: `drawer_variance:${d.shopId}:${d.date}`,
        type: "drawer_variance",
        severity: Math.abs(d.variance ?? 0) >= 2000 ? "high" : "medium",
        shopId: d.shopId,
        shop: c.name(d.shopId),
        title: `Drawer ${d.variance! > 0 ? "over" : "short"} ${formatCents(Math.abs(d.variance!))} on ${formatDate(d.date)}`,
        detail: d.notes ? `Note: ${d.notes}` : "No note was left when it was closed.",
        href: `/admin/drawer`,
        linkLabel: "Drawer",
      }),
    ),
    ...open.map(
      (d): Alert => ({
        key: `drawer_open:${d.shopId}:${d.date}`,
        type: "drawer_open",
        severity: "medium",
        shopId: d.shopId,
        shop: c.name(d.shopId),
        title: `Drawer from ${formatDate(d.date)} was never closed`,
        detail: "Count it and close it so the day's cash is accounted for.",
        href: `/admin/drawer`,
        linkLabel: "Drawer",
      }),
    ),
  ];
}

async function unusualSalesAlerts(c: Ctx): Promise<Alert[]> {
  const shopIds = c.shops.map((s) => s.id);
  const since = addDays(c.today, -1);
  const [refundRows, discountRows] = await Promise.all([
    db
      .select({ shopId: refunds.shopId, by: refunds.createdBy, label: staff.displayLabel, n: sql<number>`count(*)::int`, cents: sql<number>`sum(${refunds.amountCents})::int`, biggest: sql<number>`max(${refunds.amountCents})::int` })
      .from(refunds)
      .leftJoin(staff, eq(staff.id, refunds.createdBy))
      .where(and(inArray(refunds.shopId, shopIds), gte(refunds.businessDate, since), eq(refunds.source, "staff")))
      .groupBy(refunds.shopId, refunds.createdBy, staff.displayLabel),
    db
      .select({
        shopId: sales.shopId,
        by: sales.createdBy,
        label: staff.displayLabel,
        n: sql<number>`count(*) filter (where ${sales.discountCents} > 0)::int`,
        big: sql<number>`count(*) filter (where ${sales.discountCents} > 0 and ${sales.discountCents} >= (${sales.serviceGrossCents} + ${sales.productGrossCents}) * ${UNUSUAL.discountPct}::numeric)::int`,
        cents: sql<number>`sum(${sales.discountCents})::int`,
      })
      .from(sales)
      .leftJoin(staff, eq(staff.id, sales.createdBy))
      .where(and(inArray(sales.shopId, shopIds), gte(sales.businessDate, since), eq(sales.isImported, false), inArray(sales.status, ["paid", "refunded", "partially_refunded"])))
      .groupBy(sales.shopId, sales.createdBy, staff.displayLabel),
  ]);
  const out: Alert[] = [];
  for (const s of c.shops) {
    const r = refundRows.filter((x) => x.shopId === s.id && (x.n >= UNUSUAL.refundCount || x.cents >= UNUSUAL.refundCents || x.biggest >= UNUSUAL.refundCents));
    if (r.length)
      out.push({
        key: `unusual_refunds:${s.id}:${c.today}`,
        type: "unusual_refunds",
        severity: "medium",
        shopId: s.id,
        shop: s.name,
        title: "More refunds than usual since yesterday",
        detail: "Worth a look on the Discounts & refunds report.",
        items: r.map((x) => ({ label: x.label ?? "Someone", sub: `${plural(x.n, "refund")}, ${formatCents(x.cents)}` })),
        href: `/admin/reports/discounts-refunds?shop=${s.id}&from=${since}&to=${c.today}`,
        linkLabel: "Report",
      });
    const d = discountRows.filter((x) => x.shopId === s.id && (x.n >= UNUSUAL.discountCount || x.big >= 2));
    if (d.length)
      out.push({
        key: `unusual_discounts:${s.id}:${c.today}`,
        type: "unusual_discounts",
        severity: "low",
        shopId: s.id,
        shop: s.name,
        title: "Unusual discounting since yesterday",
        detail: `Several discounted tickets, or discounts of ${Math.round(UNUSUAL.discountPct * 100)}% or more.`,
        items: d.map((x) => ({ label: x.label ?? "Someone", sub: `${plural(x.n, "discounted ticket")}${x.big ? ` (${x.big} large)` : ""}, ${formatCents(x.cents)}` })),
        href: `/admin/reports/discounts-refunds?shop=${s.id}&from=${since}&to=${c.today}`,
        linkLabel: "Report",
      });
  }
  return out;
}

async function lookupAlerts(c: Ctx): Promise<Alert[]> {
  const rows = await db
    .select({ id: clientAccessAlerts.id, label: clientAccessAlerts.actorLabel, kind: clientAccessAlerts.kind, profiles: clientAccessAlerts.profiles, searches: clientAccessAlerts.searches, at: clientAccessAlerts.at })
    .from(clientAccessAlerts)
    .where(and(isNull(clientAccessAlerts.acknowledgedAt), gte(clientAccessAlerts.at, new Date(c.now.getTime() - 7 * 86_400_000))))
    .orderBy(asc(clientAccessAlerts.at));
  if (!rows.length) return [];
  return [
    {
      key: `client_lookups:all:${c.today}:${rows.length}`,
      type: "client_lookups",
      severity: rows.some((r) => r.kind === "paused") ? "high" : "medium",
      shopId: null,
      shop: null,
      title: `${plural(rows.length, "unusual burst")} of client lookups to review`,
      detail: "Someone opened many client profiles or ran many searches in a short time.",
      items: rows.slice(0, 5).map((r) => ({ label: r.label.split(":").pop() ?? r.label, sub: `${r.profiles} profiles, ${r.searches} searches${r.kind === "paused" ? " · lookups paused" : ""}` })),
      href: "/admin/client-data/access",
      linkLabel: "Review",
    },
  ];
}

// ───────────────────────────── Setup ─────────────────────────────

async function setupAlerts(c: Ctx): Promise<Alert[]> {
  const out: Alert[] = [];
  if (c.has("settings.taxes")) {
    const unverified = c.shops.filter((s) => !s.taxRatesVerified);
    if (unverified.length)
      out.push({
        key: `tax_unverified:all:${c.today}:${unverified.length}`,
        type: "tax_unverified",
        severity: unverified.some((s) => s.status === "live") ? "medium" : "low",
        shopId: null,
        shop: null,
        title: `Tax rates not confirmed for ${unverified.map((s) => s.name).join(", ")}`,
        detail: "Check the local service and product rates, enter them and tick verified.",
        href: "/admin/settings",
        linkLabel: "Settings",
      });
  }
  if (c.has("locations.setup") || c.has("payments.accounts")) {
    for (const s of c.shops.filter((x) => x.status === "setup")) {
      const st = await locationSetup(s.id);
      if (!st) continue;
      const left = st.steps.filter((x) => x.required && !x.done);
      out.push({
        key: `setup_checklist:${s.id}:${c.today}:${left.length}`,
        type: "setup_checklist",
        severity: "low",
        shopId: s.id,
        shop: s.name,
        title: left.length ? `${plural(left.length, "step")} left before ${s.name} can go live` : `${s.name} is ready to go live`,
        detail: left.length ? left.map((x) => x.title).join(", ") : "Everything required is done.",
        href: `/admin/setup?shop=${s.id}`,
        linkLabel: "Setup",
      });
    }
    if (c.has("payments.accounts")) {
      const live = c.shops.filter((s) => s.status === "live");
      const accounts = live.length ? await db.select().from(shopPaymentAccounts).where(inArray(shopPaymentAccounts.shopId, live.map((s) => s.id))) : [];
      const notReady = live.filter((s) => s.paymentsMode !== "cash_only" && !takesCards(s.paymentsMode, accounts.find((a) => a.shopId === s.id)));
      for (const s of notReady)
        out.push({
          key: `not_taking_cards:${s.id}:${c.today}`,
          type: "not_taking_cards",
          severity: "high",
          shopId: s.id,
          shop: s.name,
          title: `${s.name} can't take cards`,
          detail: "Its Stripe account isn't finished. Cash still works.",
          href: `/admin/setup?shop=${s.id}`,
          linkLabel: "Finish payments",
        });
      const failed = await db
        .select({ shopId: shopPayouts.shopId, amountCents: shopPayouts.amountCents, failureMessage: shopPayouts.failureMessage, id: shopPayouts.stripePayoutId })
        .from(shopPayouts)
        .where(
          and(
            eq(shopPayouts.status, "failed"),
            gte(shopPayouts.updatedAt, new Date(c.now.getTime() - 7 * 86_400_000)),
            c.v.brandWide ? or(inArray(shopPayouts.shopId, ids(c.shops.map((s) => s.id))), isNull(shopPayouts.shopId)) : inArray(shopPayouts.shopId, ids(c.shops.map((s) => s.id))),
          ),
        );
      for (const p of failed) {
        const shop = p.shopId ? c.shops.find((s) => s.id === p.shopId) : null;
        out.push({
          key: `failed_payout:${p.id}`,
          type: "failed_payouts",
          severity: "high",
          shopId: p.shopId,
          shop: shop?.name ?? null,
          title: `A ${formatCents(p.amountCents)} payout to ${shop ? `${shop.name}'s` : "the brand's"} bank failed`,
          detail: p.failureMessage ?? "Stripe couldn't deposit it. Check the bank account in Stripe.",
          href: p.shopId ? `/admin/payouts?shop=${p.shopId}` : "/admin/payouts?shop=all",
          linkLabel: "Payouts",
        });
      }
    }
  }
  return out;
}

// ───────────────────────────── Sales pace ─────────────────────────────

export interface ShopPace {
  shopId: string;
  shop: string;
  nowCents: number;
  priorCents: number;
  tickets: number;
  change: number | null;
}

/** Net sales per shop between the start of `date` and `until`, beside the same window a week earlier. */
export async function salesPace(shopIds: readonly string[], date: LocalDate, until: Date): Promise<ShopPace[]> {
  if (!shopIds.length) return [];
  const net = sql<number>`coalesce(sum(${sales.serviceNetCents} + ${sales.productNetCents}), 0)::int`;
  const window = (d: LocalDate, end: Date) =>
    db
      .select({ shopId: sales.shopId, cents: net, tickets: sql<number>`count(*)::int` })
      .from(sales)
      .where(and(inArray(sales.shopId, [...shopIds]), eq(sales.businessDate, d), eq(sales.isImported, false), inArray(sales.status, ["paid", "refunded", "partially_refunded"]), lte(sales.paidAt, end)))
      .groupBy(sales.shopId);
  const [cur, prior, names] = await Promise.all([
    window(date, until),
    window(addDays(date, -7), new Date(until.getTime() - 7 * 86_400_000)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, [...shopIds])).orderBy(asc(shops.name)),
  ]);
  return names.map((s) => {
    const n = cur.find((x) => x.shopId === s.id);
    const p = prior.find((x) => x.shopId === s.id);
    return { shopId: s.id, shop: s.name, nowCents: n?.cents ?? 0, priorCents: p?.cents ?? 0, tickets: n?.tickets ?? 0, change: paceChange(n?.cents ?? 0, p?.cents ?? 0) };
  });
}

async function paceAlerts(c: Ctx): Promise<Alert[]> {
  const live = c.shops.filter((s) => s.status === "live");
  const pace = await salesPace(live.map((s) => s.id), c.today, c.now);
  const rows = pace.filter((p) => p.nowCents || p.priorCents);
  if (!rows.length) return [];
  const behind = rows.filter((p) => p.change !== null && p.change <= -PACE.dropPct && p.priorCents >= PACE.minPriorCents);
  return [
    {
      key: `sales_pace:all:${c.today}`,
      type: "sales_pace",
      severity: behind.length ? "medium" : "low",
      shopId: null,
      shop: null,
      title: behind.length ? `${behind.map((p) => p.shop).join(", ")} behind last ${formatDate(c.today, "EEEE")}` : `Sales vs last ${formatDate(c.today, "EEEE")} at this time`,
      detail: `So far today ${formatCents(rows.reduce((a, p) => a + p.nowCents, 0))}, vs ${formatCents(rows.reduce((a, p) => a + p.priorCents, 0))} by this time last week.`,
      items: rows.map((p) => ({ label: p.shop, sub: `${formatCents(p.nowCents)} vs ${formatCents(p.priorCents)}${p.change === null ? "" : ` (${pctLabel(p.change)})`}` })),
      href: "/admin/reports/sales-summary",
      linkLabel: "Sales",
    },
  ];
}

// ───────────────────────────── Messages, tickets, inbox ─────────────────────────────

async function notificationAlerts(c: Ctx): Promise<Alert[]> {
  const shopIds = c.shops.map((s) => s.id);
  const rows = await db
    .select({ id: notificationJobs.id, shopId: notificationJobs.shopId, kind: notificationJobs.kind, channel: notificationJobs.channel, error: notificationJobs.lastError })
    .from(notificationJobs)
    .where(and(inArray(notificationJobs.shopId, shopIds), eq(notificationJobs.status, "failed"), gte(notificationJobs.createdAt, new Date(c.now.getTime() - 2 * 86_400_000))));
  if (!rows.length) return [];
  const reasons = [...new Set(rows.map((r) => r.error).filter(Boolean))].slice(0, 3);
  return [
    {
      key: `failed_notifications:all:${c.today}:${rows.length}`,
      type: "failed_notifications",
      severity: rows.length >= 5 ? "high" : "medium",
      shopId: null,
      shop: null,
      title: `${plural(rows.length, "message")} to clients or vendors failed in the last 2 days`,
      detail: reasons.length ? `Errors: ${reasons.join("; ")}` : "The provider rejected them.",
      items: [...new Set(rows.map((r) => r.shopId))].map((id) => ({ label: c.name(id) ?? "Brand", sub: plural(rows.filter((r) => r.shopId === id).length, "failed message") })),
      href: "/admin/notifications?status=failed",
      linkLabel: "Outbox",
      action: c.has("notifications.send")
        ? {
            kind: "retry_notifications",
            label: `Retry ${plural(rows.length, "message")}`,
            confirm: "Puts them back in the queue to send now. Numbers that replied STOP stay suppressed.",
            payload: { jobIds: rows.map((r) => r.id) },
          }
        : undefined,
    },
  ];
}

async function openTicketAlerts(c: Ctx): Promise<Alert[]> {
  const rows = await db
    .select({ id: sales.id, number: sales.number, shopId: sales.shopId, date: sales.businessDate })
    .from(sales)
    .where(and(inArray(sales.shopId, c.shops.map((s) => s.id)), eq(sales.status, "open"), lt(sales.businessDate, c.today)))
    .orderBy(asc(sales.businessDate));
  const out: Alert[] = [];
  for (const shopId of [...new Set(rows.map((r) => r.shopId))]) {
    const mine = rows.filter((r) => r.shopId === shopId);
    out.push({
      key: `open_tickets:${shopId}:${c.today}`,
      type: "open_tickets",
      severity: "medium",
      shopId,
      shop: c.name(shopId),
      title: `${plural(mine.length, "ticket")} from earlier days still open`,
      detail: "Check them out or void them so sales and payroll are complete.",
      items: mine.slice(0, 6).map((r) => ({ label: `Ticket ${r.number}`, sub: formatDate(r.date), href: `/admin/checkout/${r.id}` })),
    });
  }
  return out;
}

async function inboxAlerts(c: Ctx): Promise<Alert[]> {
  const n = await unreadCount(c.shops.map((s) => s.id));
  if (!n) return [];
  return [
    {
      key: `unread_texts:all:${c.today}:${n}`,
      type: "unread_texts",
      severity: n >= 5 ? "medium" : "low",
      shopId: null,
      shop: null,
      title: `${plural(n, "unread text")} from clients`,
      detail: "Replies go out from the shop's own number.",
      href: "/admin/inbox",
      linkLabel: "Inbox",
    },
  ];
}

/** Today as this signed-in person sees it: the shop they're in (or all theirs), under their permissions. */
export function viewerOf(ctx: StaffContext): TodayViewer {
  return { staffId: ctx.staff.id, shopIds: reportShopIds(ctx), permissions: ctx.permissions, brandWide: ctx.brandWide, reasons: reasonViewer(ctx) };
}
