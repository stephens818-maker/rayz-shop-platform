import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, type DBorTx, type Tx } from "@/db";
import { appointments, bookingGroups, checkoutHandoffs, customers, payments, saleAppointments, saleItems, sales, staff, type Sale } from "@/db/schema";
import { mergeProblem, readiness } from "@/domain/combined-checkout";
import { todayLocal } from "@/lib/time";
import { Actor, audit } from "./audit";
import { ACTIVE_STATUSES } from "./booking";
import { openSaleForAppointment } from "./checkout";
import { AppError, notFound } from "./errors";
import { familyTicketFor, lockOpenSale, members, putOnTicket, ticketAppointmentIds, type FamilyTicketMember } from "./family-ticket";
import { finishIfRunning } from "./service-times";

const isActive = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s);

async function lockAppointment(tx: DBorTx, id: string) {
  const [a] = await tx.select().from(appointments).where(eq(appointments.id, id)).for("update");
  if (!a) throw notFound("Appointment");
  return a;
}

/** The open ticket an appointment is on; null when it has none. A paid one can't take it again. */
async function openTicketOf(tx: DBorTx, appointmentId: string): Promise<string | null> {
  const id = await familyTicketFor(appointmentId, tx);
  if (!id) return null;
  const [s] = await tx.select({ status: sales.status }).from(sales).where(eq(sales.id, id));
  return s?.status === "open" ? id : null;
}

async function markReady(tx: DBorTx, appointmentIds: string[], actor: Actor, now: Date) {
  if (!appointmentIds.length) return;
  for (const id of appointmentIds) await finishIfRunning(id, actor, tx, now);
  await tx
    .update(appointments)
    .set({ checkoutReadyAt: now, checkoutReadyBy: actor.staffId ?? null })
    .where(and(inArray(appointments.id, appointmentIds), isNull(appointments.checkoutReadyAt)));
}

async function readinessOf(tx: DBorTx, sale: Pick<Sale, "id" | "appointmentId">) {
  const ids = [sale.appointmentId, ...(await ticketAppointmentIds(sale.id, tx))].filter((x): x is string => !!x);
  return readiness(await members(ids, tx));
}

/**
 * A barber's finished visit goes to checkout: onto the booking group's one open ticket when the visit
 * is part of a group (opening it, paid by the parent, when nobody's there yet), or its own ticket.
 * The service's finish is recorded now, so the cut time is the barber's and not the family's wait.
 */
export async function sendToCheckout(appointmentId: string, actor: Actor, now = new Date()) {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ groupId: appointments.groupId }).from(appointments).where(eq(appointments.id, appointmentId));
    if (!peek) throw notFound("Appointment");
    // Two barbers finishing two children at once must land on one ticket: the group row serializes them.
    const group = peek.groupId ? (await tx.select().from(bookingGroups).where(eq(bookingGroups.id, peek.groupId)).for("update"))[0] : null;
    const appt = await lockAppointment(tx, appointmentId);
    if (appt.status === "completed") throw new AppError("conflict", "This visit is already checked out");
    if (!isActive(appt.status)) throw new AppError("conflict", `This appointment is ${appt.status.replace("_", " ")}`);

    let saleId = await familyTicketFor(appt.id, tx);
    let joined = false;
    if (saleId) {
      const [s] = await tx.select({ status: sales.status }).from(sales).where(eq(sales.id, saleId));
      if (s.status !== "open") throw new AppError("conflict", "This visit's ticket is already paid");
    } else if (group) {
      const others = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.groupId, group.id), ne(appointments.id, appt.id), inArray(appointments.status, [...ACTIVE_STATUSES])))
        .orderBy(asc(appointments.startsAt));
      for (const o of others) {
        saleId = await openTicketOf(tx, o.id);
        if (saleId) break;
      }
      if (saleId) {
        const sale = await lockOpenSale(tx, saleId);
        await putOnTicket(tx, sale, appt, actor, "sale.group_join");
        joined = true;
      } else {
        saleId = (await openSaleForAppointment(appt.id, actor, tx, { customerId: group.guardianId })).id;
      }
    } else {
      saleId = (await openSaleForAppointment(appt.id, actor, tx)).id;
    }
    await markReady(tx, [appt.id], actor, now);
    await audit(actor, "appointment.send_to_checkout", "appointment", appt.id, { saleId, groupId: group?.id ?? null, joined }, appt.shopId, tx);
    const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId));
    return { saleId, joined, ...(await readinessOf(tx, sale)) };
  });
}

