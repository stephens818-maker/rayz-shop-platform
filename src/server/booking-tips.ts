import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments, shops } from "@/db/schema";
import { cleanNotificationPrefs, reminderHours } from "@/domain/staff-notifications";
import { customerActor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { shopReminderHours } from "./location-defaults";
import { staffBookingOptions } from "./timing";

export const MAX_BOOKING_TIP_CENTS = 200_00;

export interface TipOffer {
  /** Offered right after booking (the barber's "Booking tip"). */
  bookingTip: boolean;
  /** Offered on the confirmation and manage page (the barber's "Confirmation tip"). */
  confirmationTip: boolean;
  presets: number[];
  estimateCents: number;
  tipCents: number;
  /** Still changeable: booked or confirmed and not started. */
  open: boolean;
  reminders: { firstHours: number; secondHours: number };
}

/** What the manage page offers for this appointment, from its barber's options at its shop. */
export async function tipOffer(code: string, now = new Date()): Promise<TipOffer | null> {
  const a = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()) });
  if (!a) return null;
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, a.shopId) });
  if (!shop) return null;
  const [o, person, location] = await Promise.all([
    staffBookingOptions(shop, [a.staffId]).then((m) => m.get(a.staffId)!),
    db.query.staff.findFirst({ where: (s, { eq }) => eq(s.id, a.staffId), columns: { notificationPrefs: true } }),
    shopReminderHours(shop.id),
  ]);
  return {
    bookingTip: o.bookingTip.value,
    confirmationTip: o.confirmationTip.value,
    presets: shop.tipPresets?.length ? shop.tipPresets : [20, 25, 30],
    estimateCents: a.estimateCents,
    tipCents: a.bookingTipCents,
    open: (a.status === "booked" || a.status === "confirmed") && a.startsAt > now,
    reminders: reminderHours(person ? cleanNotificationPrefs(person.notificationPrefs) : null, location),
  };
}

/** The client's tip for their barber, chosen online; filled in on the ticket at checkout. Audited. */
export async function setBookingTip(code: string, cents: number, now = new Date()) {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_BOOKING_TIP_CENTS) throw new AppError("bad_request", "Pick a tip from $0 to $200");
  const offer = await tipOffer(code, now);
  if (!offer) throw notFound("Appointment");
  if (!offer.bookingTip && !offer.confirmationTip) throw new AppError("forbidden", "Tips aren't taken online for this barber");
  if (!offer.open) throw new AppError("conflict", "This appointment can't be changed online any more");
  const a = (await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()), columns: { id: true, shopId: true, bookingTipCents: true } }))!;
  await db.transaction(async (tx) => {
    await tx.update(appointments).set({ bookingTipCents: cents }).where(eq(appointments.id, a.id));
    await audit(customerActor("booking page"), "appointment.booking_tip", "appointment", a.id, { before: a.bookingTipCents, after: cents }, a.shopId, tx);
  });
  return cents;
}
