import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  appointmentItems,
  appointments,
  customers,
  services,
  shopClosures,
  shopHours,
  shops,
  staff,
  staffDaysOn,
  staffSchedules,
  timeBlocks,
  timeOffRequests,
  waitlistEntries,
  Shop,
} from "@/db/schema";
import {
  BusyAppointment,
  DayAvailabilityInput,
  EarlyOpening,
  computeDaySlots,
  SQUEEZE_BYPASS_LABEL,
  StaffPlan,
  isSlotFree,
  onSlotGrid,
  pickBarber,
  squeezeCheck,
  totalDuration,
} from "@/domain/availability";
import type { Opening } from "@/domain/booking-group";
import { closedOn, takesOnlineBookings } from "@/domain/location-lifecycle";
import { fullAddress, mapsUrl, validLatLng } from "@/domain/location-profile";
import { appBaseUrl } from "@/lib/deployment";
import { effectiveEnd } from "@/domain/clock-blocks";
import { shopClockSettings } from "@/domain/time-clock";
import { trailingBuffer } from "@/domain/timing";
import { appointmentCode } from "@/lib/ids";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { LocalDate, addDays, endOfLocalDay, existingWallTime, formatTime, localDateOf, minutesToLabel, startOfLocalDay, todayLocal } from "@/lib/time";
import { Actor, audit } from "./audit";
import { EffectiveService, getShop, resolveStaffRef, servicesByIds, shopBarbers } from "./catalog";
import { CustomerInput, findOrCreateCustomer } from "./customers";
import { AppError, isDoubleBookingError, notFound } from "./errors";
import { liveClock } from "./clock-live";
import { AppointmentMessageContext, cancelPendingReminders, queueAppointmentMessage, scheduleAppointmentNotifications } from "./notifications/queue";
import { guardian, householdContact } from "./household-contact";
import { clearArrival, clearStart, recordArrival, startService } from "./service-times";
import { queueStaffAlert } from "./staff-alerts";
import { cleanNotificationPrefs, reminderHours } from "@/domain/staff-notifications";
import { shopReminderHours } from "./location-defaults";
import { bookingPlans, shopInterval, staffBookingOptions, staffIntervals, toStaffPlans } from "./timing";

export const ACTIVE_STATUSES = ["booked", "confirmed", "checked_in", "in_service"] as const;

export interface DayContextOptions {
  durationMin: number;
  staffIds: string[];
  /** Each barber's timing for this booking (src/server/timing.ts bookingPlans). */
  plans?: Record<string, StaffPlan>;
  now?: Date;
  ignoreAppointmentId?: string;
  ignoreAppointmentIds?: readonly string[];
  /** Staff-side booking ignores lead time / window limits. */
  staffOverride?: boolean;
}

export async function loadDayInput(shop: Shop, date: LocalDate, opts: DayContextOptions, tx: DBorTx = db): Promise<DayAvailabilityInput> {
  const dayStart = startOfLocalDay(date);
  const dayEnd = endOfLocalDay(date);
  const ids = opts.staffIds.length ? opts.staffIds : ["00000000-0000-0000-0000-000000000000"];
  const [hours, closures, schedules, blocks, appts, pending, daysOn] = await Promise.all([
    tx.select().from(shopHours).where(eq(shopHours.shopId, shop.id)),
    tx.select().from(shopClosures).where(and(eq(shopClosures.shopId, shop.id), eq(shopClosures.date, date))),
    tx.select().from(staffSchedules).where(inArray(staffSchedules.staffId, ids)),
    tx
      .select()
      .from(timeBlocks)
      .where(and(inArray(timeBlocks.staffId, ids), lt(timeBlocks.startsAt, dayEnd), gt(timeBlocks.endsAt, dayStart))),
    // Every shop — this is the cross-shop double-booking check.
    tx
      .select({
        id: appointments.id,
        staffId: appointments.staffId,
        shopId: appointments.shopId,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        status: appointments.status,
        bufferBeforeMin: appointments.bufferBeforeMinutes,
        bufferAfterMin: appointments.bufferMinutes,
      })
      .from(appointments)
      .where(and(inArray(appointments.staffId, ids), lt(appointments.startsAt, dayEnd), gt(appointments.endsAt, dayStart))),
    // Time off waiting for a manager is held from online booking, so clients don't book into it; the shop still can.
    opts.staffOverride
      ? []
      : tx
          .select({ staffId: timeOffRequests.staffId, shopId: timeOffRequests.shopId, startsAt: timeOffRequests.startsAt, endsAt: timeOffRequests.endsAt })
          .from(timeOffRequests)
          .where(and(inArray(timeOffRequests.staffId, ids), eq(timeOffRequests.status, "pending"), lt(timeOffRequests.startsAt, dayEnd), gt(timeOffRequests.endsAt, dayStart))),
    tx
      .select({ staffId: staffDaysOn.staffId, shopId: staffDaysOn.shopId, date: staffDaysOn.date, startMin: staffDaysOn.startMin, endMin: staffDaysOn.endMin })
      .from(staffDaysOn)
      .where(and(inArray(staffDaysOn.staffId, ids), eq(staffDaysOn.shopId, shop.id), eq(staffDaysOn.date, date), isNull(staffDaysOn.removedAt))),
  ]);
  const interval = await shopInterval(shop, tx);
  const now = opts.now ?? new Date();
  const clock = await clockAdjustments(shop, date, opts, now, tx);
  return {
    date,
    shopId: shop.id,
    shopHours: hours.map((h) => ({ weekday: h.weekday, startMin: h.openMin, endMin: h.closeMin })),
    closedDates: closures.map((c) => c.date),
    staffIds: opts.staffIds,
    schedules: schedules.map((s) => ({ staffId: s.staffId, shopId: s.shopId, weekday: s.weekday, startMin: s.startMin, endMin: s.endMin })),
    blocks: [
      ...blocks.map((b) => ({ staffId: b.staffId, shopId: b.shopId, startsAt: b.startsAt, endsAt: effectiveEnd(b, now) })),
      ...pending.map((b) => ({ staffId: b.staffId, shopId: b.shopId, startsAt: b.startsAt, endsAt: b.endsAt })),
    ],
    appointments: appts as BusyAppointment[],
    durationMin: opts.durationMin,
    slotIntervalMin: interval.minutes,
    bufferMin: shop.bufferMinutes,
    // Staff booking isn't held to a barber's client limits, as it isn't to the shop's.
    plans: opts.staffOverride && opts.plans ? Object.fromEntries(Object.entries(opts.plans).map(([id, p]) => [id, { ...p, leadMin: undefined, windowDays: undefined }])) : opts.plans,
    minLeadMin: opts.staffOverride ? 0 : shop.minLeadMinutes,
    daysOn,
    now,
    ignoreAppointmentId: opts.ignoreAppointmentId,
    ignoreAppointmentIds: opts.ignoreAppointmentIds,
    early: clock.early,
  };
}

