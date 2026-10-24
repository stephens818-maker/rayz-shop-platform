import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { appointmentItems, appointments, bookingGroups, customers, giftCardLedger, giftCards, saleItems, sales, staff } from "@/db/schema";
import {
  GROUP_PLAN_LABEL,
  GroupBookingRequestSchema,
  GroupOptionsRequestSchema,
  GroupPerson,
  GroupPlan,
  GroupRescheduleRequestSchema,
  PersonOpenings,
  PlanResult,
  groupDepositCents,
  groupOptions,
  groupWindow,
  sameTimesOption,
} from "@/domain/booking-group";
import type { FamilySettings } from "@/domain/family";
import { appBaseUrl } from "@/lib/deployment";
import { appointmentCode } from "@/lib/ids";
import { LocalDate, formatDateTime, formatTime, localDateOf } from "@/lib/time";
import { Actor, audit } from "./audit";
import { ACTIVE_STATUSES, bookInTx, dayOpenings, messageContext, moveInTx, pastCutoff, setAppointmentStatus } from "./booking";
import { getShop } from "./catalog";
import { openBlankSale, openSaleForAppointment } from "./checkout";
import { AppError, notFound } from "./errors";
import { householdHead, householdIds, loadFamilySettings } from "./family";
import { addAppointmentToTicket, familyTicketFor } from "./family-ticket";
import { moveReminders, scheduleAppointmentNotifications } from "./notifications/queue";

/**
 * A family booked together: a parent and up to 6 children, each with their own service and barber,
 * seated by one of the plans in src/domain/booking-group.ts. Everyone is booked in one transaction
 * (a seat taken in the meantime books nobody) and linked by one group with one code: one link to
 * cancel or move everyone, one confirmation and one set of reminders, one deposit and one no-show
 * rule. Each person's own appointment link still changes just them.
 */

const OPEN = ["booked", "confirmed"] as const;
const isOpen = (s: string) => (OPEN as readonly string[]).includes(s);
const isActive = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s);

export interface GroupMember {
  id: string;
  code: string;
  customerId: string | null;
  firstName: string | null;
  isChild: boolean;
  status: string;
  startsAt: Date;
  endsAt: Date;
  staffId: string;
  barber: string;
  anyBarber: boolean;
  services: string[];
  serviceId: string | null;
  addonIds: string[];
}

async function membersOf(groupId: string, tx: DBorTx = db): Promise<GroupMember[]> {
  const rows = await tx
    .select({
      id: appointments.id,
      code: appointments.code,
      customerId: appointments.customerId,
      firstName: customers.firstName,
      guardianId: customers.guardianId,
      status: appointments.status,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      staffId: appointments.staffId,
      barber: staff.displayLabel,
      anyBarber: appointments.anyBarber,
    })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(eq(appointments.groupId, groupId))
    .orderBy(asc(appointments.startsAt), asc(appointments.createdAt));
  const items = rows.length
    ? await tx
        .select({ appointmentId: appointmentItems.appointmentId, name: appointmentItems.name, kind: appointmentItems.kind, serviceId: appointmentItems.serviceId })
        .from(appointmentItems)
        .where(inArray(appointmentItems.appointmentId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => {
    const own = items.filter((i) => i.appointmentId === r.id);
    return {
      id: r.id,
      code: r.code,
      customerId: r.customerId,
      firstName: r.firstName,
      isChild: !!r.guardianId,
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      staffId: r.staffId,
      barber: r.barber,
      anyBarber: r.anyBarber,
      services: [...own.filter((i) => i.kind === "service"), ...own.filter((i) => i.kind !== "service")].map((i) => i.name),
      serviceId: own.find((i) => i.kind === "service")?.serviceId ?? null,
      addonIds: own.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!),
    };
  });
}

async function groupByCode(code: string, tx: DBorTx = db) {
  const g = await tx.query.bookingGroups.findFirst({ where: eq(bookingGroups.code, code.trim().toUpperCase()) });
  if (!g) throw notFound("Family booking");
  return g;
}

async function groupById(id: string, tx: DBorTx = db) {
  const g = await tx.query.bookingGroups.findFirst({ where: eq(bookingGroups.id, id) });
  if (!g) throw notFound("Family booking");
  return g;
}

async function lockGroup(id: string, tx: DBorTx) {
  const [g] = await tx.select().from(bookingGroups).where(eq(bookingGroups.id, id)).for("update");
  if (!g) throw notFound("Family booking");
  return g;
}

/** The signed-in parent's own group (or a child's, through their parent); anyone else gets a 404. */
async function assertGuardian(g: { guardianId: string }, customerId: string | null | undefined) {
  if (!customerId) return;
  if ((await householdHead(customerId)) !== g.guardianId) throw notFound("Family booking");
}

