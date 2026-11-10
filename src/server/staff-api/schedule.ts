import "server-only";
import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, sales, shops, staff, staffSchedules } from "@/db/schema";
import { clientName } from "@/domain/client-privacy";
import { scheduledOn } from "@/domain/time-clock";
import { LocalDate, addDays, diffDays, endOfLocalDay, isValidLocalDate, startOfLocalDay, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";
import { assertShopAccess, can, reasonViewer } from "@/server/auth/staff";
import { shownBadges } from "@/server/badges";
import { listNotes, addNote } from "@/server/client-notes";
import { clientPolicy, recordClientAccess } from "@/server/client-privacy";
import { AppError, forbidden, notFound } from "@/server/errors";
import { staffingFor } from "@/server/staff-time";
import type { StaffAppContext } from "./http";

/** Days one request may cover. */
export const MAX_DAYS = 62;

const STATUSES = {
  all: null,
  upcoming: ["booked", "confirmed", "checked_in", "in_service"],
  completed: ["completed"],
  missed: ["cancelled", "no_show"],
} as const;
export type AppointmentStatusFilter = keyof typeof STATUSES;
export const STATUS_FILTERS = Object.keys(STATUSES) as AppointmentStatusFilter[];

export function dayRange(from: string | undefined, days: number | undefined, today: LocalDate = todayLocal()): { from: LocalDate; to: LocalDate } {
  const start = from ?? today;
  if (!isValidLocalDate(start)) throw new AppError("bad_request", "from is a date like 2026-10-27", { field: "from" });
  const n = days ?? 7;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new AppError("bad_request", `days is 1 to ${MAX_DAYS}`, { field: "days" });
  return { from: start, to: addDays(start, n - 1) };
}

/** The shops this request may reach, or one of them. */
function shopsFor(ctx: StaffAppContext, shopId: string | undefined): string[] {
  if (shopId) {
    assertShopAccess(ctx, shopId);
    return [shopId];
  }
  return ctx.shopIds;
}

const iso = (date: LocalDate, min: number) => zonedWallTime(date, min).toJSDate().toISOString();

/**
 * Their own working days at each of their shops: hours, time off, lunch and other blocks (a private
 * reason shows as Blocked or Time off unless it's theirs), and how many clients are booked.
 */
export async function mySchedule(ctx: StaffAppContext, from: LocalDate, to: LocalDate, shopId?: string) {
  const me = ctx.staff.id;
  const ids = shopsFor(ctx, shopId);
  const [rows, scheds, names] = await Promise.all([
    staffingFor(ids, from, to, reasonViewer(ctx), [me]),
    ids.length ? db.select().from(staffSchedules).where(and(eq(staffSchedules.staffId, me), inArray(staffSchedules.shopId, ids))) : [],
    ids.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ids)) : [],
  ]);
  const shopName = new Map(names.map((s) => [s.id, s.name]));
  return {
    from,
    to,
    days: rows.map((r) => ({
      date: r.date,
      shopId: r.shopId,
      shop: shopName.get(r.shopId) ?? "",
      status: r.status,
      hours: scheduledOn(
        r.date,
        weekdayOf(r.date),
        scheds.filter((s) => s.shopId === r.shopId),
      ).map((i) => ({ start: i.start.toISOString(), end: i.end.toISOString() })),
      scheduledMin: r.scheduledMin,
      offMin: r.offMin,
      blockedMin: r.blockedMin,
      timeOffPending: r.pending,
      booked: r.booked,
      blocks: r.blocks.map((b) => ({ category: b.category, label: b.label, color: b.color, note: b.note, private: b.hidden, start: iso(r.date, b.startMin), end: iso(r.date, b.endMin) })),
    })),
  };
}

type ApptRow = {
  a: typeof appointments.$inferSelect;
  shop: string;
  barber: string;
  firstName: string | null;
  lastName: string | null;
  saleId: string | null;
  saleStatus: string | null;
};

async function itemsOf(ids: string[]) {
  return ids.length
    ? db
        .select({ appointmentId: appointmentItems.appointmentId, kind: appointmentItems.kind, name: appointmentItems.name, priceCents: appointmentItems.priceCents, durationMin: appointmentItems.durationMin })
        .from(appointmentItems)
        .where(inArray(appointmentItems.appointmentId, ids))
        .orderBy(asc(appointmentItems.kind))
    : [];
}

function apptQuery() {
  return db
    .select({ a: appointments, shop: shops.name, barber: staff.displayLabel, firstName: customers.firstName, lastName: customers.lastName, saleId: sales.id, saleStatus: sales.status })
    .from(appointments)
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(sales, and(eq(sales.appointmentId, appointments.id), ne(sales.status, "voided")));
}

