"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { ratingViewer, requireStaff } from "@/server/auth/staff";
import { deleteRating, rateVisit, updateRating } from "@/server/ratings";

const Rate = z.object({
  customerId: z.string().uuid(),
  appointmentId: z.string().uuid().nullable().optional(),
  saleId: z.string().uuid().nullable().optional(),
  stars: z.number().int(),
  note: z.string().optional(),
});

function refresh(customerId: string, saleId?: string | null) {
  revalidatePath(`/admin/customers/${customerId}`);
  revalidatePath("/admin/customers");
  revalidatePath("/admin/calendar");
  if (saleId) revalidatePath(`/admin/sales/${saleId}`);
}

export async function rateVisitAction(raw: z.input<typeof Rate>) {
  return safe(async () => {
    const ctx = await requireStaff();
    const p = Rate.parse(raw);
    const r = await rateVisit(ratingViewer(ctx), ctx.actor, p);
    refresh(p.customerId, p.saleId);
    return r;
  });
}

export async function updateRatingAction(id: string, raw: { stars: number; note?: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    const r = await updateRating(ratingViewer(ctx), ctx.actor, z.string().uuid().parse(id), raw);
    refresh(r.customerId);
    return null;
  });
}

export async function deleteRatingAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const r = await deleteRating(ratingViewer(ctx), ctx.actor, z.string().uuid().parse(id));
    refresh(r.customerId);
    return null;
  });
}
