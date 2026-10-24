import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appointments, sales } from "@/db/schema";
import { FamilyBookingRequest, FamilyBookingRequestSchema, Seat, nextSeat } from "@/domain/family";
import { localDateOf } from "@/lib/time";
import { Actor, audit } from "./audit";
import { PublicAppointment, createAppointment, getAvailability, messageContext } from "./booking";
import { AppError } from "./errors";
import { householdIds } from "./family";
import { scheduleAppointmentNotifications } from "./notifications/queue";

export interface FamilyBookingOptions {
  /** The parent booking (the signed-in customer), or the client staff are booking for. */
  guardianId: string;
  source: "online" | "api" | "staff";
  actor: Actor;
  now?: Date;
  /** Staff with "Squeeze in" can book the first person off the grid; everyone else lands on open slots. */
  squeezeIn?: boolean;
}

/**
 * Book a parent and/or their children in one go, at one shop on one day. The first person takes the
 * time picked; each next one sits at the same time with another barber, or right after the person
 * before them (with the same barber unless another is asked for). All or nothing: when someone
 * can't be seated, the appointments made so far are removed and nothing is sent. Once everyone is
 * in, each appointment's confirmation and reminders go to the parent.
 */
export async function bookFamily(raw: unknown, o: FamilyBookingOptions): Promise<PublicAppointment[]> {
  const req: FamilyBookingRequest = FamilyBookingRequestSchema.parse(raw);
  const now = o.now ?? new Date();
  const members = new Set(await householdIds(o.guardianId));
  if (req.people.some((p) => !members.has(p.customerId))) throw new AppError("not_found", "That person isn't on this account");
  if (new Set(req.people.map((p) => p.customerId)).size !== req.people.length) throw new AppError("bad_request", "Each person can be booked once");
  const first = req.people[0];
  if (!first.startsAt) throw new AppError("bad_request", "Pick a time for the first person");

  const made: PublicAppointment[] = [];
  const seated: Seat[] = [];
  try {
    for (const [i, p] of req.people.entries()) {
      let startsAt: string;
      let barberRef: string | null;
      if (i === 0) {
        startsAt = first.startsAt;
        barberRef = p.staffId ?? "any";
      } else {
        const date = localDateOf(seated[0].startsAt);
        const avail = await getAvailability({ shopRef: req.shopId, date, serviceId: p.serviceId, addonIds: p.addonIds, barberRef: p.staffId ?? "any", now, staffOverride: o.source === "staff" });
        const slots = avail.slots.flatMap((s) => s.barberIds.map((staffId) => ({ staffId, startsAt: s.startsAt })));
        const seat = nextSeat({ timing: p.timing, staffId: p.staffId }, seated, slots);
        if (!seat)
          throw new AppError(
            "slot_unavailable",
            p.timing === "same_time"
              ? `No other barber is free at the same time for person ${i + 1}. Try back to back, or another time.`
              : `Nobody is free right after person ${i}'s appointment for person ${i + 1}. Try the same time with another barber, or another time.`,
          );
        startsAt = seat.startsAt;
        barberRef = seat.staffId;
      }
      const a = await createAppointment({
        shopRef: req.shopId,
        serviceId: p.serviceId,
        addonIds: p.addonIds,
        barberRef,
        startsAt,
        customerId: p.customerId,
        source: o.source,
        notes: p.notes ?? null,
        actor: o.actor,
        now,
        silent: true,
        squeezeIn: i === 0 && o.squeezeIn && !!p.staffId,
      });
      made.push(a);
      seated.push({ staffId: a.barber.id, startsAt: a.startsAt, endsAt: a.endsAt });
    }
  } catch (e) {
    if (made.length) await db.delete(appointments).where(inArray(appointments.id, made.map((a) => a.id)));
    throw e;
  }
  for (const a of made) await scheduleAppointmentNotifications("created", await messageContext(a.id), db, now);
  await audit(o.actor, "appointment.family_booking", "customer", o.guardianId, { appointments: made.map((a) => a.id), people: made.length }, made[0]?.shop.id ?? null);
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
