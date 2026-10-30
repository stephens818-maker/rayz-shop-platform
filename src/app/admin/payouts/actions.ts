"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ReconcileInput } from "@/domain/payout-reconcile";
import { reportExport } from "@/domain/permissions";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { markReconciled, unmarkReconciled } from "@/server/payments/reconcile";

export async function markReconciledAction(raw: z.input<typeof ReconcileInput>) {
  return safe(async () => {
    const ctx = await authorize(reportExport("shop_accounts"), "Matching deposits to the bank needs the payouts export permission");
    await markReconciled(ctx.actor, ctx, raw);
    revalidatePath("/admin/payouts");
  });
}

export async function unmarkReconciledAction(payoutId: string) {
  return safe(async () => {
    const ctx = await authorize(reportExport("shop_accounts"), "Matching deposits to the bank needs the payouts export permission");
    await unmarkReconciled(ctx.actor, ctx, payoutId);
    revalidatePath("/admin/payouts");
  });
}