/**
 * Today only, where the shop allows it: an early clock-in opens the time before the scheduled start
 * for barbers who allow it. (Breaks and early clock-outs are block-outs, read with the other
 * blocks.) Clients see only the slots that result.
 */
async function clockAdjustments(shop: Shop, date: LocalDate, opts: DayContextOptions, now: Date, tx: DBorTx): Promise<{ early: EarlyOpening[] }> {
  if (date !== todayLocal(now) || !opts.staffIds.length || !shopClockSettings(shop.timeClock).openEarly) return { early: [] };
  const { days } = await liveClock(shop, date, opts.staffIds, now, tx);
  const early: EarlyOpening[] = [];
  for (const d of days.values()) if (d.early) early.push({ staffId: d.staffId, start: d.early.start, end: d.early.end });
  return { early };
}

export interface AvailabilityQuery {
  shopRef: string;
  date: LocalDate;
  serviceId: string;
  addonIds?: string[];
  barberRef?: string | null; // "any" | slug | id
  now?: Date;
  ignoreAppointmentId?: string;
  staffOverride?: boolean;
}

async function resolveBooking(q: Pick<AvailabilityQuery, "shopRef" | "serviceId" | "addonIds" | "barberRef" | "staffOverride">, tx: DBorTx = db) {
  const shop = await getShop(q.shopRef, tx);
  const items = await servicesByIds(shop.id, [q.serviceId, ...(q.addonIds ?? [])], tx);
  const [service, ...addons] = items;
  if (service.kind !== "service") throw new AppError("bad_request", "serviceId must be a service, not an add-on");
  if (addons.some((a) => a.kind !== "addon")) throw new AppError("bad_request", "addonIds must all be add-ons");
  const barbers = await shopBarbers(shop.id, { onlineOnly: !q.staffOverride }, tx);
  let staffIds = barbers.map((b) => b.id);
  let requestedStaffId: string | null = null;
  if (q.barberRef && q.barberRef !== "any") {
    const b = await resolveStaffRef(q.barberRef, tx);
    if (!b || !staffIds.includes(b.id)) throw notFound("Barber at this shop");
    requestedStaffId = b.id;
    staffIds = [b.id];
  }
  const timing = await bookingPlans(shop, staffIds, items, tx);
  // A barber can take one service per online booking: clients can't add add-ons with them.
  if (!q.staffOverride && addons.length) {
    const one = staffIds.filter((id) => !timing.get(id)!.options.multipleServices.value);
    if (requestedStaffId && one.includes(requestedStaffId)) {
      throw new AppError("bad_request", `${barbers.find((b) => b.id === requestedStaffId)?.displayName ?? "This barber"} takes one service per online booking. Remove the add-ons or call the shop.`);
    }
    staffIds = staffIds.filter((id) => !one.includes(id));
  }
  const durationMin = requestedStaffId ? timing.get(requestedStaffId)!.plan.durationMin : totalDuration(items);
  return { shop, service, addons, items, barbers, staffIds, requestedStaffId, durationMin, timing, plans: toStaffPlans(timing) };
}

/** Why nothing can be booked on this day, or null. */
function dayClosedReason(r: Awaited<ReturnType<typeof resolveBooking>>, q: AvailabilityQuery, now: Date): string | null {
  const today = todayLocal(now);
  const tooFar = !q.staffOverride && q.date > addDays(today, r.shop.bookingWindowDays);
  if (closedOn(r.shop, q.date)) return r.shop.status === "archived" ? "This location has closed" : "The shop is closed then";
  if (!q.staffOverride && !takesOnlineBookings(r.shop, today)) return "Online booking is turned off for this shop";
  if (r.barbers.length === 0) return "No barbers are taking bookings at this shop yet";
  if (q.date < today || tooFar) return "Date is outside the booking window";
  return null;
}

/**
 * Each barber's open seats for one person's service on a day, with what each seat holds before
 * (prep) and after (cleanup and the gap): what a family booked together is planned from.
 */
export async function dayOpenings(q: AvailabilityQuery & { ignoreAppointmentIds?: readonly string[] }): Promise<{ openings: Opening[]; reason: string | null; durationMin: number; estimateCents: number }> {
  const r = await resolveBooking(q);
  const now = q.now ?? new Date();
  const s = summary(r);
  const closed = dayClosedReason(r, q, now);
  if (closed) return { openings: [], reason: closed, durationMin: s.durationMin, estimateCents: s.estimateCents };
  const input = await loadDayInput(r.shop, q.date, {
    durationMin: r.durationMin,
    staffIds: r.staffIds,
    plans: r.plans,
    now,
    ignoreAppointmentId: q.ignoreAppointmentId,
    ignoreAppointmentIds: q.ignoreAppointmentIds,
    staffOverride: q.staffOverride,
  });
  const openings = computeDaySlots(input).flatMap((slot) =>
    slot.staffIds.map((staffId) => {
      const plan = r.timing.get(staffId)!.plan;
      const end = slot.ends[staffId];
      return { staffId, start: slot.start, end, holdStart: slot.start - plan.beforeMin * 60_000, holdEnd: end + trailingBuffer(plan) * 60_000 };
    }),
  );
  return { openings, reason: openings.length ? null : "No openings on this day", durationMin: s.durationMin, estimateCents: s.estimateCents };
}

