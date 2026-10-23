/**
 * Online bookings started and not finished, for the abandoned-booking campaign. The booking page
 * keeps one draft per visit under a random token. Only ids are stored: the service, the barber, the
 * time picked and the client once they're known (signed in, or by the phone or email they typed).
 * Whether the client hears about it is the campaign's call, and it needs their marketing consent.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appointments, bookingDrafts, customers, services, shops, staff } from "@/db/schema";
import { normalizePhone } from "@/lib/phone";
import { AppError } from "./errors";
import { consentColumns } from "./marketing/consent";

const DraftInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  shopSlug: z.string().min(1).max(80),
  serviceId: z.uuid().nullable().default(null),
  barberSlug: z.string().max(80).nullable().default(null),
  startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  phone: z.string().max(40).nullable().default(null),
  email: z.string().max(200).nullable().default(null),
});

async function customerByContact(phone: string | null, email: string | null): Promise<string | null> {
  const p = normalizePhone(phone);
  const e = email?.trim().toLowerCase() || null;
  if (!p && !e) return null;
  const cols = await consentColumns();
  const live = cols.deleted ? sql`deleted_at is null` : sql`true`;
  const [c] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(p ? eq(customers.phone, p) : sql`lower(${customers.email}) = ${e}`, live))
    .orderBy(customers.createdAt)
    .limit(1);
  return c?.id ?? null;
}

/** Creates or updates this visit's draft. A draft that became a booking isn't touched again. */
export async function saveBookingDraft(input: unknown, signedInCustomerId: string | null, now = new Date()): Promise<void> {
  const r = DraftInput.safeParse(input);
  if (!r.success) throw new AppError("bad_request", "Couldn't save the booking");
  const v = r.data;
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.slug, v.shopSlug));
  if (!shop) throw new AppError("not_found", "Shop not found");
  const [svc] = v.serviceId ? await db.select({ id: services.id }).from(services).where(eq(services.id, v.serviceId)) : [];
  const [barber] = v.barberSlug && v.barberSlug !== "any" ? await db.select({ id: staff.id }).from(staff).where(eq(staff.publicSlug, v.barberSlug)) : [];
  const customerId = signedInCustomerId ?? (await customerByContact(v.phone, v.email));
  const row = { shopId: shop.id, serviceId: svc?.id ?? null, staffId: barber?.id ?? null, startsAt: v.startsAt ? new Date(v.startsAt) : null, updatedAt: now };
  await db
    .insert(bookingDrafts)
    .values({ token: v.token, ...row, customerId, createdAt: now })
    .onConflictDoUpdate({
      target: bookingDrafts.token,
      set: { ...row, customerId: customerId ? sql`${customerId}::uuid` : sql`${bookingDrafts.customerId}` },
      setWhere: isNull(bookingDrafts.appointmentId),
    });
}

/** The booking went through: the draft is done. */
export async function finishBookingDraft(token: string, appointmentCode: string): Promise<void> {
  if (!/^[A-Za-z0-9-]{16,64}$/.test(token)) return;
  const [a] = await db.select({ id: appointments.id, customerId: appointments.customerId }).from(appointments).where(eq(appointments.code, appointmentCode.trim().toUpperCase()));
  if (!a) return;
  await db
    .update(bookingDrafts)
    .set({ appointmentId: a.id, customerId: a.customerId, updatedAt: new Date() })
    .where(and(eq(bookingDrafts.token, token), isNull(bookingDrafts.appointmentId)));
}