/** Everyone must be on the parent's account, once each. Returns the head of the household. */
async function assertHousehold(guardianId: string, people: readonly { customerId: string }[]) {
  const members = new Set(await householdIds(guardianId));
  if (people.some((p) => !members.has(p.customerId))) throw new AppError("not_found", "That person isn't on this account");
  if (new Set(people.map((p) => p.customerId)).size !== people.length) throw new AppError("bad_request", "Each person can be booked once");
  return householdHead(guardianId);
}

// ───────────────────────────── Options ─────────────────────────────

export interface GroupOptionView {
  plan: GroupPlan;
  label: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
  barbers: number;
  seats: { customerId: string; firstName: string | null; staffId: string; barber: string; startsAt: string; endsAt: string }[];
}
export interface GroupOptionsView {
  plans: { plan: GroupPlan; label: string; options: GroupOptionView[]; reason: string | null }[];
  depositCents: number;
}

async function present(results: PlanResult[], dayReason: string | null, people: readonly GroupPerson[], settings: FamilySettings): Promise<GroupOptionsView> {
  const staffIds = [...new Set(results.flatMap((r) => r.options.flatMap((o) => o.seats.map((s) => s.staffId))))];
  const names = new Map(
    (await db.select({ id: customers.id, firstName: customers.firstName }).from(customers).where(inArray(customers.id, people.map((p) => p.customerId)))).map((c) => [c.id, c.firstName]),
  );
  const barbers = new Map(staffIds.length ? (await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, staffIds))).map((s) => [s.id, s.label]) : []);
  const iso = (t: number) => new Date(t).toISOString();
  return {
    plans: results.map((r) => ({
      plan: r.plan,
      label: GROUP_PLAN_LABEL[r.plan],
      reason: r.options.length ? null : (dayReason ?? r.reason),
      options: r.options.map((o) => ({
        plan: o.plan,
        label: GROUP_PLAN_LABEL[o.plan],
        startsAt: iso(o.start),
        endsAt: iso(o.end),
        minutes: o.minutes,
        barbers: o.barbers,
        seats: o.seats.map((s) => ({ customerId: s.customerId, firstName: names.get(s.customerId) ?? null, staffId: s.staffId, barber: barbers.get(s.staffId) ?? "Barber", startsAt: iso(s.start), endsAt: iso(s.end) })),
      })),
    })),
    depositCents: groupDepositCents(settings, people.length),
  };
}

async function optionsFor(
  shopRef: string,
  date: LocalDate,
  people: readonly GroupPerson[],
  o: { staff: boolean; now: Date; after?: number; ignoreAppointmentIds?: readonly string[] },
): Promise<{ results: PlanResult[]; view: GroupOptionsView }> {
  const days = await Promise.all(
    people.map((p) =>
      dayOpenings({ shopRef, date, serviceId: p.serviceId, addonIds: p.addonIds, barberRef: p.staffId ?? "any", now: o.now, staffOverride: o.staff, ignoreAppointmentIds: o.ignoreAppointmentIds }),
    ),
  );
  const persons: PersonOpenings[] = people.map((p, i) => ({ customerId: p.customerId, openings: days[i].openings }));
  const results = groupOptions(persons, o.after ?? 0);
  const closed = days.find((d) => d.reason && d.reason !== "No openings on this day")?.reason ?? null;
  return { results, view: await present(results, closed, people, await loadFamilySettings()) };
}

/** Ways to seat everyone on one day: back to back with one barber, together with several, or done soonest. */
export async function planGroup(raw: unknown, o: { guardianId: string; staff?: boolean; now?: Date }): Promise<GroupOptionsView> {
  const req = GroupOptionsRequestSchema.parse(raw);
  await assertHousehold(o.guardianId, req.people);
  const after = req.after ? Date.parse(req.after) : 0;
  if (Number.isNaN(after)) throw new AppError("bad_request", "after must be an ISO timestamp");
  return (await optionsFor(req.shopId, req.date, req.people, { staff: !!o.staff, now: o.now ?? new Date(), after })).view;
}

// ───────────────────────────── Booking ─────────────────────────────

/**
 * Book everyone in the option picked, in one transaction. When someone's seat was taken in the
 * meantime nothing is kept: if the same plan still seats everyone at the same times (with another
 * barber for someone who didn't ask for one), that's booked instead; otherwise the error carries
 * the day's options that still work (`details.alternatives`).
 */