/**
 * The whole booking group on one combined ticket: the open ticket one of them already has (any other
 * open tickets in the group are combined into it), or the parent's. `ready` also sends everyone to
 * checkout; without it this is the desk's "One ticket" before the services are done.
 */
export async function sendGroupToCheckout(groupId: string, actor: Actor, o: { ready?: boolean; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const ready = o.ready ?? true;
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(bookingGroups).where(eq(bookingGroups.id, groupId)).for("update");
    if (!g) throw notFound("Family booking");
    const live = (await tx.select().from(appointments).where(eq(appointments.groupId, g.id)).orderBy(asc(appointments.startsAt))).filter((a) => isActive(a.status));
    if (!live.length) throw new AppError("conflict", "Nobody in this booking is still booked");
    const open = new Map<string, string>();
    for (const m of live) {
      const t = await openTicketOf(tx, m.id);
      if (t) open.set(m.id, t);
    }
    const lead = live.find((m) => open.has(m.id) && m.customerId === g.guardianId) ?? live.find((m) => open.has(m.id));
    let saleId = lead ? open.get(lead.id)! : null;
    if (!saleId) {
      const first = live.find((m) => m.customerId === g.guardianId) ?? live[0];
      saleId = (await openSaleForAppointment(first.id, actor, tx, { customerId: g.guardianId })).id;
      open.set(first.id, saleId);
    }
    const others = [...new Set([...open.values()].filter((id) => id !== saleId))];
    if (others.length) await mergeInTx(tx, saleId, others, actor, now);
    const target = await lockOpenSale(tx, saleId);
    for (const m of live) {
      if (open.has(m.id) || (await familyTicketFor(m.id, tx))) continue;
      await putOnTicket(tx, target, await lockAppointment(tx, m.id), actor, "sale.group_join");
    }
    if (ready) await markReady(tx, [target.appointmentId, ...(await ticketAppointmentIds(target.id, tx))].filter((x): x is string => !!x), actor, now);
    await audit(actor, ready ? "booking_group.send_to_checkout" : "booking_group.ticket", "booking_group", g.id, { saleId, people: live.length, combined: others.length, split: false }, g.shopId, tx);
    return saleId;
  });
}

// ───────────────────────────── Combining and splitting ─────────────────────────────

/**
 * Combine open tickets into `targetId`: their people (appointments) and lines move over, each line
 * still tagged to its person and barber, and each ticket combined away is voided, pointing at the
 * one it went into. Any open tickets at the shop can be combined, family or not.
 */
export async function mergeTickets(targetId: string, sourceIds: string[], actor: Actor, now = new Date()) {
  return db.transaction(async (tx) => {
    await mergeInTx(tx, targetId, sourceIds, actor, now);
    return targetId;
  });
}

