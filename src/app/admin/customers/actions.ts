"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { customerTags, customers, loyaltyLedger, loyaltyRewards, shops, staff } from "@/db/schema";
import { FieldKey, ShownField, customFieldId, customFieldKey, isBuiltinField, isRevealable } from "@/domain/client-privacy";
import { rewardExpiry } from "@/domain/loyalty";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, authorize, can, requireStaff } from "@/server/auth/staff";
import { contactClient } from "@/server/client-contact";
import { searchClients } from "@/server/client-search";
import { deleteSearch, saveSearch } from "@/server/saved-searches";
import { ClientPolicy, clientPolicy, displayFull, entered, recordClientAccess, shownField } from "@/server/client-privacy";
import { customerAccess, findOrCreateCustomer, matchCustomer, mergeCustomers } from "@/server/customers";
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

/**
 * A client form. Protected details are optional: a field the form leaves out stays as it is, an
 * empty string clears it. Forms only send what the person may enter (see `entered`).
 */
const Profile = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim(),
  phone: z.string().trim().optional(),
  email: z.string().trim().optional(),
  address: z.string().trim().max(200).optional(),
  birthday: Birthday.optional(),
  notes: z.string().trim().max(2000).optional(),
  custom: z.record(z.string().uuid(), z.string().trim().max(500)).default({}),
  smsOptIn: z.boolean(),
  emailOptIn: z.boolean(),
  allowOtherShop: z.boolean().optional(),
  homeShopId: z.string().uuid().nullable(),
  preferredStaffId: z.string().uuid().nullable().optional(),
});

function contact(p: { phone?: string; email?: string }) {
  const phone = p.phone === undefined ? undefined : p.phone ? normalizePhone(p.phone) : null;
  if (p.phone && !phone) throw new AppError("bad_request", "Phone number doesn't look like a US number");
  const email = p.email === undefined ? undefined : p.email ? normalizeEmail(p.email) : null;
  if (p.email && !email) throw new AppError("bad_request", "Email doesn't look right");
  return { phone, email };
}

type Stored = { phone: string | null; email: string | null; address: string | null; birthday: string | null; notes: string | null; customFields: Record<string, string> };

/** A client's details as the person who just saved them may see them: never more than their level. */
function savedFields(policy: ClientPolicy, c: Stored): ShownField[] {
  return [
    ...(["phone", "email", "address", "birthday", "notes"] as const).map((f) => shownField(policy, f, c[f])),
    ...policy.custom.map((f) => shownField(policy, customFieldKey(f.id), c.customFields[f.id], f.label)),
  ];
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
 * change is audited. Each protected detail changes only as the brand portal allows: filling in an
 * empty one needs "add", replacing one on file needs "edit", whether or not the editor can see it.
 * The answer carries the details at the editor's view level, so a value they can't see isn't sent
 * back even when they just typed it.
 */
export async function updateCustomerAction(id: string, raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await authorize("clients.edit");
    const p = Profile.parse(raw);
    const before = await db.query.customers.findFirst({ where: eq(customers.id, id) });
    if (!before) throw new AppError("not_found", "Client not found");
    const policy = await clientPolicy(ctx);
    const preferredStaffId = entered(policy, "preferred_barber", before.preferredStaffId, p.preferredStaffId);
    await checkRefs(ctx, { homeShopId: p.homeShopId, preferredStaffId }, before);
    const c = contact(p);
    const customFields = { ...before.customFields };
    for (const f of policy.custom) {
      if (!(f.id in p.custom)) continue;
      const v = entered(policy, customFieldKey(f.id), before.customFields[f.id], p.custom[f.id]);
      if (v) customFields[f.id] = v;
      else delete customFields[f.id];
    }
    const values = {
      firstName: p.firstName,
      lastName: p.lastName || null,
      phone: entered(policy, "phone", before.phone, c.phone),
      email: entered(policy, "email", before.email, c.email),
      address: entered(policy, "address", before.address, p.address),
      birthday: entered(policy, "birthday", before.birthday, p.birthday),
      notes: entered(policy, "notes", before.notes, p.notes),
      customFields,
      smsOptIn: p.smsOptIn,
      emailOptIn: p.emailOptIn,
      ...(p.allowOtherShop === undefined ? {} : { allowOtherShop: p.allowOtherShop }),
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
    return { fields: savedFields(policy, values) };
  });
}

/**
 * Barbers keep cut notes for clients they've served. Notes they can't see can still be written
 * over when the portal lets them edit notes; the old ones are never shown.
 */