export async function getAvailability(q: AvailabilityQuery) {
  const r = await resolveBooking(q);
  const now = q.now ?? new Date();
  const closed = dayClosedReason(r, q, now);
  if (closed) return { ...summary(r), slots: [], reason: closed };
  const input = await loadDayInput(r.shop, q.date, {
    durationMin: r.durationMin,
    staffIds: r.staffIds,
    plans: r.plans,
    now,
    ignoreAppointmentId: q.ignoreAppointmentId,
    staffOverride: q.staffOverride,
  });
  const slots = computeDaySlots(input).map((s) => ({
    startsAt: new Date(s.start).toISOString(),
    endsAt: new Date(s.end).toISOString(),
    barberIds: s.staffIds,
  }));
  return { ...summary(r), slots, reason: slots.length ? null : "No openings on this day" };
}

function summary(r: Awaited<ReturnType<typeof resolveBooking>>) {
  return {
    shopId: r.shop.id,
    durationMin: r.durationMin,
    estimateCents: r.items.reduce((a, i) => a + i.priceCents, 0),
    barbers: r.barbers,
  };
}

/** Open/closed + slot counts for a run of days (drives the date strip in booking UIs). */
export async function getAvailableDays(q: Omit<AvailabilityQuery, "date"> & { from: LocalDate; days: number }) {
  const out: { date: LocalDate; slots: number }[] = [];
  const days = Math.min(Math.max(q.days, 1), 31);
  const results = await Promise.all(
    Array.from({ length: days }, (_, i) => addDays(q.from, i)).map((date) => getAvailability({ ...q, date })),
  );
  results.forEach((r, i) => out.push({ date: addDays(q.from, i), slots: r.slots.length }));
  return out;
}

// ───────────────────────────── Customers ─────────────────────────────

export { findOrCreateCustomer, type CustomerInput };

// ───────────────────────────── Appointments ─────────────────────────────

export interface CreateAppointmentInput {
  shopRef: string;
  serviceId: string;
  addonIds?: string[];
  barberRef?: string | null;
  startsAt: string | Date;
  customerId?: string | null;
  customer?: CustomerInput | null;
  /** Walk-ins: create a client even without a phone or email. */
  allowNoContact?: boolean;
  source: "online" | "api" | "staff" | "walk_in" | "rebook";
  notes?: string | null;
  idempotencyKey?: string | null;
  rebookedFromId?: string | null;
  /** One of a family booked together (src/server/booking-groups.ts). */
  groupId?: string | null;
  actor: Actor;
  now?: Date;
  /** Skip notifications (walk-ins being served right now). */
  silent?: boolean;
  /**
   * Staff only, with "calendar.squeeze_in" (checked by the caller): book this barber off their grid,
   * into buffer time or outside hours. Never over another service or time off. Audit-logged.
   */
  squeezeIn?: boolean;
}

/** Why this barber can't be booked at this start, in words the front desk can act on. */
function offGridMessage(day: DayAvailabilityInput, staffId: string, start: Date, barber: string | undefined, intervalMin: number) {
  const t = start.getTime();
  const nearby = computeDaySlots({ ...day, staffIds: [staffId] })
    .map((s) => s.start)
    .filter((x) => Math.abs(x - t) <= Math.max(intervalMin, 60) * 60_000)
    .sort((x, y) => Math.abs(x - t) - Math.abs(y - t))
    .slice(0, 3)
    .sort((x, y) => x - y);
  const suggest = nearby.length ? ` Open nearby: ${nearby.map((x) => formatTime(x)).join(", ")}.` : "";
  return `${formatTime(start)} isn't on ${barber ?? "this barber"}'s ${intervalMin}-minute grid here.${suggest}`;
}

export async function createAppointment(input: CreateAppointmentInput) {
  if (input.idempotencyKey) {
    const prior = await db.query.appointments.findFirst({ where: eq(appointments.idempotencyKey, input.idempotencyKey) });
    if (prior) return getAppointmentByCode(prior.code);
  }
  const created = await db.transaction((tx) => bookInTx(input, tx));
  await refreshClientBadges(created.customerId, input.now ?? new Date());
  return getAppointmentByCode(created.code);
}

/**
 * A booking's checks and inserts, inside the caller's transaction. A family booked together runs one
 * per person in a single transaction, so when any seat is gone nobody is booked.
 */
