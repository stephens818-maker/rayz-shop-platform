"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { customers, loyaltyLedger, loyaltyRewards, shops, staff } from "@/db/schema";
import { FieldKey, customFieldId, customFieldKey, isBuiltinField, isRevealable } from "@/domain/client-privacy";
import { rewardExpiry } from "@/domain/loyalty";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, authorize, can, requireStaff } from "@/server/auth/staff";
import { contactClient } from "@/server/client-contact";
import { clientPolicy, displayFull, recordClientAccess, searchReach, showClient } from "@/server/client-privacy";
import { customerAccess, findOrCreateCustomer, matchCustomer, mergeCustomers, searchCustomers } from "@/server/customers";
import { AppError, forbidden } from "@/server/errors";
import { getLoyaltyConfig } from "@/server/loyalty";
import { hasShop, inTenant } from "@/server/tenant";

const Birthday = z
  .string()
  .trim()
  .refine(
    (s) => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && s >= "1900-01-01" && s <= new Date().toISOString().slice(0, 10)),
    "Birthday doesn't look right",
  );

const Profile = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim(),
  phone: z.string().trim(),
  email: z.string().trim(),
  address: z.string().trim().max(200).default(""),
  birthday: Birthday.default(""),
  notes: z.string().trim(),
  custom: z.record(z.string().uuid(), z.string().trim().max(500)).default({}),
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
async function checkRefs(
  ctx: StaffContext,
  p: { homeShopId: string | null; preferredStaffId: string | null },
  before?: { homeShopId: string | null; preferredStaffId: string | null },
) {
  if (p.homeShopId && !(await db.query.shops.findFirst({ where: eq(shops.id, p.homeShopId) }))) throw new AppError("bad_request", "Unknown shop");
  if (p.preferredStaffId && !(await db.query.staff.findFirst({ where: eq(staff.id, p.preferredStaffId) }))) throw new AppError("bad_request", "Unknown barber");
  if (ctx.brandWide) return;
  if (p.homeShopId && p.homeShopId !== before?.homeShopId && !hasShop(ctx, p.homeShopId)) throw forbidden("That shop is outside your access");
  if (p.preferredStaffId && p.preferredStaffId !== before?.preferredStaffId && !(await inTenant(ctx, "staff", p.preferredStaffId)))
    throw new AppError("not_found", "Barber not found");
}

/**
 * The client record is shared by every shop, so anyone who may edit clients may correct it; every
 * change is audited. Only details the editor sees in full can change: the rest stay as they are,
 * since the form never had them.
 */
export async function updateCustomerAction(id: string, raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await authorize("clients.edit");
    const p = Profile.parse(raw);
    const before = await db.query.customers.findFirst({ where: eq(customers.id, id) });
    if (!before) throw new AppError("not_found", "Client not found");
    const policy = await clientPolicy(ctx);
    const full = (f: FieldKey) => policy.level(f) === "full";
    const preferredStaffId = full("preferred_barber") ? p.preferredStaffId : before.preferredStaffId;
    await checkRefs(ctx, { homeShopId: p.homeShopId, preferredStaffId }, before);
    const c = contact(p);
    const customFields = { ...before.customFields };
    for (const f of policy.custom) {
      if (!full(customFieldKey(f.id))) continue;
      const v = p.custom[f.id]?.trim();
      if (v) customFields[f.id] = v;
      else delete customFields[f.id];
    }
    const values = {
      firstName: p.firstName,
      lastName: p.lastName || null,
      phone: full("phone") ? c.phone : before.phone,
      email: full("email") ? c.email : before.email,
      address: full("address") ? p.address || null : before.address,
      birthday: full("birthday") ? p.birthday || null : before.birthday,
      notes: full("notes") ? p.notes || null : before.notes,
      customFields,
      smsOptIn: p.smsOptIn,
      emailOptIn: p.emailOptIn,
      homeShopId: p.homeShopId,
      preferredStaffId,
    };
    await db.update(customers).set(values).where(eq(customers.id, id));
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = Object.fromEntries(
      Object.entries(values)
        .filter(([k, v]) => !same(before[k as keyof typeof before], v))
        .map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]),
    );
    await audit(ctx.actor, "customer.update", "customer", id, changed, ctx.currentShopId);
    revalidatePath(`/admin/customers/${id}`);
    return null;
  });
}

