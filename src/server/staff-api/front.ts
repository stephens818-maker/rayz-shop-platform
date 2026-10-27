import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shops, timeOffRequests, waitlistEntries } from "@/db/schema";
import { clientName } from "@/domain/client-privacy";
import { reportView } from "@/domain/permissions";
import { localMinutesOf, todayLocal, type LocalDate } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { approverOf, can, canAny, reasonViewer } from "@/server/auth/staff";
import { pickerReasons } from "@/server/block-reasons";
import { estimateWait, quickWalkIn, seatFromWaitlist, updateWaitlistStatus, waitlistForShop } from "@/server/booking";
import { shopBarbers, shopCatalog } from "@/server/catalog";
import { changeableAppt } from "@/server/calendar-ops";
import { loadCheckoutContext, openSaleForAppointment, priceCart, type CheckoutLineInput } from "@/server/checkout";
import { checkEntry, fillEntry } from "@/server/client-entry";
import { clientPolicy, type ClientPolicy } from "@/server/client-privacy";
import { customerAccess, textingDeclined } from "@/server/customers";
import { AppError, forbidden, notFound } from "@/server/errors";
import { stockLevels } from "@/server/inventory/stock";
import { loadMilestoneSettings } from "@/server/milestones/engine";
import { congratsFor, milestoneViewer, personFor, progressFor, todayMilestones, trophyCase } from "@/server/milestones/views";
import { enqueueRaw } from "@/server/notifications/queue";
import { computeCardFee } from "@/server/payments/card-fee";
import { ensureTerminalLocation } from "@/server/payments/connect";
import { stripe } from "@/server/payments/processor";
import { myRebook } from "@/server/rebook-report";
import { cancelTimeOff, decideTimeOff, listRequests, pendingCount, requestTimeOff } from "@/server/staff-time";
import { requireInTenant } from "@/server/tenant";
import { periodFor, timesheetList } from "@/server/time-clock";
import { randomToken } from "@/server/auth/tokens";
import { assertTapToPay } from "./config";
import { myCalendar, seesEveryColumn } from "./calendar";
import { conflictsView, shopOf, type StaffAppContext } from "./http";

/**
 * The rest of the staff app's day (ST-I1 to ST-I7): time off, milestones at clock-in, walk-ins and
 * the waitlist, checkout at the chair, the front-desk kiosk's queue and the manager's board. Each one
 * is the same server code as the web page it mirrors, held to the same permissions. Client names are
 * as Client data protection shows them; phone numbers never come back.
 */

// ───────────────────────────── ST-I1 Time off ─────────────────────────────

/** GET /me/time-off-requests: their own, newest first, with the reasons they can ask for. */
export async function myTimeOff(ctx: StaffAppContext) {
  const [requests, reasons] = await Promise.all([listRequests({ staffId: ctx.staff.id }, { viewer: reasonViewer(ctx), limit: 100 }), pickerReasons("time_off", ctx.currentShopId)]);
  return { requests, reasons, canRequest: can(ctx, "timeoff.request") };
}

export interface TimeOffBody {
  shopId: string | null;
  fromDate: LocalDate;
  toDate: LocalDate;
  allDay: boolean;
  startMin?: number;
  endMin?: number;
  reasonId: string;
  note?: string | null;
  confirm?: boolean;
}

/** POST /me/time-off-requests: { saved: false, conflicts } until confirmed when clients are booked in it; they stay booked. */
export async function askForTimeOff(ctx: StaffAppContext, v: TimeOffBody) {
  const mine = await workShopIds(ctx.staff.id);
  if (!mine.length) throw forbidden("You aren't on any shop's team yet");
  if (v.shopId && !mine.includes(v.shopId)) throw forbidden("You don't work at that shop");
  const range = v.allDay ? { fromDate: v.fromDate, toDate: v.toDate, startMin: null, endMin: null } : { fromDate: v.fromDate, toDate: v.fromDate, startMin: v.startMin ?? null, endMin: v.endMin ?? null };
  const r = await requestTimeOff({ staffId: ctx.staff.id, shopId: v.shopId, range, reasonId: v.reasonId, note: v.note ?? null }, { actor: ctx.actor, confirm: v.confirm, enforceNotice: true });
  return r.done ? { saved: true, requestId: r.requestId, status: r.status, heldForManager: r.heldForManager, conflicts: conflictsView(r.conflicts) } : { saved: false, requestId: null, status: null, heldForManager: false, conflicts: conflictsView(r.conflicts) };
}