export async function bookInTx(input: CreateAppointmentInput, tx: DBorTx) {
  const staffOverride = input.source === "staff" || input.source === "walk_in" || input.source === "rebook";
  if (input.squeezeIn && (input.source === "online" || input.source === "api")) throw new AppError("forbidden", "Only staff can squeeze in a booking");
  if (input.squeezeIn && (!input.barberRef || input.barberRef === "any")) throw new AppError("bad_request", "Pick the barber to squeeze the booking in with");
  // Walk-ins are seated now, wherever that falls; every other booking starts on the barber's grid.
  const gridExempt = input.source === "walk_in";
  const r = await resolveBooking({ ...input, staffOverride }, tx);
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) throw new AppError("bad_request", "startsAt must be an ISO timestamp");
  const now = input.now ?? new Date();
  const date = localDateOf(start);
  if (closedOn(r.shop, date)) throw new AppError("conflict", r.shop.status === "archived" ? "This location has closed" : "The shop is closed then");
  if (!staffOverride) {
    if (!takesOnlineBookings(r.shop, todayLocal(now))) throw new AppError("forbidden", "Online booking is turned off for this shop");
    if (date > addDays(todayLocal(now), r.shop.bookingWindowDays)) throw new AppError("bad_request", "That date is too far out");
  }
  if (r.barbers.length === 0) throw new AppError("slot_unavailable", "No barbers are taking bookings at this shop yet");

  const estimateCents = r.items.reduce((a, i) => a + i.priceCents, 0);

  {
    const customer = input.customerId
      ? await tx.query.customers.findFirst({ where: eq(customers.id, input.customerId) })
      : input.customer
        ? await findOrCreateCustomer(input.customer, r.shop.id, tx, { allowNoContact: input.allowNoContact })
        : null;
    if (input.customerId && !customer) throw notFound("Customer");

    const day = await loadDayInput(r.shop, date, { durationMin: r.durationMin, staffIds: r.staffIds, plans: r.plans, now, staffOverride }, tx);
    const t = start.getTime();
    let squeeze: { bypasses: string[] } | null = null;
    let free: string[];
    if (input.squeezeIn) {
      const staffId = r.requestedStaffId!;
      const check = squeezeCheck(day, staffId, t);
      if (!check.ok) throw new AppError("slot_unavailable", `Can't squeeze in: ${check.reason.charAt(0).toLowerCase()}${check.reason.slice(1)}`);
      if (check.bypasses.length) squeeze = { bypasses: check.bypasses };
      free = [staffId];
    } else {
      const onGrid = gridExempt ? r.staffIds : r.staffIds.filter((id) => onSlotGrid(day, t, id));
      if (!onGrid.length) {
        if (!staffOverride) throw new AppError("bad_request", "Pick one of the offered times");
        const id = r.requestedStaffId ?? r.staffIds[0];
        const b = r.barbers.find((x) => x.id === id);
        throw new AppError("bad_request", offGridMessage(day, id, start, b?.displayName, r.timing.get(id)!.plan.intervalMin), { offGrid: true });
      }
      free = onGrid.filter((id) => isSlotFree(day, id, t));
    }
    if (free.length === 0) throw new AppError("slot_unavailable", "That time was just taken — please pick another");
    // The booking site takes no card: barbers who need one are booked in the app (which saves a card) or by phone.
    if (input.source === "online") {
      const payFirst = free.filter((id) => !r.timing.get(id)!.options.bookWithoutPayment.value);
      if (payFirst.length === free.length) {
        const name = r.barbers.find((b) => b.id === free[0])?.displayName ?? "This barber";
        throw new AppError("forbidden", `${r.requestedStaffId ? name : "The open barbers"} take bookings with a card on file. Book in the Rayz app or call the shop.`);
      }
      free = free.filter((id) => !payFirst.includes(id));
    }
    const ordered = r.requestedStaffId ? free : [pickBarber(free, day.appointments, date)!, ...free].filter((v, i, a) => a.indexOf(v) === i);

    for (const staffId of ordered) {
      const { plan, items } = r.timing.get(staffId)!;
      const end = new Date(t + plan.durationMin * 60_000);
      try {
        const appt = await tx.transaction(async (sp) => {
          const [a] = await sp
            .insert(appointments)
            .values({
              code: appointmentCode(),
              shopId: r.shop.id,
              staffId,
              customerId: customer?.id ?? null,
              startsAt: start,
              endsAt: end,
              bufferMinutes: trailingBuffer(plan),
              bufferBeforeMinutes: plan.beforeMin,
              squeezed: squeeze !== null,
              status: input.source === "walk_in" ? "checked_in" : "booked",
              checkedInAt: input.source === "walk_in" ? now : null,
              source: input.source,
              anyBarber: !r.requestedStaffId,
              estimateCents,
              notes: input.notes ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
              rebookedFromId: input.rebookedFromId ?? null,
              groupId: input.groupId ?? null,
            })
            .returning();
          await sp.insert(appointmentItems).values(
            items.map((i: EffectiveService) => ({
              appointmentId: a.id,
              serviceId: i.id,
              kind: i.kind,
              name: i.name,
              priceCents: i.priceCents,
              durationMin: i.durationMin,
            })),
          );
          return a;
        });
        await audit(input.actor, "appointment.create", "appointment", appt.id, { source: input.source, staffId, startsAt: start.toISOString() }, r.shop.id, tx);
        if (input.source === "walk_in") await recordArrival(appt.id, input.actor, tx, now);
        if (squeeze) {
          await audit(
            input.actor,
            "appointment.squeeze_in",
            "appointment",
            appt.id,
            { staffId, startsAt: start.toISOString(), endsAt: end.toISOString(), bypasses: squeeze.bypasses, bent: squeeze.bypasses.map((b) => SQUEEZE_BYPASS_LABEL[b as keyof typeof SQUEEZE_BYPASS_LABEL]) },
            r.shop.id,
            tx,
          );
        }
        if (customer && !input.silent) {
          await scheduleAppointmentNotifications("created", await messageContext(appt.id, tx), tx, now);
        }
        if (!input.silent && input.source !== "walk_in") await queueStaffAlert("confirm", appt.id, { actorStaffId: input.actor.staffId, now }, tx);
        return appt;
      } catch (e) {
        if (isDoubleBookingError(e)) continue;
        throw e;
      }
    }
    throw new AppError("slot_unavailable", "That time was just taken — please pick another");
  }
}

/**
 * Booking clears We miss you; a cancellation or no-show can bring it (or a lost streak) back.
 * Loaded here, not at the top: the badge engine is staff-only, and the client API books too.
 */
async function refreshClientBadges(customerId: string | null | undefined, now: Date) {
  if (!customerId) return;
  await import("./badges")
    .then((b) => b.refreshBadges([customerId], now))
    .catch((e: Error) => console.error("badge refresh after booking change failed", e.message));
}

