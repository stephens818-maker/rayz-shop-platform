import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { normalizeEmail } from "@/lib/phone";
import { body, json, options, route } from "@/server/api";
import { UpdateMe } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { resolveStaffRef } from "@/server/catalog";
import { recordConsentChange, requestConsentContext } from "@/server/consent-events";
import { AppError, notFound } from "@/server/errors";
import { publicMe } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async (req) => json(await publicMe(await requireCustomer(req))));
export const PATCH = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, UpdateMe);
  const patch: Partial<typeof customers.$inferInsert> = {};
  if (b.firstName !== undefined) patch.firstName = b.firstName.trim();
  if (b.lastName !== undefined) patch.lastName = b.lastName?.trim() || null;
  if (b.email !== undefined) {
    const email = normalizeEmail(b.email);
    const current = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { email: true, receiptDelivery: true } });
    if (email && email !== current?.email) throw new AppError("bad_request", "Confirm a new email with a code: POST /me/email/start, then /me/email/verify", { field: "email" });
    if (!email) Object.assign(patch, { email: null, emailVerifiedAt: null }, current?.receiptDelivery === "email" ? { receiptDelivery: null } : {});
  }
  if (b.smsOptIn !== undefined) patch.smsOptIn = b.smsOptIn;
  if (b.emailOptIn !== undefined) patch.emailOptIn = b.emailOptIn;
  if (b.preferencesNote !== undefined) {
    patch.preferencesNote = b.preferencesNote?.trim() || null;
    patch.preferencesUpdatedAt = new Date();
  }
  if (b.receiptDelivery !== undefined) {
    if (b.receiptDelivery === "email") {
      const c = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { email: true, emailVerifiedAt: true } });
      if (!c?.email || !c.emailVerifiedAt) throw new AppError("bad_request", "Verify an email first: POST /me/email/start, then /me/email/verify", { field: "receiptDelivery" });
    }
    patch.receiptDelivery = b.receiptDelivery;
  }
  if (b.preferredBarberId !== undefined) {
    const barber = b.preferredBarberId ? await resolveStaffRef(b.preferredBarberId) : null;
    if (b.preferredBarberId && (!barber || !barber.active || !barber.isBookable)) throw notFound("Barber");
    patch.preferredStaffId = barber?.id ?? null;
  }
  if (Object.keys(patch).length)
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(customers).where(eq(customers.id, id)).for("update");
      await tx.update(customers).set(patch).where(eq(customers.id, id));
      await recordConsentChange(tx, { id, phone: before.phone, email: patch.email === null ? null : before.email }, before, patch, requestConsentContext(req));
    });
  return json(await publicMe(id));
});