/** DELETE /me/time-off-requests/{id}: their own, while pending or before approved time off starts. */
export async function withdrawTimeOff(ctx: StaffAppContext, id: string) {
  const r = await db.query.timeOffRequests.findFirst({ where: eq(timeOffRequests.id, id), columns: { staffId: true } });
  if (!r || r.staffId !== ctx.staff.id) throw notFound("Time off request");
  await cancelTimeOff(id, approverOf(ctx));
}

/** GET /time-off-requests?status=: everyone's at the approver's shops. */
export async function teamTimeOff(ctx: StaffAppContext, q: { shopId?: string; status?: "pending" | "all" }) {
  const shopIds = q.shopId ? [shopOf(ctx, q.shopId)] : ctx.shopIds;
  const requests = await listRequests({ shopIds, brandWide: !q.shopId && ctx.brandWide }, { viewer: reasonViewer(ctx), statuses: q.status === "all" ? undefined : ["pending"], since: new Date(Date.now() - 14 * 86_400_000) });
  return { requests: requests.map((r) => ({ ...r, mine: r.staffId === ctx.staff.id })) };
}

async function requestHere(ctx: StaffAppContext, id: string) {
  const r = await db.query.timeOffRequests.findFirst({ where: eq(timeOffRequests.id, id), columns: { staffId: true, shopId: true } });
  if (!r) throw notFound("Time off request");
  const shops = r.shopId ? [r.shopId] : await workShopIds(r.staffId);
  if (!ctx.brandWide && !shops.some((s) => ctx.shopIds.includes(s))) throw notFound("Time off request");
}

/** POST /time-off-requests/{id}/decision: approve (it becomes a block on their calendar) or deny; they get a push either way. */
export async function decideTeamTimeOff(ctx: StaffAppContext, id: string, v: { decision: "approve" | "deny"; note?: string | null }) {
  await requestHere(ctx, id);
  const r = await decideTimeOff(id, v.decision, v.note ?? null, approverOf(ctx));
  return { status: r.request.status, affected: r.affected.map((a) => ({ appointmentId: a.id, code: a.code, startsAt: a.startsAt })) };
}

// ───────────────────────────── ST-I2 Milestones ─────────────────────────────

/**
 * GET /me/milestones: their trophies, personal bests, progress to the next count and streak, time with
 * the brand and new ones to congratulate; their rebook rate against the brand's with the rebook report;
 * teammates' milestones only with "see every barber's numbers" (reports.all_staff).
 */
export async function myMilestones(ctx: StaffAppContext, now = new Date()) {
  const s = await loadMilestoneSettings();
  if (!s.enabled) return { enabled: false as const };
  const me = await personFor(await milestoneViewer(ctx), s, ctx.staff.id);
  if (!me) return { enabled: false as const };
  const [trophies, progress, congrats, rebook, today] = await Promise.all([
    trophyCase(ctx.staff.id),
    progressFor(me, now),
    congratsFor(ctx.staff.id, now, s),
    can(ctx, reportView("rebook_rate")) ? myRebook(ctx.staff.id, ctx.shopIds, todayLocal(now), now) : null,
    can(ctx, "reports.all_staff") ? todayMilestones(ctx, ctx.shopIds, now) : null,
  ]);
  return {
    enabled: true as const,
    ...trophies,
    progress,
    congrats,
    rebook: rebook ? { rates: rebook.rates, brand: rebook.brand, second: rebook.second, brandSecond: rebook.brandSecond } : null,
    team: today ? today.team : null,
  };
}

// ───────────────────────────── ST-I3 Walk-ins and the waitlist ─────────────────────────────

type Entry = typeof waitlistEntries.$inferSelect;