export async function messageContext(appointmentId: string, tx: DBorTx = db): Promise<AppointmentMessageContext> {
  const [row] = await tx
    .select({
      id: appointments.id,
      code: appointments.code,
      startsAt: appointments.startsAt,
      shopId: shops.id,
      shopName: shops.name,
      endsAt: appointments.endsAt,
      shopAddress: shops.address,
      shopAddress2: shops.address2,
      shopCity: shops.city,
      shopState: shops.state,
      shopZip: shops.zip,
      shopLat: shops.latitude,
      shopLng: shops.longitude,
      geocodeSource: shops.geocodeSource,
      shopDirections: shops.directions,
      shopSlug: shops.slug,
      shopPhone: shops.phone,
      shopDefaults: { bookingWindowDays: shops.bookingWindowDays, minLeadMinutes: shops.minLeadMinutes, cancelCutoffMinutes: shops.cancelCutoffMinutes, bufferMinutes: shops.bufferMinutes },
      staffId: appointments.staffId,
      staffPrefs: staff.notificationPrefs,
      firstName: customers.firstName,
      barberName: staff.displayLabel,
      customerId: customers.id,
      ...householdContact,
    })
    .from(appointments)
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(guardian, eq(guardian.id, customers.guardianId))
    .where(eq(appointments.id, appointmentId));
  return {
    appointmentId: row.id,
    code: row.code,
    startsAt: row.startsAt,
    shopId: row.shopId,
    shopName: row.shopName,
    shopAddress: [row.shopAddress, row.shopCity].filter(Boolean).join(", "),
    barberName: row.barberName,
    customerId: row.customerId,
    phone: row.phone,
    email: row.email,
    smsOptIn: row.smsOptIn ?? false,
    emailOptIn: row.emailOptIn ?? false,
    firstName: row.firstName,
    shopSlug: row.shopSlug,
    shopPhone: row.shopPhone ? formatPhone(row.shopPhone) : null,
    reminders: reminderHours(cleanNotificationPrefs(row.staffPrefs), await shopReminderHours(row.shopId, tx)),
    cancelCutoffMinutes: (await staffBookingOptions({ ...row.shopDefaults, id: row.shopId }, [row.staffId], tx)).get(row.staffId)!.cancelCutoffMinutes.value,
    endsAt: row.endsAt,
    shopFullAddress: fullAddress({ address: row.shopAddress, address2: row.shopAddress2, city: row.shopCity, state: row.shopState, zip: row.shopZip }),
    shopGeo: row.geocodeSource !== "zip" && validLatLng({ lat: row.shopLat, lng: row.shopLng }) ? { lat: row.shopLat!, lng: row.shopLng! } : null,
    shopDirections: row.shopDirections,
    services: (await tx.select({ name: appointmentItems.name, kind: appointmentItems.kind }).from(appointmentItems).where(eq(appointmentItems.appointmentId, row.id)).orderBy(asc(appointmentItems.kind))).map((i) => i.name),
  };
}

/** A wall-clock time typed by staff. Refuses one that doesn't exist instead of silently moving it an hour. */
export function staffWallTime(date: LocalDate, minutesAfterMidnight: number): Date {
  const dt = existingWallTime(date, minutesAfterMidnight);
  if (!dt) throw new AppError("bad_request", `${minutesToLabel(minutesAfterMidnight % (24 * 60))} doesn't exist on ${date}: clocks spring forward that night`);
  return dt.toJSDate();
}

/** Online changes close at the cutoff itself, so the manage page and the API always agree. */
export const pastCutoff = (now: Date, startsAt: Date, cutoffMinutes: number) => now.getTime() >= startsAt.getTime() - cutoffMinutes * 60_000;

export async function getAppointmentByCode(code: string, now: Date = new Date()) {
  const [row] = await db
    .select({ a: appointments, shop: shops, barberName: staff.displayLabel, barberSlug: staff.publicSlug, customer: customers })
    .from(appointments)
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(eq(appointments.code, code.toUpperCase()));
  if (!row) throw notFound("Appointment");
  row.shop = await withBarberCutoff(row.shop, row.a.staffId);
  const items = await db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, row.a.id)).orderBy(asc(appointmentItems.kind));
  const cutoffAt = new Date(row.a.startsAt.getTime() - row.shop.cancelCutoffMinutes * 60_000);
  const changeable = (ACTIVE_STATUSES as readonly string[]).includes(row.a.status) && row.a.status !== "in_service" && !pastCutoff(now, row.a.startsAt, row.shop.cancelCutoffMinutes);
  return {
    id: row.a.id,
    code: row.a.code,
    status: row.a.status,
    source: row.a.source,
    startsAt: row.a.startsAt.toISOString(),
    endsAt: row.a.endsAt.toISOString(),
    shop: {
      id: row.shop.id,
      slug: row.shop.slug,
      name: row.shop.name,
      address: fullAddress(row.shop),
      phone: row.shop.phone,
      textNumber: row.shop.twilioNumber,
      mapsUrl: mapsUrl(row.shop),
      locationUrl: `${appBaseUrl()}/locations/${row.shop.slug}`,
    },
    barber: { id: row.a.staffId, slug: row.barberSlug, displayName: row.barberName },
    anyBarber: row.a.anyBarber,
    customer: row.customer ? { id: row.customer.id, firstName: row.customer.firstName } : null,
    items: items.map((i) => ({ serviceId: i.serviceId, kind: i.kind, name: i.name, priceCents: i.priceCents, durationMin: i.durationMin })),
    estimateCents: row.a.estimateCents,
    cancelCutoffAt: cutoffAt.toISOString(),
    canCancel: changeable,
    canReschedule: changeable,
  };
}

export type PublicAppointment = Awaited<ReturnType<typeof getAppointmentByCode>>;

/** The shop as its barber is booked there: the barber's own cancellation cutoff in place of the shop's. */
async function withBarberCutoff<T extends Shop>(shop: T, staffId: string, tx: DBorTx = db): Promise<T> {
  const o = (await staffBookingOptions(shop, [staffId], tx)).get(staffId)!;
  return { ...shop, cancelCutoffMinutes: o.cancelCutoffMinutes.value };
}

