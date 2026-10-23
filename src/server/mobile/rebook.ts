import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customerDependents } from "@/db/schema";
import { addDays, localDateOf, toZoned } from "@/lib/time";
import { customerActor } from "@/server/audit";
import { createAppointment, getAvailability } from "@/server/booking";
import { AppError, notFound } from "@/server/errors";

const REBOOK_WEEKS = 3;

async function owns(customerId: string, appointmentCustomerId: string | null) {
  if (!appointmentCustomerId) return false;
  if (appointmentCustomerId === customerId) return true;
  const [link] = await db
    .select({ id: customerDependents.id })
    .from(customerDependents)
    .where(and(eq(customerDependents.guardianId, customerId), eq(customerDependents.dependentId, appointmentCustomerId)));
  return Boolean(link);
}

/** Same barber and services, three weeks out, on that barber's grid. Customer booking, so the shop gate applies. */
export async function rebookForCustomer(customerId: string, code: string, idempotencyKey: string | null) {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()) });
  if (!appt) throw notFound("Appointment");
  if (!(await owns(customerId, appt.customerId))) throw notFound("Appointment");
  const items = await db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appt.id));
  const service = items.find((item) => item.kind === "service" && item.serviceId);
  if (!service?.serviceId) throw new AppError("bad_request", "Nothing to rebook");
  const addonIds = items.filter((item) => item.kind === "addon" && item.serviceId).map((item) => item.serviceId!);
  const desired = toZoned(appt.startsAt).plus({ weeks: REBOOK_WEEKS }).toJSDate();
  const target = localDateOf(desired);
  let slots: { startsAt: string; barberIds: string[] }[] = [];
  for (let day = 0; day < 7 && !slots.length; day++) {
    const avail = await getAvailability({
      shopRef: appt.shopId,
      date: addDays(target, day),
      serviceId: service.serviceId,
      addonIds,
      barberRef: appt.staffId,
    });
    slots = avail.slots.filter((slot) => slot.barberIds.includes(appt.staffId));
  }
  if (!slots.length) throw new AppError("slot_unavailable", "No openings with this barber that day");
  const best = [...slots].sort(
    (a, b) => Math.abs(new Date(a.startsAt).getTime() - desired.getTime()) - Math.abs(new Date(b.startsAt).getTime() - desired.getTime()),
  )[0];
  return createAppointment({
    shopRef: appt.shopId,
    serviceId: service.serviceId,
    addonIds,
    barberRef: appt.staffId,
    startsAt: best.startsAt,
    customerId: appt.customerId,
    source: "api",
    rebookedFromId: appt.id,
    idempotencyKey: idempotencyKey ? `rebook:${idempotencyKey.slice(0, 90)}` : null,
    actor: customerActor("customer"),
  });
}
