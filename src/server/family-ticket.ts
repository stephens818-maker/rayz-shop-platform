import { and, asc, eq, gte, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import { clientName, maskLastName } from "@/domain/client-privacy";
import { db, type DBorTx } from "@/db";
import { appointmentItems, appointments, customers, saleAppointments, saleItems, sales, staff, type Appointment, type Sale } from "@/db/schema";
import type { LineKind } from "@/domain/checkout";
import { endOfLocalDay, localDateOf, startOfLocalDay } from "@/lib/time";
import { Actor, audit } from "./audit";
import { shopCatalog } from "./catalog";
import { AppError, notFound } from "./errors";
import { householdIds } from "./family";

/** Statuses an appointment can be added to a family ticket from. */
export const OPEN_STATUSES = ["booked", "confirmed", "checked_in", "in_service"] as const;

export interface FamilyTicketMember {
  appointmentId: string;
  /** Null for a walk-in with no client on file, combined in from their own ticket. */
  customerId: string | null;
  name: string;
  /** The parts of the name, for showing the last name at the viewer's level. */
  first: string | null;
  last: string | null;
  isChild: boolean;
  staffId: string | null;
  staffName: string | null;
  startsAt: Date;
  status: string;
  /** Sent to checkout by their barber or the desk. */
  readyAt: Date | null;
}

/** The other appointments on one combined ticket, in the order they joined it (people added together by start time). */
export async function ticketAppointmentIds(saleId: string, tx: DBorTx = db): Promise<string[]> {
  const rows = await tx
    .select({ id: saleAppointments.appointmentId })
    .from(saleAppointments)
    .innerJoin(appointments, eq(appointments.id, saleAppointments.appointmentId))
    .where(eq(saleAppointments.saleId, saleId))
    .orderBy(asc(saleAppointments.createdAt), asc(appointments.startsAt), asc(appointments.id));
  return rows.map((r) => r.id);
}

/** Everyone on a ticket: its own appointment first, then the others in the order they joined. */
export async function ticketPeople(sale: { id: string; appointmentId: string | null }, tx: DBorTx = db): Promise<FamilyTicketMember[]> {
  const ids = [sale.appointmentId, ...(await ticketAppointmentIds(sale.id, tx))].filter((x): x is string => !!x);
  const found = await members(ids, tx);
  return ids.map((id) => found.find((m) => m.appointmentId === id)).filter((m): m is FamilyTicketMember => !!m);
}

export async function members(ids: string[], tx: DBorTx): Promise<FamilyTicketMember[]> {
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
      readyAt: appointments.checkoutReadyAt,
    })
    .from(appointments)
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(staff, eq(staff.id, appointments.staffId))
    .where(inArray(appointments.id, ids))
    .orderBy(asc(appointments.startsAt));
  return rows.map((r) => ({
    appointmentId: r.appointmentId,
    customerId: r.customerId,
    name: clientName(r.first, maskLastName(r.last)) || "Walk-in",
    first: r.first,
    last: r.last,
    isChild: !!r.guardianId,
    staffId: r.staffId,
    staffName: r.staffName,
    startsAt: r.startsAt,
    status: r.status,
    readyAt: r.readyAt,
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

export async function lockOpenSale(tx: DBorTx, saleId: string) {
  const [s] = await tx.select().from(sales).where(eq(sales.id, saleId)).for("update");
  if (!s) throw notFound("Sale");
  if (s.status !== "open") throw new AppError("conflict", s.mergedIntoSaleId ? "That ticket was combined into another one" : "Ticket is closed");
  return s;
}

/**
 * Lines for an appointment's services at today's menu price, tagged to the appointment and its
 * barber, so the tip splits per barber and the visit lands on the right person.
 */
export async function appointmentLines(saleId: string, appt: Pick<Appointment, "id" | "shopId" | "staffId">, tx: DBorTx) {
  const items = await tx.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appt.id));
  if (!items.length) return;
  const menu = await shopCatalog(appt.shopId);
  await tx.insert(saleItems).values(
    items.map((i) => {
      const price = menu.find((s) => s.id === i.serviceId)?.priceCents ?? i.priceCents;
      return { saleId, appointmentId: appt.id, kind: i.kind as LineKind, refId: i.serviceId, name: i.name, staffId: appt.staffId, qty: 1, unitPriceCents: price, grossCents: price, netCents: price };
    }),
  );
}

/** Put a locked appointment on a locked open ticket, with its services; it's in the chair from now. */
export async function putOnTicket(tx: DBorTx, sale: Sale, appt: Appointment, actor: Actor, action = "sale.family_add") {
  await tx.insert(saleAppointments).values({ saleId: sale.id, appointmentId: appt.id, addedBy: actor.staffId ?? null });
  await appointmentLines(sale.id, appt, tx);
  if (appt.status !== "in_service") {
    await tx.update(appointments).set({ status: "in_service", checkedInAt: appt.checkedInAt ?? new Date() }).where(eq(appointments.id, appt.id));
  }
  await audit(actor, action, "sale", sale.id, { appointmentId: appt.id, customerId: appt.customerId }, sale.shopId, tx);
}

/** Put a household member's appointment on this ticket. */
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
    await putOnTicket(tx, sale, appt, actor);
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
    await tx.update(appointments).set({ status: "checked_in", checkoutReadyAt: null, checkoutReadyBy: null }).where(and(eq(appointments.id, appointmentId), eq(appointments.status, "in_service")));
    await audit(actor, "sale.family_remove", "sale", saleId, { appointmentId }, sale.shopId, tx);
    return null;
  });
}
