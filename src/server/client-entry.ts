import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { FieldKey, Level, customFieldKey } from "@/domain/client-privacy";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit, Actor } from "@/server/audit";
import { ClientPolicy, entered } from "@/server/client-privacy";
import { AppError } from "@/server/errors";
import { stampRecordNote } from "@/server/record-note";

/** A detail the person may type for a new client, and how they'll see it once it's saved. */
export type EntryField = { key: string; label?: string; level: Level };

/** What booking, walk-ins and checkout offer for a new client: only details this person may add. */
export function entryFields(policy: ClientPolicy): EntryField[] {
  return (["phone", "email", "address", "birthday", "notes", ...policy.custom.map((f) => customFieldKey(f.id))] as FieldKey[])
    .filter((f) => policy.canAdd(f))
    .map((f) => ({ key: f, label: policy.custom.find((c) => customFieldKey(c.id) === f)?.label, level: policy.level(f) }));
}

export const EntryDetails = z.object({
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(200).optional(),
  address: z.string().trim().max(200).optional(),
  birthday: z
    .string()
    .trim()
    .refine((s) => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && s >= "1900-01-01" && s <= new Date().toISOString().slice(0, 10)), "Birthday doesn't look right")
    .optional(),
  notes: z.string().trim().max(2000).optional(),
  custom: z.record(z.string().uuid(), z.string().trim().max(500)).optional(),
});
export type EntryDetails = z.input<typeof EntryDetails>;

type Clean = { phone?: string; email?: string; address?: string; birthday?: string; notes?: string; custom: Record<string, string> };

/**
 * Checks every typed detail against "add" before anything is booked, so a refusal leaves nothing
 * half done. Contact details are normalized the way the client form does.
 */
export function checkEntry(policy: ClientPolicy, raw: EntryDetails | null | undefined): Clean {
  const p = EntryDetails.parse(raw ?? {});
  const out: Clean = { custom: {} };
  if (p.phone) {
    const phone = normalizePhone(p.phone);
    if (!phone) throw new AppError("bad_request", "Phone number doesn't look like a US number");
    out.phone = entered(policy, "phone", null, phone) ?? undefined;
  }
  if (p.email) {
    const email = normalizeEmail(p.email);
    if (!email) throw new AppError("bad_request", "Email doesn't look right");
    out.email = entered(policy, "email", null, email) ?? undefined;
  }
  for (const f of ["address", "birthday", "notes"] as const) if (p[f]) out[f] = entered(policy, f, null, p[f]) ?? undefined;
  for (const [id, v] of Object.entries(p.custom ?? {})) {
    if (!v || !policy.custom.some((c) => c.id === id)) continue;
    out.custom[id] = entered(policy, customFieldKey(id), null, v)!;
  }
  return out;
}

/**
 * Fills the details that are still empty on the client: a returning client matched by phone keeps
 * what's on file, since replacing a detail is an edit and the desk forms only add.
 */
export async function fillEntry(customerId: string, d: Clean, who: { actor: Actor; staffId: string; shopId: string | null }) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c) return;
  const set: Partial<typeof customers.$inferInsert> = {};
  for (const f of ["address", "birthday", "notes"] as const) if (d[f] && !c[f]) set[f] = d[f];
  if (d.email && !c.email) set.email = d.email;
  const custom = { ...c.customFields };
  for (const [id, v] of Object.entries(d.custom)) if (!custom[id]) custom[id] = v;
  if (Object.keys(custom).length !== Object.keys(c.customFields).length) set.customFields = custom;
  if (!Object.keys(set).length) return;
  await db.transaction(async (tx) => {
    await tx.update(customers).set(set).where(eq(customers.id, customerId));
    await stampRecordNote(tx, customerId, who.staffId, who.shopId);
  });
  await audit(who.actor, "customer.details_added", "customer", customerId, { fields: Object.keys(set) }, who.shopId);
}