async function loadForChange(code: string) {
  const a = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()) });
  if (!a) throw notFound("Appointment");
  const shop = await withBarberCutoff(await getShop(a.shopId), a.staffId);
  return { a, shop };
}

export async function cancelAppointment(
  code: string,
  opts: {
    actor: Actor;
    byCustomer: boolean;
    customerId?: string | null;
    reason?: string;
    now?: Date;
    /** A client answering a call-in: their barber can't come, so the online cutoff doesn't apply. */
    ignoreCutoff?: boolean;
  },
) {
  const now = opts.now ?? new Date();
  const { a, shop } = await loadForChange(code);
  if (opts.customerId && a.customerId !== opts.customerId) throw notFound("Appointment");
  if (!(ACTIVE_STATUSES as readonly string[]).includes(a.status)) throw new AppError("conflict", `Appointment is already ${a.status}`);
  if (opts.byCustomer && !opts.ignoreCutoff && pastCutoff(now, a.startsAt, shop.cancelCutoffMinutes)) {
    throw new AppError("cutoff_passed", `Online changes close ${shop.cancelCutoffMinutes} minutes before the appointment. Please call the shop.`);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: now, cancelledBy: opts.byCustomer ? "customer" : "staff", cancelReason: opts.reason?.trim().slice(0, 200) || null })
      .where(eq(appointments.id, a.id));
    await audit(opts.actor, "appointment.cancel", "appointment", a.id, { reason: opts.reason ?? null, byCustomer: opts.byCustomer }, a.shopId, tx);
    if (a.customerId) await scheduleAppointmentNotifications("cancelled", await messageContext(a.id, tx), tx, now);
    await queueStaffAlert("cancel", a.id, { actorStaffId: opts.actor.staffId, now }, tx);
    if (a.groupId) await (await import("./booking-groups")).refreshGroupReminders(a.groupId, tx, now);
  });
  await refreshClientBadges(a.customerId, now);
  return getAppointmentByCode(code, now);
}

export async function rescheduleAppointment(
  code: string,
  opts: {
    startsAt: string | Date;
    barberRef?: string | null;
    actor: Actor;
    byCustomer: boolean;
    customerId?: string | null;
    now?: Date;
    squeezeIn?: boolean;
    /** A client answering a call-in: their barber can't come, so the online cutoff doesn't apply. */
    ignoreCutoff?: boolean;
    /** The caller tells the client itself (call-in outreach): only the reminders are redone. */
    quiet?: boolean;
  },
) {
  const now = opts.now ?? new Date();
  const { a, shop } = await loadForChange(code);
  if (opts.customerId && a.customerId !== opts.customerId) throw notFound("Appointment");
  if (!["booked", "confirmed"].includes(a.status)) throw new AppError("conflict", `Can't reschedule an appointment that is ${a.status}`);
  if (opts.byCustomer && !opts.ignoreCutoff && pastCutoff(now, a.startsAt, shop.cancelCutoffMinutes)) {
    throw new AppError("cutoff_passed", `Online changes close ${shop.cancelCutoffMinutes} minutes before the appointment. Please call the shop.`);
  }
  if (opts.squeezeIn && opts.byCustomer) throw new AppError("forbidden", "Only staff can squeeze in a booking");
  await db.transaction(async (tx) => {
    await moveInTx(a, shop, { ...opts, now }, tx);
    if (!opts.quiet) await queueStaffAlert("reschedule", a.id, { actorStaffId: opts.actor.staffId, now }, tx);
    if (!a.customerId) return;
    if (!a.groupId) return void (await scheduleAppointmentNotifications(opts.quiet ? "reminders" : "rescheduled", await messageContext(a.id, tx), tx, now));
    // One of a family booked together: tell them about this move; the group keeps one set of reminders.
    if (!opts.quiet) await queueAppointmentMessage("reschedule", await messageContext(a.id, tx), tx, now);
    await (await import("./booking-groups")).refreshGroupReminders(a.groupId, tx, now);
  });
  return getAppointmentByCode(code, now);
}

/**
 * Move one appointment inside the caller's transaction: the checks (grid, free time, squeeze) and the
 * update, with no messages. A family moved together runs one per person in a single transaction.
 */
