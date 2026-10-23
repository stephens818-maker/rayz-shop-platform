import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { body, json, options, route } from "@/server/api";
import { UpdateMe } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { AppError, notFound } from "@/server/errors";
import { recordConsent } from "@/server/mobile/consent";
import { readClient } from "@/server/mobile/client";
import { publicMe } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async (req) => json(await publicMe(await requireCustomer(req))));

const CHANNELS = [
  ["smsOptIn", "sms_transactional"],
  ["emailOptIn", "email"],
  ["smsMarketingOptIn", "sms_marketing"],
  ["emailMarketingOptIn", "email_marketing"],
  ["pushTransactional", "push_transactional"],
  ["pushMarketing", "push_marketing"],
] as const;

export const PATCH = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, UpdateMe);
  const info = readClient(req);
  const current = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!current || current.deletedAt) throw notFound("Customer");
  const source = info.client === "ios" || info.client === "android" ? info.client : "web";
  for (const [field, channel] of CHANNELS) {
    if (b[field] === undefined || b[field] === current[field]) continue;
    if (b[field] === true && !b.consentTextVersion) throw new AppError("bad_request", "consentTextVersion is required to opt in.");
    await recordConsent({
      customerId: id,
      phone: current.phone,
      email: current.email,
      channel,
      action: b[field] ? "granted" : "revoked",
      source,
      appVersion: info.appVersion,
      textVersion: b.consentTextVersion,
    });
  }
  const patch: Partial<typeof customers.$inferInsert> = {};
  if (b.firstName !== undefined) patch.firstName = b.firstName.trim();
  if (b.lastName !== undefined) patch.lastName = b.lastName?.trim() || null;
  if (b.homeShopId !== undefined) patch.homeShopId = b.homeShopId;
  if (b.preferredBarberId !== undefined) patch.preferredStaffId = b.preferredBarberId;
  if (b.birthday !== undefined) patch.birthday = b.birthday;
  if (b.preferences !== undefined) patch.preferences = b.preferences;
  if (b.notes !== undefined) patch.preferences = b.notes;
  if (b.secureProfile !== undefined) patch.secureProfile = b.secureProfile;
  if (Object.keys(patch).length) await db.update(customers).set(patch).where(eq(customers.id, id));
  return json(await publicMe(id));
});
