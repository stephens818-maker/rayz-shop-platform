"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { markIsolvedSent, undoIsolvedSent } from "@/server/payroll/reports";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Marking a period's file sent is a brand decision, like approving and locking it. */
async function approver() {
  const ctx = await authorize("payroll.approve");
  if (!ctx.brandWide) throw forbidden("Only someone with every shop can mark the iSolved file sent.");
  return ctx;
}

export async function markIsolvedSentAction(start: string, end: string, note: string) {
  return safe(async () => {
    const ctx = await approver();
    await markIsolvedSent(date.parse(start), date.parse(end), ctx.actor, z.string().max(300).parse(note) || null);
    revalidatePath("/admin/reports/payroll", "layout");
    return null;
  });
}

export async function undoIsolvedSentAction(start: string, end: string, reason: string) {
  return safe(async () => {
    const ctx = await approver();
    await undoIsolvedSent(date.parse(start), date.parse(end), ctx.actor, z.string().max(300).parse(reason));
    revalidatePath("/admin/reports/payroll", "layout");
    return null;
  });
}