async function brief(ctx: StaffAppContext, rows: ApptRow[]) {
  const policy = await clientPolicy(ctx);
  const items = await itemsOf(rows.map((r) => r.a.id));
  return rows.map((r) => ({
    id: r.a.id,
    code: r.a.code,
    shopId: r.a.shopId,
    shop: r.shop,
    staffId: r.a.staffId,
    barber: r.barber,
    startsAt: r.a.startsAt.toISOString(),
    endsAt: r.a.endsAt.toISOString(),
    status: r.a.status,
    source: r.a.source,
    customer: r.a.customerId ? { id: r.a.customerId, name: clientName(r.firstName, policy.show("last_name", r.lastName)) } : null,
    walkInName: r.a.customerId ? null : (r.a.notes?.replace(/^Walk-in: /, "") ?? "Walk-in"),
    services: items.filter((i) => i.appointmentId === r.a.id).map((i) => i.name),
    estimateCents: r.a.estimateCents,
    groupId: r.a.groupId,
    checkoutReadyAt: r.a.checkoutReadyAt?.toISOString() ?? null,
    saleId: r.saleId,
    saleStatus: r.saleStatus,
  }));
}

/** Their own appointments over the days asked, at the shops this request reaches, in start order. Names follow Client data. */
export async function myAppointments(ctx: StaffAppContext, o: { from: LocalDate; to: LocalDate; status: AppointmentStatusFilter; shopId?: string }) {
  const ids = shopsFor(ctx, o.shopId);
  if (!ids.length) return { from: o.from, to: o.to, appointments: [] };
  if (diffDays(o.to, o.from) >= MAX_DAYS) throw new AppError("bad_request", `Up to ${MAX_DAYS} days at a time`);
  const statuses = STATUSES[o.status];
  const rows = await apptQuery()
    .where(
      and(
        eq(appointments.staffId, ctx.staff.id),
        inArray(appointments.shopId, ids),
        gte(appointments.startsAt, startOfLocalDay(o.from)),
        lt(appointments.startsAt, endOfLocalDay(o.to)),
        statuses ? inArray(appointments.status, [...statuses]) : undefined,
      ),
    )
    .orderBy(asc(appointments.startsAt))
    .limit(1000);
  return { from: o.from, to: o.to, appointments: await brief(ctx, rows) };
}

/**
 * One appointment they may open: their own, or anyone's at their shops when they see every barber's
 * calendar. Anything else is not found, so ids can't be probed.
 */
async function reachable(ctx: StaffAppContext, id: string): Promise<ApptRow> {
  const [row] = await apptQuery().where(eq(appointments.id, id)).limit(1);
  if (!row || !ctx.shopIds.includes(row.a.shopId)) throw notFound("Appointment");
  if (row.a.staffId !== ctx.staff.id && !can(ctx, "calendar.view_all") && !can(ctx, "calendar.manage")) throw notFound("Appointment");
  return row;
}

export async function myAppointment(ctx: StaffAppContext, id: string) {
  const row = await reachable(ctx, id);
  const [b] = await brief(ctx, [row]);
  const policy = await clientPolicy(ctx);
  const [items, badges] = await Promise.all([itemsOf([id]), row.a.customerId ? shownBadges(policy, [row.a.customerId]) : new Map()]);
  return {
    ...b,
    mine: row.a.staffId === ctx.staff.id,
    items: items.map((i) => ({ kind: i.kind, name: i.name, priceCents: i.priceCents, durationMin: i.durationMin })),
    bookingTipCents: row.a.bookingTipCents,
    note: row.a.customerId ? row.a.notes : null,
    checkedInAt: row.a.checkedInAt?.toISOString() ?? null,
    completedAt: row.a.completedAt?.toISOString() ?? null,
    cancelledAt: row.a.cancelledAt?.toISOString() ?? null,
    badges: row.a.customerId ? (badges.get(row.a.customerId) ?? []) : [],
  };
}

/** The client's notes on an appointment they may open, as Client notes' permissions show them: none, a count, or the notes they may read. */
export async function appointmentNotes(ctx: StaffAppContext, id: string) {
  const row = await reachable(ctx, id);
  if (!row.a.customerId) throw notFound("Client");
  const list = await listNotes(ctx, row.a.customerId);
  if (!list.mode) throw forbidden("Client notes are hidden for you");
  await recordClientAccess(ctx, { kind: "view", customerId: row.a.customerId, detail: { notes: true, via: "staff_app", appointmentId: id } });
  return { customerId: row.a.customerId, ...list };
}

/** A note on the appointment's client; a cut note is tied to this visit. */
export async function addAppointmentNote(ctx: StaffAppContext, id: string, raw: unknown) {
  const row = await reachable(ctx, id);
  if (!row.a.customerId) throw new AppError("bad_request", "A walk-in without a client profile has no notes");
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return addNote(ctx, row.a.customerId, input.kind === "visit" ? { ...input, appointmentId: id } : input);
}