export async function bookGroup(
  raw: unknown,
  o: {
    guardianId: string;
    source: "online" | "api" | "staff";
    actor: Actor;
    now?: Date;
    idempotencyKey?: string | null;
    /** Staff with "Squeeze in" (checked by the caller): these people may be booked off the grid. */
    squeeze?: string[];
  },
): Promise<GroupView> {
  if (o.squeeze?.length && o.source !== "staff") throw new AppError("forbidden", "Only staff can squeeze in a booking");
  const req = GroupBookingRequestSchema.parse(raw);
  const now = o.now ?? new Date();
  if (o.idempotencyKey) {
    const prior = await db.query.bookingGroups.findFirst({ where: eq(bookingGroups.idempotencyKey, o.idempotencyKey) });
    if (prior) return groupView(prior.code, now);
  }
  const head = await assertHousehold(o.guardianId, req.people);
  const wanted = new Set(req.people.map((p) => p.customerId));
  if (req.seats.length !== req.people.length || req.seats.some((s) => !wanted.has(s.customerId)) || new Set(req.seats.map((s) => s.customerId)).size !== req.seats.length) {
    throw new AppError("bad_request", "Pick one time for each person");
  }
  const shop = await getShop(req.shopId);
  const settings = await loadFamilySettings();
  const deposit = groupDepositCents(settings, req.people.length);
  let seats = req.seats;
  for (let attempt = 0; ; attempt++) {
    try {
      const code = await db.transaction(async (tx) => {
        const [g] = await tx
          .insert(bookingGroups)
          .values({
            code: appointmentCode(),
            shopId: shop.id,
            guardianId: head,
            plan: req.plan,
            source: o.source,
            depositCents: deposit,
            depositStatus: deposit ? "due" : "none",
            idempotencyKey: o.idempotencyKey ?? null,
            createdBy: o.actor.staffId ?? null,
          })
          .returning();
        for (const p of req.people) {
          const s = seats.find((x) => x.customerId === p.customerId)!;
          await bookInTx(
            { shopRef: shop.id, serviceId: p.serviceId, addonIds: p.addonIds, barberRef: s.staffId, startsAt: s.startsAt, customerId: p.customerId, source: o.source, notes: p.notes ?? null, actor: o.actor, now, silent: true, groupId: g.id, squeezeIn: !!o.squeeze?.includes(p.customerId) },
            tx,
          );
        }
        await audit(o.actor, "booking_group.create", "booking_group", g.id, { code: g.code, plan: req.plan, people: req.people.length, depositCents: deposit, retried: attempt > 0 }, shop.id, tx);
        await groupNotice(g.id, "created", tx, now);
        return g.code;
      });
      await refreshBadges(req.people.map((p) => p.customerId), now);
      return groupView(code, now);
    } catch (e) {
      if (o.idempotencyKey && isUniqueViolation(e, "booking_groups_idempotency_key_unique")) {
        const prior = await db.query.bookingGroups.findFirst({ where: eq(bookingGroups.idempotencyKey, o.idempotencyKey) });
        if (prior) return groupView(prior.code, now);
      }
      if (!(e instanceof AppError) || e.code !== "slot_unavailable") throw e;
      const first = Math.min(...seats.map((s) => Date.parse(s.startsAt)));
      const alt = await optionsFor(shop.id, localDateOf(new Date(first)), req.people, { staff: o.source === "staff", now });
      const plan = req.plan === "custom" ? null : req.plan;
      const same = attempt === 0 && plan ? sameTimesOption(seats.map((s) => ({ customerId: s.customerId, start: Date.parse(s.startsAt) })), alt.results, plan) : null;
      if (same) {
        seats = same.seats.map((s) => ({ customerId: s.customerId, staffId: s.staffId, startsAt: new Date(s.start).toISOString() }));
        continue;
      }
      throw new AppError("slot_unavailable", "Someone's time was just taken, so nothing was booked. These times still work for everyone.", { alternatives: alt.view });
    }
  }
}

function isUniqueViolation(e: unknown, constraint: string) {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = err?.code === "23505" ? err : err?.cause?.code === "23505" ? err.cause : null;
  return !!c && c.constraint === constraint;
}

async function refreshBadges(ids: string[], now: Date) {
  await import("./badges")
    .then((b) => b.refreshBadges([...new Set(ids)], now))
    .catch((e: Error) => console.error("badge refresh after a family booking change failed", e.message));
}

/** Seat the desk's walk-ins from one family together, so they check in and pay as one. */
export async function linkWalkIns(appointmentIds: string[], actor: Actor) {
  const ids = [...new Set(appointmentIds)];
  if (ids.length < 2) return null;
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(appointments).where(inArray(appointments.id, ids)).for("update");
    if (rows.length !== ids.length || rows.some((r) => !r.customerId || r.groupId)) throw new AppError("bad_request", "These walk-ins can't be linked");
    if (new Set(rows.map((r) => r.shopId)).size > 1) throw new AppError("bad_request", "These walk-ins are at different shops");
    const head = await householdHead(rows[0].customerId!, tx);
    const household = new Set(await householdIds(head, tx));
    if (rows.some((r) => !household.has(r.customerId!))) throw new AppError("bad_request", "Only one family's walk-ins can be linked");
    const [g] = await tx.insert(bookingGroups).values({ code: appointmentCode(), shopId: rows[0].shopId, guardianId: head, plan: "walk_in", source: "walk_in", createdBy: actor.staffId ?? null }).returning();
    await tx.update(appointments).set({ groupId: g.id }).where(inArray(appointments.id, ids));
    await audit(actor, "booking_group.create", "booking_group", g.id, { code: g.code, plan: "walk_in", people: ids.length }, g.shopId, tx);
    return g.code;
  });
}