export async function moveInTx(
  a: typeof appointments.$inferSelect,
  shop: Shop,
  opts: { startsAt: string | Date; barberRef?: string | null; actor: Actor; byCustomer: boolean; now: Date; squeezeIn?: boolean },
  tx: DBorTx,
) {
  const now = opts.now;
  const items = await tx.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, a.id));
  const durationMin = totalDuration(items);
  const barberRef = opts.barberRef === undefined ? a.staffId : opts.barberRef;
  const staffOverride = !opts.byCustomer;
  let staffIds: string[];
  if (barberRef && barberRef !== "any") {
    const b = await resolveStaffRef(barberRef);
    if (!b) throw notFound("Barber");
    if (b.id !== a.staffId && !(await shopBarbers(shop.id, { onlineOnly: !staffOverride })).some((x) => x.id === b.id)) throw notFound("Barber at this shop");
    staffIds = [b.id];
  } else {
    staffIds = (await shopBarbers(shop.id, { onlineOnly: !staffOverride })).map((b) => b.id);
  }
  if (opts.squeezeIn && staffIds.length !== 1) throw new AppError("bad_request", "Pick the barber to squeeze the booking in with");
  const start = new Date(opts.startsAt);
  if (Number.isNaN(start.getTime())) throw new AppError("bad_request", "startsAt must be an ISO timestamp");
  const end = new Date(start.getTime() + durationMin * 60_000);
  const date = localDateOf(start);
  if (closedOn(shop, date)) throw new AppError("conflict", shop.status === "archived" ? "This location has closed" : "The shop is closed then");
  const t = start.getTime();
  // The appointment keeps the times it was booked with; only where it may start follows the target barber's grid today.
  const mainServiceId = items.find((i) => i.kind === "service")?.serviceId;
  const increment = mainServiceId ? (await db.select({ n: services.bookingIncrementMin }).from(services).where(eq(services.id, mainServiceId)))[0]?.n : null;
  const intervals = await staffIntervals(shop, staffIds);
  const cleanup = Math.max(0, a.bufferMinutes - shop.bufferMinutes);
  const plans: Record<string, StaffPlan> = Object.fromEntries(
    staffIds.map((id) => [id, { durationMin, intervalMin: increment ?? intervals.get(id)!.minutes, beforeMin: a.bufferBeforeMinutes, afterMin: cleanup, gapMin: a.bufferMinutes - cleanup }]),
  );

  {
    const day = await loadDayInput(shop, date, { durationMin, staffIds, plans, now, ignoreAppointmentId: a.id, staffOverride }, tx);
    let squeeze: string[] | null = null;
    let free: string[];
    if (opts.squeezeIn) {
      const check = squeezeCheck(day, staffIds[0], t);
      if (!check.ok) throw new AppError("slot_unavailable", `Can't squeeze in: ${check.reason.charAt(0).toLowerCase()}${check.reason.slice(1)}`);
      if (check.bypasses.length) squeeze = check.bypasses;
      free = staffIds;
    } else {
      const onGrid = staffIds.filter((id) => onSlotGrid(day, t, id));
      if (!onGrid.length) {
        if (opts.byCustomer) throw new AppError("bad_request", "Pick one of the offered times");
        const b = await db.query.staff.findFirst({ where: eq(staff.id, staffIds[0]), columns: { displayLabel: true } });
        throw new AppError("bad_request", offGridMessage(day, staffIds[0], start, b?.displayLabel, plans[staffIds[0]].intervalMin), { offGrid: true });
      }
      free = onGrid.filter((id) => isSlotFree(day, id, t));
    }
    if (!free.length) throw new AppError("slot_unavailable", "That time isn't available");
    const staffId = free.includes(a.staffId) ? a.staffId : pickBarber(free, day.appointments, date)!;
    try {
      await tx.transaction(async (sp) => {
        await sp.update(appointments).set({ startsAt: start, endsAt: end, staffId, status: "booked", squeezed: squeeze !== null }).where(eq(appointments.id, a.id));
      });
    } catch (e) {
      if (isDoubleBookingError(e)) throw new AppError("slot_unavailable", "That time was just taken");
      throw e;
    }
    await audit(opts.actor, "appointment.reschedule", "appointment", a.id, { from: a.startsAt.toISOString(), to: start.toISOString(), staffId }, a.shopId, tx);
    if (squeeze) {
      const bent = squeeze.map((b) => SQUEEZE_BYPASS_LABEL[b as keyof typeof SQUEEZE_BYPASS_LABEL]);
      await audit(opts.actor, "appointment.squeeze_in", "appointment", a.id, { staffId, startsAt: start.toISOString(), endsAt: end.toISOString(), bypasses: squeeze, bent, moved: true }, a.shopId, tx);
    }
    return { staffId, startsAt: start, endsAt: end };
  }
}

const TRANSITIONS: Record<string, string[]> = {
  booked: ["confirmed", "checked_in", "in_service", "cancelled", "no_show"],
  confirmed: ["checked_in", "in_service", "cancelled", "no_show"],
  checked_in: ["in_service", "cancelled", "no_show", "booked"],
  in_service: ["completed", "checked_in"],
  completed: [],
  cancelled: ["booked"],
  no_show: ["booked"],
};

/**
 * Status changes also record service times: checking in is the arrival, "in the chair" starts the
 * service, and stepping back undoes them. Finishing goes through Finish or checkout.
 */
export async function setAppointmentStatus(id: string, status: keyof typeof TRANSITIONS, actor: Actor, now = new Date()) {
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!a) throw notFound("Appointment");
  if (!TRANSITIONS[a.status]?.includes(status)) throw new AppError("conflict", `Can't move from ${a.status} to ${status}`);
  if (status === "in_service") return startService(id, actor, now);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(appointments)
        .set({
          status: status as typeof a.status,
          checkedInAt: status === "checked_in" ? now : a.checkedInAt,
          completedAt: status === "completed" ? now : a.completedAt,
          cancelledAt: status === "cancelled" ? now : a.cancelledAt,
          cancelledBy: status === "cancelled" ? "staff" : a.cancelledBy,
        })
        .where(eq(appointments.id, id));
      await audit(actor, `appointment.${status}`, "appointment", id, { from: a.status }, a.shopId, tx);
      if (status === "checked_in") {
        await recordArrival(id, actor, tx, now);
        await queueStaffAlert("arrived", id, { actorStaffId: actor.staffId, now }, tx);
      }
      if (status === "booked" && a.status === "checked_in") await clearArrival(id, tx);
      if (status === "checked_in" && a.status === "in_service") await clearStart(id, tx);
      if (status === "cancelled" || status === "no_show") await cancelPendingReminders(id, tx);
      if (status === "cancelled" && a.customerId) await scheduleAppointmentNotifications("cancelled", await messageContext(id, tx), tx, now);
      if (status === "cancelled") await queueStaffAlert("cancel", id, { actorStaffId: actor.staffId, now }, tx);
      if (a.groupId && (status === "cancelled" || status === "no_show" || status === "booked")) await (await import("./booking-groups")).refreshGroupReminders(a.groupId, tx, now);
    });
  } catch (e) {
    if (isDoubleBookingError(e)) throw new AppError("slot_unavailable", "Can't restore: the barber is booked at that time now");
    throw e;
  }
  if (status === "cancelled" || status === "no_show" || status === "booked") await refreshClientBadges(a.customerId, now);
}

// ───────────────────────────── Walk-ins & waitlist ─────────────────────────────

/**
 * One-tap walk-in: seat the customer with the first barber free *right now*
 * (or the requested one). If nobody is free, add them to the waitlist with a quoted wait.
 */
