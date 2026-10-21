"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { customers, loyaltyLedger, loyaltyRewards, shops, staff } from "@/db/schema";
import { rewardExpiry } from "@/domain/loyalty";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, authorize, can, requireStaff } from "@/server/auth/staff";
import { customerAccess, findOrCreateCustomer, matchCustomer, mergeCustomers, searchCustomers } from "@/server/customers";
import { AppError, forbidden } from "@/server/errors";
import { getLoyaltyConfig } from "@/server/loyalty";
import { hasShop, inTenant } from "@/server/tenant";

const Profile = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim(),
  phone: z.string().trim(),
  email: z.string().trim(),
  notes: z.string().trim(),
  smsOptIn: z.boolean(),
  emailOptIn: z.boolean(),
  homeShopId: z.string().uuid().nullable(),
  preferredStaffId: z.string().uuid().nullable(),
});

function contact(p: { phone: string; email: string }) {
  const phone = p.phone ? normalizePhone(p.phone) : null;
  if (p.phone && !phone) throw new AppError("bad_request", "Phone number doesn't look like a US number");
  const email = p.email ? normalizeEmail(p.email) : null;
  if (p.email && !email) throw new AppError("bad_request", "Email doesn't look right");
  return { phone, email };
}

/** A shop workspace can point a client only at its own shops and barbers; what's on file from elsewhere can stay. */
async function checkRefs(ctx: StaffContext, p: { homeShopId: string | null; preferredStaffId: string | null }, before?: { homeShopId: string | null; preferredStaffId: string | null }) {
  if (p.homeShopId && !(await db.query.shops.findFirst({ where: eq(shops.id, p.homeShopId) }))) throw new AppError("bad_request", "Unknown shop");
  if (p.preferredStaffId && !(await db.query.staff.findFirst({ where: eq(staff.id, p.preferredStaffId) }))) throw new AppError("bad_request", "Unknown barber");
  if (ctx.brandWide) return;
  if (p.homeShopId && p.homeShopId !== before?.homeShopId && !hasShop(ctx, p.homeShopId)) throw new AppError("bad_request", "Unknown shop");
  if (p.preferredStaffId && p.preferredStaffId !== before?.preferredStaffId && !(await inTenant(ctx, "staff", p.preferredStaffId))) throw new AppError("bad_request", "Unknown barber");
}

/**
 * The client record is shared by every shop, so anyone who may edit clients may correct it; every
 * change is audited. Without contact access the phone and email are hidden, so they stay as they are.
 */
export async function updateCustomerAction(id: string, raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await authorize("clients.edit");
    const p = Profile.parse(raw);
    const before = await db.query.customers.findFirst({ where: eq(customers.id, id) });
    if (!before) throw new AppError("not_found", "Client not found");
    await checkRefs(ctx, p, before);
    const reach = can(ctx, "clients.contact") ? contact(p) : { phone: before.phone, email: before.email };
    const values = { firstName: p.firstName, lastName: p.lastName || null, ...reach, notes: p.notes || null, smsOptIn: p.smsOptIn, emailOptIn: p.emailOptIn, homeShopId: p.homeShopId, preferredStaffId: p.preferredStaffId };
    await db.update(customers).set(values).where(eq(customers.id, id));
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => before[k as keyof typeof before] !== v).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]));
    await audit(ctx.actor, "customer.update", "customer", id, changed, ctx.currentShopId);
    revalidatePath(`/admin/customers/${id}`);
    return null;
  });
}

/** Barbers keep cut notes for clients they've served. */
export async function updateNotesAction(id: string, notes: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, id);
    if (!access) throw forbidden("You can only edit notes for your own clients");
    const value = notes.trim().slice(0, 2000) || null;
    await db.update(customers).set({ notes: value }).where(eq(customers.id, id));
    await audit(ctx.actor, "customer.notes", "customer", id, { notes: value }, ctx.currentShopId);
    revalidatePath(`/admin/customers/${id}`);
    return null;
  });
}

const NewClient = Profile.omit({ notes: true }).extend({ notes: z.string().trim().default("") });

/** Runs the same matching as booking: an existing client with this phone/email and a compatible name is returned instead. */
export async function createCustomerAction(raw: z.input<typeof NewClient>) {
  return safe(async () => {
    const ctx = await authorize("clients.edit");
    const p = NewClient.parse(raw);
    await checkRefs(ctx, p);
    const c = contact(p);
    const existing = c.phone || c.email ? await matchCustomer(db, { firstName: p.firstName, lastName: p.lastName, ...c }) : null;
    if (existing) return { id: existing.customer.id, existed: true };
    const created = await db.transaction(async (tx) => {
      const row = await findOrCreateCustomer({ firstName: p.firstName, lastName: p.lastName, ...c, smsOptIn: p.smsOptIn, emailOptIn: p.emailOptIn }, p.homeShopId ?? ctx.currentShopId, tx, { allowNoContact: true });
      await tx.update(customers).set({ notes: p.notes || null, preferredStaffId: p.preferredStaffId }).where(eq(customers.id, row.id));
      return row;
    });
    await audit(ctx.actor, "customer.create", "customer", created.id, { firstName: p.firstName }, ctx.currentShopId);
    revalidatePath("/admin/customers");
    return { id: created.id, existed: false };
  });
}

export async function mergeCustomersAction(keepId: string, dropId: string) {
  return safe(async () => {
    const ctx = await authorize("clients.merge");
    const r = await mergeCustomers(keepId, dropId, ctx.actor);
    revalidatePath("/admin/customers");
    revalidatePath("/admin/customers/duplicates");
    revalidatePath(`/admin/customers/${keepId}`);
    return r;
  });
}

export async function findClientsAction(q: string) {
  return safe(async () => {
    const ctx = await authorize("clients.merge");
    if (q.trim().length < 2) return [];
    const reach = can(ctx, "clients.contact");
    return (await searchCustomers(q, {}, 8)).map((c) => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, phone: reach ? c.phone : null, email: reach ? c.email : null }));
  });
}

export async function grantRewardAction(customerId: string, reason: string) {
  return safe(async () => {
    const ctx = await authorize("loyalty.grant");
    if (!reason.trim()) throw new AppError("bad_request", "Add a reason");
    const cfg = await getLoyaltyConfig();
    const now = new Date();
    await db.transaction(async (tx) => {
      const [r] = await tx.insert(loyaltyRewards).values({ customerId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), source: "manual" }).returning();
      await tx.insert(loyaltyLedger).values({ customerId, kind: "reward_issued", rewardCents: cfg.rewardCents });
      await audit(ctx.actor, "loyalty.manual_reward", "customer", customerId, { rewardId: r.id, reason }, ctx.currentShopId, tx);
    });
    revalidatePath(`/admin/customers/${customerId}`);
    return null;
  });
}