// ───────────────────────────── The one set of messages ─────────────────────────────

const joinAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

async function mergeFor(g: { code: string; guardianId: string }, people: GroupMember[], tx: DBorTx, cancelled = false) {
  const [parent] = await tx.select({ firstName: customers.firstName }).from(customers).where(eq(customers.id, g.guardianId));
  const byBarber = new Map<string, string[]>();
  for (const m of people) byBarber.set(m.barber, [...(byBarber.get(m.barber) ?? []), m.firstName ?? "guest"]);
  const span = groupWindow(people.map((m) => ({ start: m.startsAt.getTime(), end: m.endsAt.getTime() })));
  return {
    first_name: parent?.firstName ?? "there",
    barber: joinAnd([...byBarber].map(([b, names]) => `${b} (${names.join(", ")})`)),
    when: cancelled ? `${formatDateTime(span.start)} family` : `${formatDateTime(span.start)} (everyone done by ${formatTime(span.end)})`,
    link: `${appBaseUrl()}/g/${g.code}`,
  };
}

/**
 * The group's one confirmation, move notice or cancellation, sent about whoever is first, naming
 * everyone and linking the group. Reminders follow the same way: one set for the group.
 */
async function groupNotice(groupId: string, event: "created" | "rescheduled" | "cancelled", tx: DBorTx, now: Date, onlyIds?: string[]) {
  const g = await groupById(groupId, tx);
  const all = await membersOf(groupId, tx);
  const pool = all.filter((m) => (onlyIds ? onlyIds.includes(m.id) : event === "cancelled" ? m.status === "cancelled" : isOpen(m.status)));
  await moveReminders(all.map((m) => m.id), null, tx, now);
  const lead = pool[0];
  if (!lead?.customerId) return;
  await scheduleAppointmentNotifications(event, await messageContext(lead.id, tx), tx, now, await mergeFor(g, pool, tx, event === "cancelled"));
}

/**
 * After one person in a group is cancelled, moved or restored: the group's reminders move to whoever
 * is now first, naming everyone still booked. Called by src/server/booking.ts.
 */
export async function refreshGroupReminders(groupId: string, tx: DBorTx = db, now: Date = new Date()) {
  const g = await groupById(groupId, tx);
  const all = await membersOf(groupId, tx);
  const open = all.filter((m) => isOpen(m.status) && m.customerId);
  const lead = open[0];
  await moveReminders(all.map((m) => m.id), lead ? await messageContext(lead.id, tx) : null, tx, now, lead ? await mergeFor(g, open, tx) : undefined);
}

// ───────────────────────────── The group's page ─────────────────────────────

export type GroupStatus = "booked" | "partly_cancelled" | "cancelled" | "done";