async function mergeInTx(tx: Tx, targetId: string, sourceIds: string[], actor: Actor, now: Date) {
  const ids = [...new Set([targetId, ...sourceIds])].sort();
  // Always in id order, so two combines over the same tickets wait for each other rather than deadlock.
  const locked = await tx.select().from(sales).where(inArray(sales.id, ids)).orderBy(asc(sales.id)).for("update");
  if (locked.length !== ids.length) throw notFound("Ticket");
  const paid = await tx.select({ saleId: payments.saleId }).from(payments).where(inArray(payments.saleId, ids));
  const handed = await tx.select({ saleId: checkoutHandoffs.saleId }).from(checkoutHandoffs).where(and(inArray(checkoutHandoffs.saleId, ids), eq(checkoutHandoffs.status, "active")));
  const view = (s: Sale) => ({ id: s.id, shopId: s.shopId, status: s.status, payments: paid.filter((p) => p.saleId === s.id).length, withClient: handed.some((h) => h.saleId === s.id) });
  const target = locked.find((s) => s.id === targetId)!;
  const sources = sourceIds.map((id) => locked.find((s) => s.id === id)!);
  const problem = mergeProblem(view(target), sources.map(view));
  if (problem) throw new AppError("conflict", problem);
  const deposits = await tx.select({ id: bookingGroups.id }).from(bookingGroups).where(inArray(bookingGroups.depositSaleId, sourceIds));
  if (deposits.length) throw new AppError("conflict", "A booking deposit's ticket can't be combined; it's paid on its own");

  let lead = target.appointmentId;
  const patch: Partial<Sale> = {};
  for (const src of sources) {
    const extras = await ticketAppointmentIds(src.id, tx);
    const incoming = [src.appointmentId, ...extras].filter((x): x is string => !!x);
    await tx
      .update(saleItems)
      .set({
        saleId: target.id,
        appointmentId: src.appointmentId ? sql`coalesce(${saleItems.appointmentId}, case when ${saleItems.kind} in ('service', 'addon') then ${src.appointmentId}::uuid end)` : saleItems.appointmentId,
      })
      .where(eq(saleItems.saleId, src.id));
    await tx.delete(saleAppointments).where(eq(saleAppointments.saleId, src.id));
    await tx
      .update(sales)
      .set({ status: "voided", voidedAt: now, voidReason: `Combined into ticket #${target.number}`, mergedIntoSaleId: target.id })
      .where(eq(sales.id, src.id));
    for (const a of incoming) {
      if (!lead) {
        lead = a;
        patch.appointmentId = a;
      } else {
        await tx.insert(saleAppointments).values({ saleId: target.id, appointmentId: a, addedBy: actor.staffId ?? null });
      }
    }
    if (!target.customerId && !patch.customerId && src.customerId) patch.customerId = src.customerId;
    if (!target.staffId && !patch.staffId && src.staffId) patch.staffId = src.staffId;
    await audit(actor, "sale.merge", "sale", target.id, { from: src.id, number: src.number, appointments: incoming }, target.shopId, tx);
    await audit(actor, "sale.merged_into", "sale", src.id, { into: target.id, number: target.number }, src.shopId, tx);
  }
  if (Object.keys(patch).length) await tx.update(sales).set(patch).where(eq(sales.id, target.id));
}

/**
 * Split one person back off a combined ticket onto their own: their appointment and the lines tagged
 * to it move, with their barber. Splitting off the ticket's own person hands the ticket to the next
 * one; the payer stays unless it was the person leaving.
 */
export async function splitOffTicket(saleId: string, appointmentId: string, actor: Actor, now = new Date()) {
  return db.transaction(async (tx) => {
    const sale = await lockOpenSale(tx, saleId);
    const [pay] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.saleId, sale.id)).limit(1);
    if (pay) throw new AppError("conflict", "A ticket that has taken a payment can't be split");
    const [handed] = await tx.select({ id: checkoutHandoffs.id }).from(checkoutHandoffs).where(and(eq(checkoutHandoffs.saleId, sale.id), eq(checkoutHandoffs.status, "active")));
    if (handed) throw new AppError("conflict", "This ticket is with the client on the customer screen. Take it back first.");
    const extras = await ticketAppointmentIds(sale.id, tx);
    const isLead = sale.appointmentId === appointmentId;
    if (!isLead && !extras.includes(appointmentId)) throw notFound("That person on this ticket");
    if (!extras.length) throw new AppError("conflict", "Only one person is on this ticket");
    const appt = await lockAppointment(tx, appointmentId);

    if (isLead) {
      const next = extras[0];
      await tx.delete(saleAppointments).where(and(eq(saleAppointments.saleId, sale.id), eq(saleAppointments.appointmentId, next)));
      const [n] = await tx.select().from(appointments).where(eq(appointments.id, next));
      await tx
        .update(sales)
        .set({
          appointmentId: next,
          customerId: sale.customerId === appt.customerId ? (n.customerId ?? sale.customerId) : sale.customerId,
          staffId: sale.staffId === appt.staffId ? (n.staffId ?? sale.staffId) : sale.staffId,
        })
        .where(eq(sales.id, sale.id));
    } else {
      await tx.delete(saleAppointments).where(and(eq(saleAppointments.saleId, sale.id), eq(saleAppointments.appointmentId, appointmentId)));
    }
    const [own] = await tx
      .insert(sales)
      .values({ shopId: sale.shopId, appointmentId, customerId: appt.customerId, staffId: appt.staffId, businessDate: todayLocal(now), createdBy: actor.staffId ?? null })
      .returning();
    const mine = isLead
      ? sql`(${saleItems.appointmentId} = ${appointmentId} or (${saleItems.appointmentId} is null and ${saleItems.kind} in ('service', 'addon')))`
      : eq(saleItems.appointmentId, appointmentId);
    const moved = await tx.update(saleItems).set({ saleId: own.id, appointmentId }).where(and(eq(saleItems.saleId, sale.id), mine)).returning({ id: saleItems.id });
    await audit(actor, "sale.split", "sale", sale.id, { appointmentId, to: own.id, number: own.number, lines: moved.length }, sale.shopId, tx);
    return own.id;
  });
}

