import "server-only";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customerTags, customers, shops, staff } from "@/db/schema";
import { BUILTIN_FIELDS, FieldKey, customFieldKey } from "@/domain/client-privacy";
import { can, ratingViewer } from "@/server/auth/staff";
import { shownBadges } from "@/server/badges";
import { contactClient } from "@/server/client-contact";
import { listNotes } from "@/server/client-notes";
import { clientPolicy, recordClientAccess, shownField } from "@/server/client-privacy";
import { revealClientField } from "@/server/client-reveal";
import { searchClients } from "@/server/client-search";
import { customerAccess } from "@/server/customers";
import { notFound } from "@/server/errors";
import { ratingHistory, ratingSummary } from "@/server/ratings";
import type { StaffAppContext } from "./http";

/**
 * The client card on the phone (ST-C4) and calling or texting through the shop line (ST-I5). Every
 * field is as Client data protection shows it to the caller (hidden fields are left out, masked ones
 * come back masked), each look is in the access log and counts toward the lookup limits, and there's
 * no export. Contact details never come back at all: calls and texts go through the shop line.
 */

const CONTACT: readonly FieldKey[] = ["phone", "email", "address"];
const VISITS = 20;

async function reach(ctx: StaffAppContext, customerId: string) {
  const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, customerId);
  if (!access) throw notFound("Client");
  return access;
}

/** GET /clients?q=: up to 20, best first. Without "every client", only clients they've served. Logged, never the term. */
export async function findClientsFor(ctx: StaffAppContext, q: string, limit = 20) {
  const hits = await searchClients(ctx, q, { via: "staff_app", limit: Math.min(limit, 20), ownClientsOf: can(ctx, "clients.view_all") ? undefined : ctx.staff.id });
  return {
    clients: hits.map((h) => ({
      id: h.id,
      number: h.number,
      firstName: h.firstName,
      lastName: h.lastName,
      short: h.short,
      nickname: h.nickname,
      lastVisit: h.lastVisit,
      barber: h.barber,
      rating: h.rating,
      badges: h.badges ?? [],
      matched: h.matched,
      family: h.family ?? null,
    })),
  };
}

/** GET /clients/{id}: the card. A client they may not open is not found. */
export async function clientCard(ctx: StaffAppContext, customerId: string) {
  const access = await reach(ctx, customerId);
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c) throw notFound("Client");
  await recordClientAccess(ctx, { kind: "view", customerId, detail: { via: "staff_app" } });
  const policy = await clientPolicy(ctx);
  const label = async (id: string | null) => (id ? ((await db.query.staff.findFirst({ where: eq(staff.id, id), columns: { displayLabel: true } }))?.displayLabel ?? null) : null);
  const [preferred, home, visits, [{ visitCount }], notes, badges, tags, summary] = await Promise.all([
    label(c.preferredStaffId),
    c.homeShopId ? db.query.shops.findFirst({ where: eq(shops.id, c.homeShopId), columns: { id: true, name: true } }) : null,
    db
      .select({ a: appointments, shop: shops.name, barber: staff.displayLabel })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(eq(appointments.customerId, customerId))
      .orderBy(desc(appointments.startsAt))
      .limit(VISITS),
    db.select({ visitCount: sql<number>`count(*)::int` }).from(appointments).where(eq(appointments.customerId, customerId)),
    listNotes(ctx, customerId),
    shownBadges(policy, [customerId]),
    access === "full" ? db.select({ tag: customerTags.tag }).from(customerTags).where(eq(customerTags.customerId, customerId)).orderBy(asc(customerTags.tag)) : [],
    ratingSummary(customerId),
  ]);
  const items = visits.length
    ? await db
        .select({ appointmentId: appointmentItems.appointmentId, name: appointmentItems.name })
        .from(appointmentItems)
        .where(inArray(appointmentItems.appointmentId, visits.map((v) => v.a.id)))
        .orderBy(asc(appointmentItems.kind))
    : [];
  const stored: Record<string, string | null> = { last_name: c.lastName, birthday: c.birthday, notes: c.notes, preferred_barber: preferred };
  const fields = [
    ...BUILTIN_FIELDS.map((f) => f.key).filter((k) => !CONTACT.includes(k) && k !== "ratings" && k in stored),
    ...policy.custom.map((f) => customFieldKey(f.id)),
  ]
    .map((k) => {
      const key = k as FieldKey;
      const f = shownField(policy, key, k.startsWith("custom:") ? c.customFields[k.slice(7)] : stored[k]);
      return { key, label: f.label, level: f.level, value: f.value, onFile: f.saved, canReveal: policy.mayReveal(key) };
    })
    .filter((f) => f.level !== "hidden");
  const ratings = policy.ratingDetail ? await ratingHistory(ratingViewer(ctx), customerId, ctx.brandWide ? undefined : ctx.shopIds) : [];
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: policy.show("last_name", c.lastName),
    access,
    fields,
    contact: { hasPhone: !!c.phone, hasEmail: !!c.email, textsOk: c.smsOptIn, emailsOk: c.emailOptIn, canContact: can(ctx, "clients.message") },
    preferences: {
      preferredBarber: policy.show("preferred_barber", preferred),
      homeShop: home ? { id: home.id, name: home.name } : null,
    },
    tags: tags.map((t) => t.tag),
    badges: badges.get(customerId) ?? [],
    rating: policy.stars(summary),
    ratings: ratings.map((r) => ({ stars: r.stars, note: r.note ?? null, at: r.createdAt, by: r.ratedBy ?? null })),
    notes,
    visitCount,
    visits: visits.map((v) => ({
      appointmentId: v.a.id,
      startsAt: v.a.startsAt.toISOString(),
      status: v.a.status,
      shop: v.shop,
      barber: v.barber,
      mine: v.a.staffId === ctx.staff.id,
      services: items.filter((i) => i.appointmentId === v.a.id).map((i) => i.name),
    })),
  };
}

/** POST /clients/{id}/reveal: one masked detail in full with a reason; contact details stay with the shop line. */
export async function revealForApp(ctx: StaffAppContext, customerId: string, v: { field: string; reason: string }) {
  if (CONTACT.includes(v.field as FieldKey)) throw notFound("Field");
  return revealClientField(ctx, { customerId, field: v.field, reason: v.reason }, "staff_app");
}

/** POST /clients/{id}/contact: a call bridged through the shop line, or a text from the shop's number, consent-checked. The number never comes back. */
export async function contactForApp(ctx: StaffAppContext, customerId: string, v: { channel: "sms" | "call"; message?: string }) {
  await reach(ctx, customerId);
  const r = await contactClient(ctx, customerId, v);
  return { status: r.status, channel: v.channel };
}
