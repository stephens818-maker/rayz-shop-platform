"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CONTACT_GRANT_KINDS } from "@/domain/contact-grants";
import { endOfLocalDay, isValidLocalDate } from "@/lib/time";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { giveContactGrant, revokeContactGrant } from "@/server/contact-grants";

const GrantSchema = z.object({
  kind: z.enum(CONTACT_GRANT_KINDS),
  staffId: z.string().uuid().nullable(),
  shopId: z.string().uuid().nullable(),
  /** The last day it's in force (shop time), or none until revoked. */
  until: z
    .string()
    .nullable()
    .refine((d) => !d || isValidLocalDate(d), "Pick a valid end date"),
  note: z.string().trim().max(200).nullable(),
});

function revalidate() {
  revalidatePath("/admin", "layout");
}

/** Let one person, or everyone at one location, see full client contact details or export client lists. */
export async function giveContactGrantAction(raw: z.input<typeof GrantSchema>) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy", "You can't change client data protection");
    const p = GrantSchema.parse(raw);
    const row = await giveContactGrant(ctx, { kind: p.kind, staffId: p.staffId, shopId: p.shopId, expiresAt: p.until ? endOfLocalDay(p.until) : null, note: p.note || null });
    revalidate();
    return row;
  });
}

export async function revokeContactGrantAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy", "You can't change client data protection");
    await revokeContactGrant(ctx, z.string().uuid().parse(id));
    revalidate();
    return null;
  });
}