/** Everyone on the ticket gets their own, the ticket's own person keeping this one. */
export async function splitTicketApart(saleId: string, actor: Actor, now = new Date()) {
  const out: string[] = [];
  for (const id of await ticketAppointmentIds(saleId)) out.push(await splitOffTicket(saleId, id, actor, now));
  return out;
}

// ───────────────────────────── The checkout queue ─────────────────────────────

export interface OpenTicket {
  id: string;
  number: number;
  shopId: string;
  createdAt: Date;
  client: string | null;
  barber: string | null;
  people: Pick<FamilyTicketMember, "appointmentId" | "name" | "staffName" | "readyAt">[];
  ready: number;
  total: number;
  lines: number;
  grossCents: number;
  groupCode: string | null;
}

/**
 * Open tickets at these shops, newest first, with who's on each and how many have been sent to
 * checkout: the queue on the Sales page and the "add ticket" picker at checkout. `q` matches a
 * ticket number or anyone's name on it.
 */
export async function openTickets(shopIds: string[], o: { excludeSaleId?: string | null; q?: string | null; limit?: number } = {}, tx: DBorTx = db): Promise<OpenTicket[]> {
  if (!shopIds.length) return [];
  const rows = await tx
    .select({
      id: sales.id,
      number: sales.number,
      shopId: sales.shopId,
      createdAt: sales.createdAt,
      appointmentId: sales.appointmentId,
      first: customers.firstName,
      last: customers.lastName,
      barber: staff.displayLabel,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .leftJoin(staff, eq(staff.id, sales.staffId))
    .where(and(inArray(sales.shopId, shopIds), eq(sales.status, "open"), o.excludeSaleId ? ne(sales.id, o.excludeSaleId) : sql`true`))
    .orderBy(desc(sales.createdAt))
    .limit(o.limit ?? 200);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const extra = await tx.select().from(saleAppointments).where(inArray(saleAppointments.saleId, ids)).orderBy(asc(saleAppointments.createdAt));
  const people = await members([...rows.map((r) => r.appointmentId).filter((x): x is string => !!x), ...extra.map((e) => e.appointmentId)], tx);
  const lines = await tx
    .select({ saleId: saleItems.saleId, n: sql<number>`count(*)::int`, gross: sql<number>`coalesce(sum(${saleItems.grossCents}), 0)::int` })
    .from(saleItems)
    .where(inArray(saleItems.saleId, ids))
    .groupBy(saleItems.saleId);
  const groups = people.length
    ? await tx
        .select({ appointmentId: appointments.id, code: bookingGroups.code })
        .from(appointments)
        .innerJoin(bookingGroups, eq(bookingGroups.id, appointments.groupId))
        .where(inArray(appointments.id, people.map((p) => p.appointmentId)))
    : [];
  const out = rows.map((r): OpenTicket => {
    const order = [r.appointmentId, ...extra.filter((e) => e.saleId === r.id).map((e) => e.appointmentId)].filter((x): x is string => !!x);
    const mine = order.map((id) => people.find((p) => p.appointmentId === id)).filter((p): p is FamilyTicketMember => !!p);
    const l = lines.find((x) => x.saleId === r.id);
    return {
      id: r.id,
      number: r.number,
      shopId: r.shopId,
      createdAt: r.createdAt,
      client: [r.first, r.last].filter(Boolean).join(" ") || null,
      barber: r.barber,
      people: mine.map((m) => ({ appointmentId: m.appointmentId, name: m.name, staffName: m.staffName, readyAt: m.readyAt })),
      ...readiness(mine),
      lines: l?.n ?? 0,
      grossCents: l?.gross ?? 0,
      groupCode: groups.find((g) => order.includes(g.appointmentId))?.code ?? null,
    };
  });
  const q = o.q?.trim().toLowerCase().replace(/^#/, "");
  if (!q) return out;
  return out.filter((t) => String(t.number) === q || [t.client, ...t.people.map((p) => p.name)].some((n) => n?.toLowerCase().includes(q)));
}