export async function groupView(code: string, now: Date = new Date()) {
  const g = await syncRefund(await groupByCode(code));
  const shop = await getShop(g.shopId);
  const ms = await membersOf(g.id);
  const active = ms.filter((m) => isActive(m.status));
  const open = ms.filter((m) => isOpen(m.status));
  const shown = active.length ? active : ms;
  const span = shown.length ? groupWindow(shown.map((m) => ({ start: m.startsAt.getTime(), end: m.endsAt.getTime() }))) : { start: g.createdAt.getTime(), end: g.createdAt.getTime(), minutes: 0 };
  const cutoffAt = new Date(span.start - shop.cancelCutoffMinutes * 60_000);
  const status: GroupStatus = !active.length ? (ms.some((m) => m.status === "completed") ? "done" : "cancelled") : ms.some((m) => m.status === "cancelled") ? "partly_cancelled" : "booked";
  const canChange = open.length > 0 && open.length === active.length && !pastCutoff(now, new Date(span.start), shop.cancelCutoffMinutes);
  return {
    id: g.id,
    guardianId: g.guardianId,
    code: g.code,
    plan: g.plan,
    shop: { id: shop.id, slug: shop.slug, name: shop.name, phone: shop.phone, address: [shop.address, shop.city, [shop.state, shop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") },
    startsAt: new Date(span.start).toISOString(),
    endsAt: new Date(span.end).toISOString(),
    minutes: span.minutes,
    status,
    canCancel: canChange,
    canReschedule: canChange,
    cancelCutoffAt: cutoffAt.toISOString(),
    deposit: { cents: g.depositCents, status: g.depositStatus },
    members: ms.map((m) => ({
      appointmentId: m.id,
      appointmentCode: m.code,
      customerId: m.customerId,
      firstName: m.firstName,
      isChild: m.isChild,
      status: m.status,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      barber: { id: m.staffId, displayName: m.barber },
      services: m.services,
      canChange: isOpen(m.status) && !pastCutoff(now, m.startsAt, shop.cancelCutoffMinutes),
    })),
  };
}
export type GroupView = Awaited<ReturnType<typeof groupView>>;

/** The group as the public API shows it (src/domain/booking-group.ts BookingGroupSchema). */
export function publicGroup(v: GroupView) {
  const { id: _id, guardianId: _g, shop, members, ...rest } = v;
  return { ...rest, shop: { id: shop.id, slug: shop.slug, name: shop.name }, members: members.map(({ appointmentId: _a, ...m }) => m) };
}

/** The group an appointment belongs to, by the appointment's code, for linking /a/{code} to /g/{code}. */
export async function groupCodeOf(appointmentCode: string): Promise<string | null> {
  const [row] = await db
    .select({ code: bookingGroups.code })
    .from(appointments)
    .innerJoin(bookingGroups, eq(bookingGroups.id, appointments.groupId))
    .where(eq(appointments.code, appointmentCode.trim().toUpperCase()))
    .limit(1);
  return row?.code ?? null;
}

/** A signed-in parent's group, by its code. */
export async function myGroup(code: string, customerId: string, now = new Date()) {
  await assertGuardian(await groupByCode(code), customerId);
  return groupView(code, now);
}

/** A family's upcoming groups, for the parent's account page and the app. */
export async function upcomingGroups(customerId: string, now = new Date()) {
  const head = await householdHead(customerId);
  const rows = await db
    .selectDistinct({ code: bookingGroups.code })
    .from(bookingGroups)
    .innerJoin(appointments, eq(appointments.groupId, bookingGroups.id))
    .where(and(eq(bookingGroups.guardianId, head), inArray(appointments.status, [...ACTIVE_STATUSES])));
  const views = await Promise.all(rows.map((r) => groupView(r.code, now)));
  return views.filter((v) => new Date(v.endsAt) >= now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// ───────────────────────────── Cancel and move everyone ─────────────────────────────

/**
 * Cancel everyone still booked, with one cancellation message. Online, it closes at the cutoff before
 * the first person's time, like a single booking. The group's deposit follows its rule: nothing taken
 * is waived; one taken is kept on a late cancel when the brand forfeits it, and is due back otherwise.
 */
export async function cancelGroup(code: string, o: { actor: Actor; byCustomer: boolean; customerId?: string | null; reason?: string; now?: Date }) {
  const now = o.now ?? new Date();
  const found = await groupByCode(code);
  await assertGuardian(found, o.customerId);
  const shop = await getShop(found.shopId);
  const settings = await loadFamilySettings();
  const people = await db.transaction(async (tx) => {
    const g = await lockGroup(found.id, tx);
    const ms = await membersOf(g.id, tx);
    const going = ms.filter((m) => isOpen(m.status) || m.status === "checked_in");
    if (!going.length) throw new AppError("conflict", "Nobody in this booking is still booked");
    const first = new Date(Math.min(...going.map((m) => m.startsAt.getTime())));
    const late = pastCutoff(now, first, shop.cancelCutoffMinutes);
    if (o.byCustomer) {
      if (ms.some((m) => m.status === "checked_in" || m.status === "in_service")) throw new AppError("conflict", "Some of the group are already at the shop. Please talk to the front desk.");
      if (late) throw new AppError("cutoff_passed", `Online changes close ${shop.cancelCutoffMinutes} minutes before the first appointment. Please call the shop.`);
    }
    const ids = going.map((m) => m.id);
    await tx.update(appointments).set({ status: "cancelled", cancelledAt: now, cancelledBy: o.byCustomer ? "customer" : "staff" }).where(inArray(appointments.id, ids));
    for (const id of ids) await audit(o.actor, "appointment.cancel", "appointment", id, { reason: o.reason ?? null, byCustomer: o.byCustomer, group: g.code }, g.shopId, tx);
    const stillHere = ms.some((m) => m.status === "in_service");
    if (!stillHere) await tx.update(bookingGroups).set({ cancelledAt: now }).where(eq(bookingGroups.id, g.id));
    const deposit = await depositOnCancel(g, late, settings, o.actor, tx);
    await audit(o.actor, "booking_group.cancel", "booking_group", g.id, { people: ids.length, late, byCustomer: o.byCustomer, deposit }, g.shopId, tx);
    await groupNotice(g.id, "cancelled", tx, now, ids);
    return going.map((m) => m.customerId).filter((x): x is string => !!x);
  });
  await refreshBadges(people, now);
  return groupView(found.code, now);
}

async function depositOnCancel(g: typeof bookingGroups.$inferSelect, late: boolean, s: FamilySettings, actor: Actor, tx: DBorTx) {
  if (g.depositStatus === "due") {
    await tx.update(bookingGroups).set({ depositStatus: "waived" }).where(eq(bookingGroups.id, g.id));
    return "waived";
  }
  if (g.depositStatus !== "held") return g.depositStatus;
  if (late && s.groupNoShowForfeit) return (await forfeitDeposit(g, actor, tx)) ? "forfeited" : g.depositStatus;
  await tx.update(bookingGroups).set({ depositStatus: "refund_due" }).where(eq(bookingGroups.id, g.id));
  return "refund_due";
}

/** Options for moving everyone still booked to another day or time; their current seats count as free. */
export async function groupRescheduleOptions(code: string, date: LocalDate, o: { customerId?: string | null; staff: boolean; now?: Date; after?: string | null }) {
  const g = await groupByCode(code);
  await assertGuardian(g, o.customerId);
  const ms = await membersOf(g.id);
  const open = ms.filter((m) => isOpen(m.status) && m.customerId && m.serviceId);
  if (!open.length) throw new AppError("conflict", "Nobody in this booking is still booked");
  const people: GroupPerson[] = open.map((m) => ({ customerId: m.customerId!, serviceId: m.serviceId!, addonIds: m.addonIds, staffId: m.anyBarber ? null : m.staffId }));
  const after = o.after ? Date.parse(o.after) : 0;
  return (await optionsFor(g.shopId, date, people, { staff: o.staff, now: o.now ?? new Date(), after: Number.isNaN(after) ? 0 : after, ignoreAppointmentIds: ms.map((m) => m.id) })).view;
}

/**
 * Move everyone still booked to the option picked, in one transaction: their old seats are let go
 * first, so the group can swap barbers or shift within its own time. All or nothing, like booking.
 */
export async function rescheduleGroup(code: string, raw: unknown, o: { actor: Actor; byCustomer: boolean; customerId?: string | null; now?: Date }) {
  const req = GroupRescheduleRequestSchema.parse(raw);
  const now = o.now ?? new Date();
  const found = await groupByCode(code);
  await assertGuardian(found, o.customerId);
  const shop = await getShop(found.shopId);
  try {
    await db.transaction(async (tx) => {
      const g = await lockGroup(found.id, tx);
      const ms = await membersOf(g.id, tx);
      const open = ms.filter((m) => isOpen(m.status));
      if (!open.length) throw new AppError("conflict", "Nobody in this booking is still booked");
      if (ms.some((m) => m.status === "checked_in" || m.status === "in_service")) throw new AppError("conflict", "Some of the group are already at the shop");
      const seatFor = new Map(req.seats.map((s) => [s.customerId, s]));
      if (seatFor.size !== req.seats.length || seatFor.size !== open.length || open.some((m) => !m.customerId || !seatFor.has(m.customerId))) {
        throw new AppError("bad_request", "Pick a new time for each person still booked");
      }
      const first = new Date(Math.min(...open.map((m) => m.startsAt.getTime())));
      if (o.byCustomer && pastCutoff(now, first, shop.cancelCutoffMinutes)) {
        throw new AppError("cutoff_passed", `Online changes close ${shop.cancelCutoffMinutes} minutes before the first appointment. Please call the shop.`);
      }
      const ids = open.map((m) => m.id);
      const rows = await tx.select().from(appointments).where(inArray(appointments.id, ids)).for("update");
      await tx.update(appointments).set({ status: "cancelled" }).where(inArray(appointments.id, ids));
      for (const a of rows) {
        const s = seatFor.get(a.customerId!)!;
        await moveInTx(a, shop, { startsAt: s.startsAt, barberRef: s.staffId, actor: o.actor, byCustomer: o.byCustomer, now }, tx);
      }
      await tx.update(bookingGroups).set({ plan: req.plan }).where(eq(bookingGroups.id, g.id));
      await audit(o.actor, "booking_group.reschedule", "booking_group", g.id, { people: ids.length, plan: req.plan, from: first.toISOString() }, g.shopId, tx);
      await groupNotice(g.id, "rescheduled", tx, now);
    });
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== "slot_unavailable") throw e;
    const first = Math.min(...req.seats.map((s) => Date.parse(s.startsAt)));
    const alternatives = await groupRescheduleOptions(found.code, localDateOf(new Date(first)), { staff: !o.byCustomer, now });
    throw new AppError("slot_unavailable", "Someone's new time was just taken, so nobody was moved. These times still work for everyone.", { alternatives });
  }
  return groupView(found.code, now);
}

// ───────────────────────────── At the shop ─────────────────────────────

/** Check in everyone in the group who's still booked. Returns how many. */
export async function checkInGroup(groupId: string, actor: Actor, now = new Date()) {
  const g = await groupById(groupId);
  const due = (await membersOf(g.id)).filter((m) => isOpen(m.status));
  if (!due.length) throw new AppError("conflict", "Everyone in this booking is already checked in or closed");
  for (const m of due) await setAppointmentStatus(m.id, "checked_in", actor, now);
  await audit(actor, "booking_group.check_in", "booking_group", g.id, { people: due.length }, g.shopId);
  return due.length;
}

async function openTicketOf(appointmentId: string) {
  const t = await familyTicketFor(appointmentId, db);
  if (!t) return null;
  const s = await db.query.sales.findFirst({ where: eq(sales.id, t), columns: { id: true, status: true } });
  return s ?? null;
}

/**
 * One ticket for the whole group: the parent's (or the first person's) ticket, with everyone else's
 * services added as lines tagged to their appointment and barber, so the tip splits per barber.
 * A ticket one of them already has open becomes the group's ticket.
 */
export async function openGroupTicket(groupId: string, actor: Actor): Promise<string> {
  const g = await groupById(groupId);
  const live = (await membersOf(g.id)).filter((m) => isActive(m.status));
  if (!live.length) throw new AppError("conflict", "Nobody in this booking is still booked");
  let saleId: string | null = null;
  for (const m of live) {
    const t = await openTicketOf(m.id);
    if (t?.status === "open") {
      saleId = t.id;
      break;
    }
  }
  if (!saleId) saleId = (await openSaleForAppointment((live.find((m) => m.customerId === g.guardianId) ?? live[0]).id, actor)).id;
  for (const m of live) if (!(await openTicketOf(m.id))) await addAppointmentToTicket(saleId, m.id, actor);
  await audit(actor, "booking_group.ticket", "booking_group", g.id, { saleId, people: live.length, split: false }, g.shopId);
  return saleId;
}

/** A ticket each: everyone pays for their own, with their own barber's tip. */
export async function openGroupSplitTickets(groupId: string, actor: Actor) {
  const g = await groupById(groupId);
  const live = (await membersOf(g.id)).filter((m) => isActive(m.status));
  if (!live.length) throw new AppError("conflict", "Nobody in this booking is still booked");
  const out: { appointmentId: string; firstName: string | null; saleId: string }[] = [];
  for (const m of live) {
    const existing = await openTicketOf(m.id);
    out.push({ appointmentId: m.id, firstName: m.firstName, saleId: existing?.id ?? (await openSaleForAppointment(m.id, actor)).id });
  }
  await audit(actor, "booking_group.ticket", "booking_group", g.id, { people: live.length, split: true }, g.shopId);
  return out;
}

/**
 * The group didn't come: everyone not yet arrived is a no-show, in one go. When nobody came at all the
 * group's deposit is kept under the brand's rule (once, for the group). When some came, only the rest
 * are marked and the deposit stays for the ticket.
 */
export async function groupNoShow(groupId: string, actor: Actor, now = new Date()) {
  const g0 = await groupById(groupId);
  const ms = await membersOf(g0.id);
  const missing = ms.filter((m) => isOpen(m.status));
  if (!missing.length) throw new AppError("conflict", "Everyone in this booking has arrived or is closed");
  for (const m of missing) await setAppointmentStatus(m.id, "no_show", actor, now);
  const arrived = ms.some((m) => ["checked_in", "in_service", "completed"].includes(m.status));
  const settings = await loadFamilySettings();
  const forfeitedCents = await db.transaction(async (tx) => {
    const g = await lockGroup(g0.id, tx);
    const kept = !arrived && g.depositStatus === "held" && settings.groupNoShowForfeit ? await forfeitDeposit(g, actor, tx) : 0;
    await audit(actor, "booking_group.no_show", "booking_group", g.id, { people: missing.length, wholeGroup: !arrived, forfeitedCents: kept }, g.shopId, tx);
    return kept;
  });
  return { noShows: missing.length, wholeGroup: !arrived, forfeitedCents };
}

// ───────────────────────────── The one deposit ─────────────────────────────

/**
 * Take the group's deposit at the desk: a ticket for the parent with one deposit line, paid like any
 * ticket (cash or card). Paying it issues a card held as the group's deposit (onSalePaid).
 */
export async function startGroupDeposit(groupId: string, actor: Actor): Promise<string> {
  const g = await groupById(groupId);
  if (g.depositStatus !== "due" || g.depositCents <= 0) throw new AppError("conflict", "This booking has no deposit to take");
  if (g.depositSaleId) {
    const s = await db.query.sales.findFirst({ where: eq(sales.id, g.depositSaleId), columns: { id: true, status: true } });
    if (s?.status === "open") return s.id;
  }
  const sale = await openBlankSale(g.shopId, actor);
  await db.transaction(async (tx) => {
    await tx.update(sales).set({ customerId: g.guardianId }).where(eq(sales.id, sale.id));
    await tx.insert(saleItems).values({ saleId: sale.id, kind: "gift_card", name: depositLineName(g.code), qty: 1, unitPriceCents: g.depositCents, grossCents: g.depositCents, netCents: g.depositCents });
    await tx.update(bookingGroups).set({ depositSaleId: sale.id }).where(eq(bookingGroups.id, g.id));
    await audit(actor, "booking_group.deposit_ticket", "booking_group", g.id, { saleId: sale.id, cents: g.depositCents }, g.shopId, tx);
  });
  return sale.id;
}

export const depositLineName = (code: string) => `Deposit: family booking ${code}`;

/**
 * Inside finalizeSale's transaction, once a ticket is paid: a deposit ticket's card becomes the
 * group's held deposit, and a group whose deposit this ticket used up is marked applied.
 */
export async function onSalePaid(saleId: string, tx: DBorTx) {
  const pending = await tx.select().from(bookingGroups).where(and(eq(bookingGroups.depositSaleId, saleId), eq(bookingGroups.depositStatus, "due")));
  for (const g of pending) {
    const [card] = await tx
      .select({ id: giftCards.id, cents: giftCards.initialCents })
      .from(giftCards)
      .innerJoin(saleItems, eq(saleItems.id, giftCards.saleItemId))
      .where(eq(saleItems.saleId, saleId))
      .limit(1);
    if (!card) continue;
    await tx.update(giftCards).set({ source: "deposit", customerId: g.guardianId }).where(eq(giftCards.id, card.id));
    await tx.update(bookingGroups).set({ depositStatus: "held", depositGiftCardId: card.id, depositCents: card.cents }).where(eq(bookingGroups.id, g.id));
  }
  const used = await tx
    .select({ id: bookingGroups.id, balance: giftCards.balanceCents })
    .from(giftCardLedger)
    .innerJoin(bookingGroups, eq(bookingGroups.depositGiftCardId, giftCardLedger.giftCardId))
    .innerJoin(giftCards, eq(giftCards.id, giftCardLedger.giftCardId))
    .where(and(eq(giftCardLedger.saleId, saleId), eq(giftCardLedger.kind, "redeem"), ne(bookingGroups.depositStatus, "applied")));
  for (const u of used) if (u.balance <= 0) await tx.update(bookingGroups).set({ depositStatus: "applied" }).where(eq(bookingGroups.id, u.id));
}

/** Keep the held deposit: its card is emptied and voided, logged as a forfeit. Returns the amount kept. */
async function forfeitDeposit(g: typeof bookingGroups.$inferSelect, actor: Actor, tx: DBorTx): Promise<number> {
  if (!g.depositGiftCardId) return 0;
  const [card] = await tx.select().from(giftCards).where(eq(giftCards.id, g.depositGiftCardId)).for("update");
  const cents = card && card.status === "active" ? card.balanceCents : 0;
  if (card && cents > 0) {
    await tx.update(giftCards).set({ balanceCents: 0, status: "void" }).where(eq(giftCards.id, card.id));
    await tx.insert(giftCardLedger).values({ giftCardId: card.id, deltaCents: -cents, kind: "forfeit", staffId: actor.staffId ?? null });
  }
  await tx.update(bookingGroups).set({ depositStatus: "forfeited" }).where(eq(bookingGroups.id, g.id));
  await audit(actor, "booking_group.deposit_forfeit", "booking_group", g.id, { cents }, g.shopId, tx);
  return cents;
}

/** A held or owed deposit whose card was refunded at the POS (which voids the card) is refunded. */
async function syncRefund(g: typeof bookingGroups.$inferSelect) {
  if (!g.depositGiftCardId || (g.depositStatus !== "held" && g.depositStatus !== "refund_due")) return g;
  const card = await db.query.giftCards.findFirst({ where: eq(giftCards.id, g.depositGiftCardId), columns: { status: true } });
  if (card?.status !== "void") return g;
  const [u] = await db.update(bookingGroups).set({ depositStatus: "refunded" }).where(eq(bookingGroups.id, g.id)).returning();
  return u;
}

/**
 * The deposit a ticket can use: held for a group one of the ticket's appointments belongs to, with
 * its card's code and what's left on it. The POS offers it as the ticket's gift card payment.
 */
export async function depositForTicket(appointmentIds: string[]) {
  if (!appointmentIds.length) return null;
  const [row] = await db
    .select({ groupCode: bookingGroups.code, code: giftCards.code, balanceCents: giftCards.balanceCents })
    .from(appointments)
    .innerJoin(bookingGroups, eq(bookingGroups.id, appointments.groupId))
    .innerJoin(giftCards, eq(giftCards.id, bookingGroups.depositGiftCardId))
    .where(and(inArray(appointments.id, appointmentIds), eq(bookingGroups.depositStatus, "held"), eq(giftCards.status, "active")))
    .limit(1);
  return row && row.balanceCents > 0 ? row : null;
}

// ───────────────────────────── The calendar ─────────────────────────────

/** For the desk: each group's code, who's in it and its deposit, for the appointments shown. */
export async function groupsForCalendar(groupIds: string[]) {
  const ids = [...new Set(groupIds)];
  if (!ids.length) return {};
  const groups = await db.select().from(bookingGroups).where(inArray(bookingGroups.id, ids));
  const out: Record<string, { code: string; plan: string; deposit: { cents: number; status: string; saleId: string | null }; members: { appointmentId: string; firstName: string | null; status: string; startsAt: string; barber: string }[] }> = {};
  for (const g of groups) {
    const ms = await membersOf(g.id);
    out[g.id] = {
      code: g.code,
      plan: g.plan,
      deposit: { cents: g.depositCents, status: g.depositStatus, saleId: g.depositSaleId },
      members: ms.map((m) => ({ appointmentId: m.id, firstName: m.firstName, status: m.status, startsAt: m.startsAt.toISOString(), barber: m.barber })),
    };
  }
  return out;
}
