import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { customers, staff } from "@/db/schema";
import { FieldKey, customFieldId, isBuiltinField, isContactField, isRevealable } from "@/domain/client-privacy";
import { audit } from "./audit";
import { StaffContext, assertCan, can } from "./auth/staff";
import { clientPolicy, displayFull, recordClientAccess } from "./client-privacy";
import { customerAccess } from "./customers";
import { AppError, forbidden } from "./errors";

export const RevealInput = z.object({
  customerId: z.uuid(),
  field: z.string().refine((f) => isBuiltinField(f) || /^custom:[0-9a-f-]{36}$/.test(f), "Unknown field"),
  reason: z.string().trim().min(4, "Say why you need to see it").max(300),
});

/**
 * Shows one masked detail in full, for someone allowed to reveal, with a reason. Logged with who,
 * when, which client, which field and why, and counted toward the lookup limits. Hidden details
 * can't be revealed, and shop-level contact details only with the brand's contact access.
 */
export async function revealClientField(ctx: StaffContext, raw: z.input<typeof RevealInput>, via = "web") {
  assertCan(ctx, "clients.reveal", "You can't reveal client details");
  const p = RevealInput.parse(raw);
  const field = p.field as FieldKey;
  const policy = await clientPolicy(ctx);
  if (!isRevealable(field)) throw new AppError("bad_request", "That can't be revealed");
  const level = policy.level(field);
  if (level === "hidden") throw forbidden("That detail is hidden for you, so it can't be revealed");
  if (isContactField(field) && !policy.fullContact)
    throw forbidden("Phone numbers, emails and addresses are shown in full at shop level only with contact access from the brand. Call or text the client through the shop line.");
  const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, p.customerId);
  if (!access) throw new AppError("not_found", "Client not found");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, p.customerId) });
  if (!c) throw new AppError("not_found", "Client not found");
  let stored: string | null;
  if (field === "preferred_barber")
    stored = c.preferredStaffId ? ((await db.query.staff.findFirst({ where: eq(staff.id, c.preferredStaffId), columns: { displayLabel: true } }))?.displayLabel ?? null) : null;
  else if (field === "last_name") stored = c.lastName;
  else if (isBuiltinField(field)) stored = (c as Record<string, unknown>)[field] as string | null;
  else stored = c.customFields[customFieldId(field)!] ?? null;
  if (level === "full") return { value: displayFull(field, stored) };
  await recordClientAccess(ctx, { kind: "reveal", customerId: c.id, field, reason: p.reason, ...(via === "web" ? {} : { detail: { via } }) });
  await audit(ctx.actor, "client.reveal", "customer", c.id, { field, reason: p.reason, ...(via === "web" ? {} : { via }) }, ctx.currentShopId);
  return { value: displayFull(field, stored) };
}