export async function quickWalkIn(input: {
  shopId: string;
  serviceId: string;
  name: string;
  phone?: string | null;
  /** A client found at check-in; otherwise the name and phone find or create one. */
  customerId?: string | null;
  preferredStaffId?: string | null;
  actor: Actor;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const start = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  const known = input.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, input.customerId) }) : null;
  if (input.customerId && !known) throw notFound("Customer");
  const shop = await getShop(input.shopId);
  if (closedOn(shop, localDateOf(now))) throw new AppError("conflict", shop.status === "archived" ? "This location has closed" : "The shop is closed today");
  const [service] = await servicesByIds(shop.id, [input.serviceId]);
  const barbers = await shopBarbers(shop.id);
  const candidates = input.preferredStaffId ? barbers.filter((b) => b.id === input.preferredStaffId) : barbers;
  const plans = toStaffPlans(await bookingPlans(shop, candidates.map((c) => c.id), [service]));
  const day = await loadDayInput(shop, localDateOf(now), { durationMin: service.durationMin, staffIds: candidates.map((c) => c.id), plans, now, staffOverride: true });
  const free = candidates.map((c) => c.id).filter((id) => isSlotFree(day, id, start.getTime()));
  const [firstName, ...rest] = (known ? `${known.firstName} ${known.lastName ?? ""}` : input.name).trim().split(/\s+/);
  if (!firstName) throw new AppError("bad_request", "Add the client's name");
  const customer = { firstName, lastName: rest.join(" ") || null, phone: input.phone || null };

  if (free.length) {
    const staffId = pickBarber(free, day.appointments, localDateOf(now))!;
    const appt = await createAppointment({
      shopRef: shop.id,
      serviceId: service.id,
      barberRef: staffId,
      startsAt: start,
      ...(known ? { customerId: known.id } : { customer }),
      allowNoContact: true,
      source: "walk_in",
      actor: input.actor,
      now,
      silent: true,
    });
    return { seated: true as const, appointment: appt };
  }

  const wait = await estimateWait(shop.id, candidates.map((c) => c.id), now);
  const client = known ?? (await db.transaction((tx) => findOrCreateCustomer(customer, shop.id, tx, { allowNoContact: true, smsOptInIfNew: true })));
  const [entry] = await db
    .insert(waitlistEntries)
    .values({
      shopId: shop.id,
      customerId: client.id,
      name: known ? `${known.firstName} ${known.lastName ?? ""}`.trim() : input.name.trim(),
      phone: known ? known.phone : normalizePhone(input.phone),
      serviceId: service.id,
      preferredStaffId: input.preferredStaffId ?? null,
      quotedWaitMin: wait,
    })
    .returning();
  await audit(input.actor, "waitlist.add", "waitlist", entry.id, { quotedWaitMin: wait }, shop.id);
  return { seated: false as const, entry };
}

/** Rough wait: minutes until the earliest barber's current/next appointment run ends, plus the queue ahead. */
export async function estimateWait(shopId: string, staffIds: string[], now = new Date()): Promise<number> {
  if (!staffIds.length) return 0;
  const busy = await db
    .select({ staffId: appointments.staffId, endsAt: sql<Date>`max(${appointments.endsAt})` })
    .from(appointments)
    .where(
      and(
        inArray(appointments.staffId, staffIds),
        inArray(appointments.status, [...ACTIVE_STATUSES]),
        lt(appointments.startsAt, new Date(now.getTime() + 90 * 60_000)),
        gt(appointments.endsAt, now),
      ),
    )
    .groupBy(appointments.staffId);
  const freeAt = staffIds.map((id) => {
    const b = busy.find((x) => x.staffId === id);
    return b ? Math.max(0, (new Date(b.endsAt).getTime() - now.getTime()) / 60_000) : 0;
  });
  const [{ ahead }] = await db
    .select({ ahead: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.shopId, shopId), eq(waitlistEntries.status, "waiting")));
  const soonest = Math.min(...freeAt);
  return Math.round(soonest + (ahead * 25) / Math.max(1, staffIds.length));
}

export async function waitlistForShop(shopId: string) {
  return db
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.shopId, shopId), or(eq(waitlistEntries.status, "waiting"), eq(waitlistEntries.status, "notified"))))
    .orderBy(asc(waitlistEntries.joinedAt));
}

export async function seatFromWaitlist(entryId: string, staffId: string, actor: Actor, now = new Date()) {
  const entry = await db.query.waitlistEntries.findFirst({ where: eq(waitlistEntries.id, entryId) });
  if (!entry) throw notFound("Waitlist entry");
  if (!entry.serviceId) throw new AppError("bad_request", "Pick a service first");
  const [firstName, ...rest] = entry.name.split(/\s+/);
  const appt = await createAppointment({
    shopRef: entry.shopId,
    serviceId: entry.serviceId,
    barberRef: staffId,
    startsAt: new Date(Math.ceil(now.getTime() / 60_000) * 60_000),
    customerId: entry.customerId,
    customer: entry.customerId ? null : { firstName, lastName: rest.join(" ") || null, phone: entry.phone },
    allowNoContact: true,
    source: "walk_in",
    actor,
    now,
    silent: true,
  });
  await db.update(waitlistEntries).set({ status: "serving", appointmentId: appt.id, updatedAt: now }).where(eq(waitlistEntries.id, entryId));
  await audit(actor, "waitlist.seat", "waitlist", entryId, { appointmentId: appt.id, staffId }, entry.shopId);
  return appt;
}

export async function updateWaitlistStatus(entryId: string, status: "notified" | "left" | "done", actor: Actor) {
  const [e] = await db.update(waitlistEntries).set({ status, updatedAt: new Date() }).where(eq(waitlistEntries.id, entryId)).returning();
  if (e) await audit(actor, `waitlist.${status}`, "waitlist", entryId, {}, e.shopId);
}