function entryView(e: Entry, policy: ClientPolicy, service: Map<string, string>, barber: Map<string, string>) {
  const [first, ...rest] = e.name.trim().split(/\s+/);
  return {
    id: e.id,
    name: clientName(first, policy.show("last_name", rest.join(" ") || null)),
    customerId: e.customerId,
    status: e.status,
    service: e.serviceId ? (service.get(e.serviceId) ?? null) : null,
    serviceId: e.serviceId,
    preferredBarber: e.preferredStaffId ? (barber.get(e.preferredStaffId) ?? null) : null,
    preferredStaffId: e.preferredStaffId,
    quotedWaitMin: e.quotedWaitMin,
    joinedAt: e.joinedAt.toISOString(),
    canText: !!e.phone,
  };
}

/** GET /shops/{id}/waitlist: who's waiting, the estimated wait, and the barbers to seat them with. */
export async function shopWaitlist(ctx: StaffAppContext, shopIdRaw: string, now = new Date()) {
  const shopId = shopOf(ctx, shopIdRaw);
  const [list, barbers, catalog, policy] = await Promise.all([waitlistForShop(shopId), shopBarbers(shopId), shopCatalog(shopId), clientPolicy(ctx)]);
  const services = catalog.filter((s) => s.kind === "service");
  const service = new Map(services.map((s) => [s.id, s.name]));
  const barber = new Map(barbers.map((b) => [b.id, b.displayName]));
  return {
    shopId,
    estimatedWaitMin: await estimateWait(shopId, barbers.map((b) => b.id), now),
    entries: list.map((e) => entryView(e, policy, service, barber)),
    barbers: barbers.map((b) => ({ id: b.id, name: b.displayName })),
    services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin })),
  };
}

/** POST /shops/{id}/waitlist: a walk-in, seated now with a free barber or added to the waitlist. */
export async function addWalkIn(ctx: StaffAppContext, shopIdRaw: string, v: { serviceId: string; name: string; phone?: string | null; preferredStaffId?: string | null; customerId?: string | null }) {
  const shopId = shopOf(ctx, shopIdRaw);
  if (v.customerId && !(await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, v.customerId))) throw notFound("Client");
  const typed = v.customerId ? null : checkEntry(await clientPolicy(ctx), { phone: v.phone ?? "" });
  const r = await quickWalkIn({ shopId, serviceId: v.serviceId, name: v.name, preferredStaffId: v.preferredStaffId ?? null, customerId: v.customerId ?? null, phone: v.customerId ? null : (typed?.phone ?? null), actor: ctx.actor });
  const clientId = r.seated ? r.appointment.customer?.id : r.entry.customerId;
  if (typed && clientId) await fillEntry(clientId, typed, { actor: ctx.actor, staffId: ctx.staff.id, shopId });
  return r.seated ? { seated: true as const, appointmentId: r.appointment.id, barber: r.appointment.barber.displayName } : { seated: false as const, entryId: r.entry.id, quotedWaitMin: r.entry.quotedWaitMin ?? 0 };
}

async function entryHere(ctx: StaffAppContext, entryId: string) {
  await requireInTenant(ctx, "waitlist_entry", entryId);
  const e = await db.query.waitlistEntries.findFirst({ where: eq(waitlistEntries.id, entryId) });
  if (!e) throw notFound("Waitlist entry");
  shopOf(ctx, e.shopId);
  return e;
}

/** POST /waitlist/{id}/seat: an appointment now with that barber; the barber gets "you're up". */
export async function seatEntry(ctx: StaffAppContext, entryId: string, staffId: string) {
  const e = await entryHere(ctx, entryId);
  if (!(await shopBarbers(e.shopId)).some((b) => b.id === staffId)) throw notFound("Barber");
  const appt = await seatFromWaitlist(entryId, staffId, ctx.actor);
  return { appointmentId: appt.id };
}

/** POST /waitlist/{id}/status: they left, or they're done. */
export async function setEntryStatus(ctx: StaffAppContext, entryId: string, status: "left" | "done") {
  await entryHere(ctx, entryId);
  await updateWaitlistStatus(entryId, status, ctx.actor);
}

