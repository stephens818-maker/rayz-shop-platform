import "server-only";
import { and, asc, eq, gte, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { appointmentItems, appointments, customers, saleAppointments, saleItems, sales, staff } from "@/db/schema";
import type { LineKind } from "@/domain/checkout";
import { endOfLocalDay, localDateOf, startOfLocalDay } from "@/lib/time";
import { Actor, audit } from "./audit";
import { shopCatalog } from "./catalog";
import { AppError, notFound } from "./errors";
import { householdIds } from "./family";

/** Statuses an appointment can be added to a family ticket from. */
const OPEN_STATUSES = ["booked", "confirmed", "checked_in", "in_service"] as const;

export interface FamilyTicketMember {
  appointmentId: string;
  customerId: string;
  name: string;
  isChild: boolean;
  staffId: string | null;
  staffName: string | null;
  startsAt: Date;
  status: string;
}

/** The household's other appointments on one family ticket, oldest booking first. */
export async function ticketAppointmentIds(saleId: string, tx: DBorTx = db): Promise<string[]> {
  const rows = await tx.select({ id: saleAppointments.appointmentId }).from(saleAppointments).where(eq(saleAppointments.saleId, saleId)).orderBy(asc(saleAppointments.createdAt));
  return rows.map((r) => r.id);
}

async function members(ids: string[], tx: DBorTx): Promise<FamilyTicketMember[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select({
      appointmentId: appointments.id,
      customerId: appointments.customerId,
      first: customers.firstName,
      last: customers.lastName,
      guardianId: customers.guardianId,
      staffId: appointments.staffId,
      staffName: staff.displayLabel,
      startsAt: appointments.startsAt,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(staff, eq(staff.id, appointments.staffId))
    .where(inArray(appointments.id, ids))
    .orderBy(asc(appointments.startsAt));
  return rows.map((r) => ({
    appointmentId: r.appointmentId,
    customerId: r.customerId!,
    name: [r.first, r.last].filter(Boolean).join(" "),
    isChild: !!r.guardianId,
    staffId: r.staffId,
    staffName: r.staffName,
    startsAt: r.startsAt,
    status: r.status,
  }));
}

/** An appointment already on a ticket that isn't voided, as its own or as part of a family ticket. */
async function liveTicketFor(appointmentId: string, tx: DBorTx): Promise<string | null> {
  const [own] = await tx
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.appointmentId, appointmentId), ne(sales.status, "voided")));
  if (own) return own.id;
  const [joined] = await tx
    .select({ id: sales.id })
    .from(saleAppointments)
    .innerJoin(sales, eq(sales.id, saleAppointments.saleId))
    .where(and(eq(saleAppointments.appointmentId, appointmentId), ne(sales.status, "voided")));
  return joined?.id ?? null;
}

export const familyTicketFor = liveTicketFor;

/**
 * Who's on a family ticket and who else in the payer's household has an appointment at this shop
 * today that could join it.
 */
export async function familyTicket(sale: { id: string; shopId: string; customerId: string | null; appointmentId: string | null }, now = new Date(), tx: DBorTx = db) {
  const extra = await members(await ticketAppointmentIds(sale.id, tx), tx);
  if (!sale.customerId) return { members: extra, candidates: [] as FamilyTicketMember[] };
  const household = await householdIds(sale.customerId, tx);
  if (household.length < 2) return { members: extra, candidates: [] as FamilyTicketMember[] };
  const today = localDateOf(now);
  const [start, end] = [startOfLocalDay(today), endOfLocalDay(today)];
  const taken = [sale.appointmentId, ...extra.map((m) => m.appointmentId)].filter((x): x is string => !!x);
  const open = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.shopId, sale.shopId),
        inArray(appointments.customerId, household),
        inArray(appointments.status, [...OPEN_STATUSES]),
        gte(appointments.startsAt, start),
        lt(appointments.startsAt, end),
        taken.length ? notInArray(appointments.id, taken) : sql`true`,
      ),
    );
  const free: string[] = [];
  for (const a of open) if (!(await liveTicketFor(a.id, tx))) free.push(a.id);
  return { members: extra, candidates: await members(free, tx) };
}

async function lockOpenSale(tx: DBorTx, saleId: string) {
  const [s] = await tx.select().from(sales).where(eq(sales.id, saleId)).for("update");
  if (!s) throw notFound("Sale");
  if (s.status !== "open") throw new AppError("conflict", "Ticket is closed");
  return s;
}

/**
 * Put a household member's appointment on this ticket: its services join as lines tagged to that
 * appointment and its barber, so the tip splits per barber and the visit lands on the right person.
 */
export async function addAppointmentToTicket(saleId: string, appointmentId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const sale = await lockOpenSale(tx, saleId);
    if (!sale.customerId) throw new AppError("bad_request", "Put the paying client on the ticket first");
    if (sale.appointmentId === appointmentId) throw new AppError("conflict", "That appointment is already on this ticket");
    const [appt] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for("update");
    if (!appt) throw notFound("Appointment");
    if (appt.shopId !== sale.shopId) throw new AppError("bad_request", "That appointment is at another shop");
    if (!(OPEN_STATUSES as readonly string[]).includes(appt.status)) throw new AppError("conflict", `That appointment is ${appt.status.replace("_", " ")}`);
    if (!appt.customerId || !(await householdIds(sale.customerId, tx)).includes(appt.customerId)) throw new AppError("bad_request", "Only the paying client's family can share their ticket");
    if (await liveTicketFor(appointmentId, tx)) throw new AppError("conflict", "That appointment is already on a ticket");
    await tx.insert(saleAppointments).values({ saleId, appointmentId, addedBy: actor.staffId ?? null });
    const items = await tx.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appointmentId));
    if (items.length) {
      const menu = await shopCatalog(sale.shopId);
      await tx.insert(saleItems).values(
        items.map((i) => {
          const price = menu.find((s) => s.id === i.serviceId)?.priceCents ?? i.priceCents;
          return { saleId, appointmentId, kind: i.kind as LineKind, refId: i.serviceId, name: i.name, staffId: appt.staffId, qty: 1, unitPriceCents: price, grossCents: price, netCents: price };
        }),
      );
    }
    if (appt.status !== "in_service") {
      await tx.update(appointments).set({ status: "in_service", checkedInAt: appt.checkedInAt ?? new Date() }).where(eq(appointments.id, appointmentId));
    }
    await audit(actor, "sale.family_add", "sale", saleId, { appointmentId, customerId: appt.customerId }, sale.shopId, tx);
    return null;
  });
}

/** Take a family member's appointment back off the ticket, with its lines; they're checked in again. */
export async function removeAppointmentFromTicket(saleId: string, appointmentId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const sale = await lockOpenSale(tx, saleId);
    const gone = await tx
      .delete(saleAppointments)
      .where(and(eq(saleAppointments.saleId, saleId), eq(saleAppointments.appointmentId, appointmentId)))
      .returning({ id: saleAppointments.appointmentId });
    if (!gone.length) throw notFound("Appointment on this ticket");
    await tx.delete(saleItems).where(and(eq(saleItems.saleId, saleId), eq(saleItems.appointmentId, appointmentId)));
    await tx.update(appointments).set({ status: "checked_in" }).where(and(eq(appointments.id, appointmentId), eq(appointments.status, "in_service")));
    await audit(actor, "sale.family_remove", "sale", saleId, { appointmentId }, sale.shopId, tx);
    return null;
  });
}