/** Barbers keep cut notes for clients they've served, when they can see the notes. */
export async function updateNotesAction(id: string, notes: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, id);
    if (!access) throw forbidden("You can only edit notes for your own clients");
    if ((await clientPolicy(ctx)).level("notes") !== "full") throw forbidden("Client notes aren't shown to you, so you can't edit them");
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
      const row = await findOrCreateCustomer(
        { firstName: p.firstName, lastName: p.lastName, ...c, smsOptIn: p.smsOptIn, emailOptIn: p.emailOptIn },
        p.homeShopId ?? ctx.currentShopId,
        tx,
        { allowNoContact: true },
      );
      await tx
        .update(customers)
        .set({ notes: p.notes || null, preferredStaffId: p.preferredStaffId, address: p.address || null, birthday: p.birthday || null })
        .where(eq(customers.id, row.id));
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
    const policy = await clientPolicy(ctx);
    const rows = await searchCustomers(q, {}, 8, searchReach(policy));
    await recordClientAccess(ctx, { kind: "search", detail: { results: rows.length, via: "merge" } });
    return rows.map((c) => {
      const s = showClient(policy, c);
      return { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: s.phone, email: s.email };
    });
  });
}

const RevealInput = z.object({
  customerId: z.string().uuid(),
  field: z.string().refine((f) => isBuiltinField(f) || /^custom:[0-9a-f-]{36}$/.test(f), "Unknown field"),
  reason: z.string().trim().min(4, "Say why you need to see it").max(300),
});

/**
 * Show one masked detail in full, for someone allowed to reveal, with a reason. Logged with who,
 * when, which client, which field and why. Hidden details can't be revealed.
 */
export async function revealClientFieldAction(raw: z.input<typeof RevealInput>) {
  return safe(async () => {
    const ctx = await authorize("clients.reveal", "You can't reveal client details");
    const p = RevealInput.parse(raw);
    const field = p.field as FieldKey;
    const policy = await clientPolicy(ctx);
    if (!isRevealable(field)) throw new AppError("bad_request", "That can't be revealed");
    const level = policy.level(field);
    if (level === "hidden") throw forbidden("That detail is hidden for you, so it can't be revealed");
    const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, p.customerId);
    if (!access) throw new AppError("not_found", "Client not found");
    const c = await db.query.customers.findFirst({ where: eq(customers.id, p.customerId) });
    if (!c) throw new AppError("not_found", "Client not found");
    let stored: string | null;
    if (field === "preferred_barber")
      stored = c.preferredStaffId ? ((await db.query.staff.findFirst({ where: eq(staff.id, c.preferredStaffId), columns: { displayLabel: true } }))?.displayLabel ?? null) : null;
    else if (isBuiltinField(field)) stored = (c as Record<string, unknown>)[field] as string | null;
    else stored = c.customFields[customFieldId(field)!] ?? null;
    if (level === "full") return { value: displayFull(field, stored) };
    await recordClientAccess(ctx, { kind: "reveal", customerId: c.id, field, reason: p.reason });
    await audit(ctx.actor, "client.reveal", "customer", c.id, { field, reason: p.reason }, ctx.currentShopId);
    return { value: displayFull(field, stored) };
  });
}

/** Call or text a client through the shop line: the number never reaches the browser. */
export async function contactClientAction(customerId: string, input: { channel: "sms" | "call"; message?: string }) {
  return safe(async () => {
    const ctx = await authorize("clients.message", "You can't call or text clients");
    return contactClient(ctx, customerId, input);
  });
}

export async function grantRewardAction(customerId: string, reason: string) {
  return safe(async () => {
    const ctx = await authorize("loyalty.grant");
    if (!reason.trim()) throw new AppError("bad_request", "Add a reason");
    const cfg = await getLoyaltyConfig();
    const now = new Date();
    await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(loyaltyRewards)
        .values({ customerId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), source: "manual" })
        .returning();
      await tx.insert(loyaltyLedger).values({ customerId, kind: "reward_issued", rewardCents: cfg.rewardCents });
      await audit(ctx.actor, "loyalty.manual_reward", "customer", customerId, { rewardId: r.id, reason }, ctx.currentShopId, tx);
    });
    revalidatePath(`/admin/customers/${customerId}`);
    return null;
  });
}