/** POST /waitlist/{id}/notify: texts "your chair is ready" from the shop's number, unless they've opted out of texts. */
export async function notifyEntry(ctx: StaffAppContext, entryId: string) {
  const e = await entryHere(ctx, entryId);
  if (!e.phone) throw new AppError("conflict", "There's no phone number on this entry. Call or wave them in.");
  if (await textingDeclined(e.customerId, e.phone)) throw new AppError("conflict", "This client has opted out of texts. Call or wave them in instead.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, e.shopId), columns: { name: true } });
  await enqueueRaw({ kind: "waitlist_ready", channel: "sms", to: e.phone, customerId: e.customerId, shopId: e.shopId, body: `Ray'z ${shop?.name}: ${e.name.split(" ")[0]}, your chair is ready! Please head in.` });
  await updateWaitlistStatus(entryId, "notified", ctx.actor);
  return { notified: true };
}

// ───────────────────────────── ST-I4 Checkout at the chair ─────────────────────────────

/**
 * POST /sales: the ticket for an appointment (theirs, or anyone's with "check out any barber's
 * clients"), opened or reused, priced by the server from the shop's menu, with the card fee the
 * shop's policy adds to a credit card (computeCardFee). Paying still happens at the front desk, or
 * with Tap to Pay once it's switched on.
 */
export async function saleForAppointment(ctx: StaffAppContext, v: { appointmentId: string; tipCents?: number }) {
  const a = await changeableAppt(ctx, v.appointmentId);
  if (a.staffId !== ctx.staff.id && !can(ctx, "checkout.any")) throw forbidden("You can check out only your own clients");
  const sale = await openSaleForAppointment(v.appointmentId, ctx.actor);
  return saleQuote(ctx, sale.id, v.tipCents ?? 0);
}

async function saleQuote(ctx: StaffAppContext, saleId: string, tipCents: number) {
  const c = await loadCheckoutContext(saleId);
  shopOf(ctx, c.shop.id);
  const lines: CheckoutLineInput[] = c.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty, staffId: i.staffId, appointmentId: i.appointmentId ?? null }));
  const base = { saleId, lines, tipCents, tender: { method: "none" as const } };
  const priced = c.sale.status === "open" ? await priceCart(base, null) : null;
  const t = priced?.totals;
  const fee = t ? await computeCardFee(c.shop.id, "credit", { chargeCents: t.preFeeTotalCents, tipCents }) : null;
  return {
    saleId,
    status: c.sale.status,
    shopId: c.shop.id,
    lines: (t?.lines ?? []).map((l) => ({ kind: l.kind, name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents, netCents: l.netCents })),
    totals: t ? { subtotalCents: t.serviceGrossCents + t.productGrossCents + t.giftCardSalesCents, discountCents: t.discountCents, taxCents: t.taxCents, tipCents: t.tipCents, totalCents: t.preFeeTotalCents } : null,
    creditCard: fee && t ? { feeCents: fee.feeCents, rate: fee.rate, flatCents: fee.flatCents, waivable: fee.waivable, totalCents: t.preFeeTotalCents + fee.feeCents } : null,
    tapToPay: { enabled: false },
  };
}

/**
 * POST /terminal/connection-token: a Stripe Terminal connection token for the shop's Terminal
 * location, for Tap to Pay on the phone. Off until FEATURE_STAFF_TAP_TO_PAY; the simulator gives a
 * stand-in token so the app's flow can be tested without Stripe.
 */
export async function terminalConnectionToken(ctx: StaffAppContext, v: { shopId?: string }) {
  assertTapToPay();
  if (!canAny(ctx, ["checkout.any", "pos.custom_charge"]) && !can(ctx, "timeclock.punch")) throw forbidden("You can't take payments");
  const shopId = shopOf(ctx, v.shopId);
  const location = await ensureTerminalLocation(shopId, ctx.actor);
  const s = stripe();
  if (!s) return { secret: `sim_pst_${randomToken(12)}`, location, simulated: true };
  const t = await s.terminal.connectionTokens.create({ location }).catch((e: Error) => {
    throw new AppError("payment_failed", `Stripe didn't issue a Terminal token: ${e.message}`);
  });
  return { secret: t.secret, location, simulated: false };
}

