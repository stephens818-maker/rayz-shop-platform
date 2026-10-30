import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments, sales } from "@/db/schema";
import type { Opening } from "@/domain/booking-group";
import { FamilyBookingRequest, FamilyBookingRequestSchema, nextSeat } from "@/domain/family";
import { localDateOf } from "@/lib/time";
import { Actor, audit } from "./audit";
import { PublicAppointment, createAppointment, dayOpenings, getAppointmentByCode } from "./booking";
import { bookGroup } from "./booking-groups";
import { AppError } from "./errors";
import { householdIds } from "./family";

export interface FamilyBookingOptions {
  /** The parent booking (the signed-in customer), or the client staff are booking for. */
  guardianId: string;
  source: "online" | "api" | "staff";
  actor: Actor;
  now?: Date;
  /** Staff with "Squeeze in" can book the first person off the grid; everyone else lands on open slots. */
  squeezeIn?: boolean;
  idempotencyKey?: string | null;
}

const clash = (a: Opening, b: Opening) => a.staffId === b.staffId && a.holdStart < b.holdEnd && b.holdStart < a.holdEnd;

/**
 * Book a parent and/or their children in one go, at one shop on one day. The first person takes the
 * time picked; each next one sits at the same time with another barber, or right after the person
 * before them (with the same barber unless another is asked for). Two or more people are booked as
 * one family group (src/server/booking-groups.ts): all in one transaction, one confirmation and one
 * set of reminders to the parent.
 */
export async function bookFamily(raw: unknown, o: FamilyBookingOptions): Promise<PublicAppointment[]> {
  const req: FamilyBookingRequest = FamilyBookingRequestSchema.parse(raw);
  const now = o.now ?? new Date();
  const members = new Set(await householdIds(o.guardianId));
  if (req.people.some((p) => !members.has(p.customerId))) throw new AppError("not_found", "That person isn't on this account");
  if (new Set(req.people.map((p) => p.customerId)).size !== req.people.length) throw new AppError("bad_request", "Each person can be booked once");
  const first = req.people[0];
  if (!first.startsAt) throw new AppError("bad_request", "Pick a time for the first person");
  const squeeze = o.source === "staff" && !!o.squeezeIn && !!first.staffId;

  if (req.people.length === 1) {
    const a = await createAppointment({
      shopRef: req.shopId,
      serviceId: first.serviceId,
      addonIds: first.addonIds,
      barberRef: first.staffId ?? "any",
      startsAt: first.startsAt,
      customerId: first.customerId,
      source: o.source,
      notes: first.notes ?? null,
      actor: o.actor,
      now,
      squeezeIn: squeeze,
      idempotencyKey: o.idempotencyKey ?? null,
    });
    await audit(o.actor, "appointment.family_booking", "customer", o.guardianId, { appointments: [a.id], people: 1 }, a.shop.id);
    return [a];
  }

  const start = new Date(first.startsAt);
  if (Number.isNaN(start.getTime())) throw new AppError("bad_request", "startsAt must be an ISO timestamp");
  const date = localDateOf(start);
  const staffSide = o.source === "staff";
  const seated: Opening[] = [];
  for (const [i, p] of req.people.entries()) {
    const day = await dayOpenings({ shopRef: req.shopId, date, serviceId: p.serviceId, addonIds: p.addonIds, barberRef: p.staffId ?? "any", now, staffOverride: staffSide });
    const free = day.openings.filter((x) => !seated.some((s) => clash(x, s)));
    let seat: Opening | undefined;
    if (i === 0) {
      seat = squeeze
        ? { staffId: first.staffId!, start: start.getTime(), end: start.getTime() + day.durationMin * 60_000, holdStart: start.getTime(), holdEnd: start.getTime() + day.durationMin * 60_000 }
        : free.find((x) => x.start === start.getTime() && (!p.staffId || x.staffId === p.staffId));
      if (!seat) throw new AppError("slot_unavailable", "That time was just taken — please pick another");
    } else {
      const iso = (t: number) => new Date(t).toISOString();
      const pickedSlot = nextSeat(
        { timing: p.timing, staffId: p.staffId },
        seated.map((s) => ({ staffId: s.staffId, startsAt: iso(s.start), endsAt: iso(s.end) })),
        free.map((x) => ({ staffId: x.staffId, startsAt: iso(x.start) })),
      );
      seat = pickedSlot ? free.find((x) => x.staffId === pickedSlot.staffId && x.start === Date.parse(pickedSlot.startsAt)) : undefined;
      if (!seat)
        throw new AppError(
          "slot_unavailable",
          p.timing === "same_time"
            ? `No other barber is free at the same time for person ${i + 1}. Try back to back, or another time.`
            : `Nobody is free right after person ${i}'s appointment for person ${i + 1}. Try the same time with another barber, or another time.`,
        );
    }
    seated.push(seat);
  }

  const group = await bookGroup(
    {
      shopId: req.shopId,
      plan: "custom",
      people: req.people.map((p) => ({ customerId: p.customerId, serviceId: p.serviceId, addonIds: p.addonIds, staffId: p.staffId, notes: p.notes })),
      seats: req.people.map((p, i) => ({ customerId: p.customerId, staffId: seated[i].staffId, startsAt: new Date(seated[i].start).toISOString() })),
    },
    { guardianId: o.guardianId, source: o.source, actor: o.actor, now, idempotencyKey: o.idempotencyKey, squeeze: squeeze ? [first.customerId] : [] },
  );
  const made = await Promise.all(req.people.map((p) => getAppointmentByCode(group.members.find((m) => m.customerId === p.customerId)!.appointmentCode, now)));
  await audit(o.actor, "appointment.family_booking", "customer", o.guardianId, { appointments: made.map((a) => a.id), people: made.length, group: group.code }, made[0]?.shop.id ?? null);
  return made;
}

/** Whose appointment this is can change within a household (the desk booked the parent, the child came in). */
export async function reassignWithinHousehold(appointmentId: string, customerId: string, actor: Actor) {
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, appointmentId) });
  if (!a) throw new AppError("not_found", "Appointment not found");
  if (!a.customerId) throw new AppError("bad_request", "This appointment has no client");
  if (a.customerId === customerId) return;
  if (!(await householdIds(a.customerId)).includes(customerId)) throw new AppError("bad_request", "Pick someone on the same family account");
  if (a.status === "completed" || a.status === "cancelled" || a.status === "no_show") throw new AppError("conflict", "This appointment is already closed");
  await db.transaction(async (tx) => {
    await tx.update(appointments).set({ customerId }).where(eq(appointments.id, appointmentId));
    await tx
      .update(sales)
      .set({ customerId })
      .where(and(eq(sales.appointmentId, appointmentId), eq(sales.status, "open"), eq(sales.customerId, a.customerId!)));
  });
  await audit(actor, "appointment.family_member", "appointment", appointmentId, { from: a.customerId, to: customerId }, a.shopId);
}