export async function updateNotesAction(id: string, notes: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, id);
    if (!access) throw forbidden("You can only edit notes for your own clients");
    const before = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { notes: true } });
    if (!before) throw new AppError("not_found", "Client not found");
    const policy = await clientPolicy(ctx);
    const value = entered(policy, "notes", before.notes, notes.trim().slice(0, 2000));
    await db.update(customers).set({ notes: value }).where(eq(customers.id, id));
    await audit(ctx.actor, "customer.notes", "customer", id, { notes: value }, ctx.currentShopId);
    revalidatePath(`/admin/customers/${id}`);
    return { notes: shownField(policy, "notes", value) };
  });
}

/**
 * Runs the same matching as booking: an existing client with this phone/email and a compatible
 * name is returned instead. Every detail given needs "add"; seeing it isn't required, and the
 * answer is only the client's id.
 */
export async function createCustomerAction(raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await authorize("clients.edit");
    const p = Profile.parse(raw);
    const policy = await clientPolicy(ctx);
    const add = (f: FieldKey, v: string | null | undefined) => entered(policy, f, null, v ?? undefined);
    const c = contact(p);
    const fields = {
      phone: add("phone", c.phone),
      email: add("email", c.email),
      address: add("address", p.address),
      birthday: add("birthday", p.birthday),
      notes: add("notes", p.notes),
      preferredStaffId: add("preferred_barber", p.preferredStaffId),
    };
    const customFields: Record<string, string> = {};
    for (const f of policy.custom) {
      const v = add(customFieldKey(f.id), p.custom[f.id]);
      if (v) customFields[f.id] = v;
    }
    await checkRefs(ctx, { homeShopId: p.homeShopId, preferredStaffId: fields.preferredStaffId });
    const existing = fields.phone || fields.email ? await matchCustomer(db, { firstName: p.firstName, lastName: p.lastName, phone: fields.phone, email: fields.email }) : null;
    if (existing) return { id: existing.customer.id, existed: true };
    const created = await db.transaction(async (tx) => {
      const row = await findOrCreateCustomer(
        { firstName: p.firstName, lastName: p.lastName, phone: fields.phone, email: fields.email, smsOptIn: p.smsOptIn, emailOptIn: p.emailOptIn },
        p.homeShopId ?? ctx.currentShopId,
        tx,
        { allowNoContact: true },
      );
      await tx
        .update(customers)
        .set({ notes: fields.notes, preferredStaffId: fields.preferredStaffId, address: fields.address, birthday: fields.birthday, customFields })
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
    return searchClients(ctx, q, { via: "merge", brandWide: true });
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

const Tags = z.array(z.string().trim().min(1).max(40)).max(20, "Up to 20 tags");

/** Labels for segments, like "VIP" or "Student". Replaces the client's tags with these. */
export async function setClientTagsAction(customerId: string, raw: string[]) {
  return safe(async () => {
    const ctx = await authorize("clients.edit");
    if ((await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, customerId)) !== "full") throw new AppError("not_found", "Client not found");
    const tags = [...new Set(Tags.parse(raw).map((t) => t.replace(/\s+/g, " ")))];
    const before = (await db.select({ tag: customerTags.tag }).from(customerTags).where(eq(customerTags.customerId, customerId))).map((r) => r.tag);
    await db.transaction(async (tx) => {
      await tx.delete(customerTags).where(eq(customerTags.customerId, customerId));
      if (tags.length) await tx.insert(customerTags).values(tags.map((tag) => ({ customerId, tag, createdBy: ctx.staff.id })));
      await audit(ctx.actor, "customer.tags", "customer", customerId, { before, after: tags }, ctx.currentShopId, tx);
    });
    revalidatePath(`/admin/customers/${customerId}`);
    return null;
  });
}

export async function saveClientSearchAction(input: unknown) {
  return safe(async () => {
    const ctx = await requireStaff();
    const id = await saveSearch(ctx, input);
    revalidatePath("/admin/customers");
    return { id };
  });
}

export async function deleteClientSearchAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await deleteSearch(ctx, z.uuid().parse(id));
    revalidatePath("/admin/customers");
  });
}

/** The sidebar's client search: the same search as the client list, so barbers find only clients they've had. */
export async function quickFindClientsAction(q: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    return searchClients(ctx, q, { via: "header", limit: 6, ownClientsOf: can(ctx, "clients.view_all") ? undefined : ctx.staff.id });
  });
}