// ───────────────────────────── ST-I6 The front-desk kiosk's walk-in queue ─────────────────────────────

/** The queue a front-desk device shows: first names and how long each has waited, nothing else. */
export async function kioskQueue(shopId: string, now = new Date()) {
  const [list, barbers] = await Promise.all([waitlistForShop(shopId), shopBarbers(shopId)]);
  return {
    shopId,
    estimatedWaitMin: await estimateWait(shopId, barbers.map((b) => b.id), now),
    queue: list.map((e, i) => ({ position: i + 1, firstName: e.name.trim().split(/\s+/)[0] ?? "", status: e.status, waitedMin: Math.max(0, Math.round((now.getTime() - e.joinedAt.getTime()) / 60_000)), quotedWaitMin: e.quotedWaitMin })),
  };
}

// ───────────────────────────── ST-I7 The manager's board ─────────────────────────────

/**
 * GET /manager/board?shopId=: today at one shop, in the parts the manager may see: each barber's clock
 * and chair, the waitlist, time off to decide, timecards to approve and products running low.
 */
export async function managerBoard(ctx: StaffAppContext, shopIdRaw?: string, now = new Date()) {
  const shopId = shopOf(ctx, shopIdRaw);
  const today = todayLocal(now);
  const sees = {
    calendar: seesEveryColumn(ctx),
    waitlist: can(ctx, "walkins.manage"),
    timeOff: can(ctx, "timeoff.approve"),
    timecards: can(ctx, "timesheet.approve"),
    lowStock: canAny(ctx, ["inventory.manage", "inventory.adjust", "inventory.transfer", "inventory.stocktake", "po.create", "po.receive", "catalog.manage", "catalog.prices"]),
  };
  if (!Object.values(sees).some(Boolean)) throw forbidden("You don't have a manager's view of this shop");
  const [cal, waiting, offPending, sheets, stock] = await Promise.all([
    sees.calendar ? myCalendar(ctx, { date: today, shopId }) : null,
    sees.waitlist ? waitlistForShop(shopId) : null,
    sees.timeOff ? pendingCount([shopId], false) : null,
    sees.timecards ? timesheetList(periodFor(today).start, [shopId]) : null,
    sees.lowStock ? stockLevels([shopId]) : null,
  ]);
  const nowMin = localMinutesOf(now);
  return {
    shopId,
    date: today,
    sees,
    barbers: cal
      ? cal.columns.map((c) => {
          const live = c.appts.filter((a) => !["cancelled", "no_show"].includes(a.status));
          const next = live.find((a) => ["booked", "confirmed", "checked_in"].includes(a.status) && a.endMin > nowMin);
          return {
            staffId: c.staffId,
            label: c.label,
            clock: c.clock ? { status: c.clock.status, lateMin: c.clock.lateMin, overdueMin: c.clock.overdueMin } : null,
            inChair: live.some((a) => a.status === "in_service"),
            appointments: live.length,
            done: live.filter((a) => a.status === "completed").length,
            next: next ? { appointmentId: next.id, startsAt: next.startsAt, status: next.status } : null,
          };
        })
      : null,
    waitlist: waiting ? { waiting: waiting.filter((w) => w.status === "waiting").length, notified: waiting.filter((w) => w.status === "notified").length } : null,
    timeOffPending: offPending,
    timecards: sheets ? { period: periodFor(today).start, toApprove: sheets.rows.filter((r) => r.employeeApprovedAt && !r.managerApprovedAt).length, notSignedOff: sheets.rows.filter((r) => !r.employeeApprovedAt).length, missedPunches: sheets.rows.reduce((a, r) => a + r.problems, 0) } : null,
    lowStock: stock
      ? stock
          .filter((r) => r.low && r.active)
          .map((r) => ({ productId: r.productId, sku: r.sku, name: r.name, brand: r.brand, available: r.available, reorderPoint: r.levels.reorderPoint, par: r.levels.par, onOrder: r.onOrder }))
      : null,
  };
}
