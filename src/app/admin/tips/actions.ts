"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { tipPayoutBatches, tipPayouts } from "@/db/schema";
import { TIP_METHODS, TIP_SCHEDULES } from "@/domain/tips";
import { addDays, isValidLocalDate, todayLocal } from "@/lib/time";
import { safe } from "@/server/action";
import { StaffContext, assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, notFound } from "@/server/errors";
import { requireInTenant } from "@/server/tenant";
import { saveShopTipSettings, setShopTipToBarber, shopTipConfig } from "@/server/tips/ledger";
import { acknowledgeCashPayout, adjustPayout, approveBatch, buildBatch, cancelBatch, holdPayout, releasePayout, removePayout } from "@/server/tips/payouts";

function refresh(batchId?: string) {
  revalidatePath("/admin/tips");
  if (batchId) revalidatePath(`/admin/tips/${batchId}`);
  revalidatePath("/admin/drawer");
  revalidatePath("/admin/my-tips");
}

async function batchIn(ctx: StaffContext, batchId: string) {
  await requireInTenant(ctx, "tip_payout_batch", batchId);
  const b = await db.query.tipPayoutBatches.findFirst({ where: eq(tipPayoutBatches.id, batchId) });
  if (!b) throw notFound("Tip payout batch");
  return b;
}

async function payoutIn(ctx: StaffContext, payoutId: string) {
  await requireInTenant(ctx, "tip_payout", payoutId);
  const p = await db.query.tipPayouts.findFirst({ where: eq(tipPayouts.id, payoutId) });
  if (!p) throw notFound("Tip payout");
  return p;
}

/** Builds or refreshes the shop's draft batch for its schedule, through the cutoff (by default today for end of night and manual, yesterday for daily and weekly). */
export async function buildBatchAction(input: { shopId: string; cutoff?: string }) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    assertShopAccess(ctx, input.shopId);
    const s = await shopTipConfig(input.shopId);
    if (s.schedule === "payroll") throw new AppError("conflict", "This shop pays tips through payroll only.");
    const today = todayLocal();
    const cutoff = input.cutoff && isValidLocalDate(input.cutoff) ? input.cutoff : s.schedule === "daily_delay" || s.schedule === "weekly" ? addDays(today, -1) : today;
    if (cutoff > today) throw new AppError("bad_request", "The cutoff can't be in the future.");
    const r = await buildBatch({ shopId: input.shopId, kind: s.schedule, cutoff, asOf: today, actor: ctx.actor });
    refresh(r.batchId);
    return r;
  });
}

export async function approveBatchAction(batchId: string) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    await batchIn(ctx, batchId);
    const r = await approveBatch(batchId, ctx.actor);
    refresh(batchId);
    return r;
  });
}

export async function cancelBatchAction(batchId: string, reason: string) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    await batchIn(ctx, batchId);
    await cancelBatch(batchId, reason, ctx.actor);
    refresh(batchId);
    return null;
  });
}

export async function payoutAction(input: { payoutId: string; action: "hold" | "release" | "remove" | "adjust"; reason?: string; cents?: number }) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    const p = await payoutIn(ctx, input.payoutId);
    const reason = input.reason ?? "";
    if (input.action === "hold") await holdPayout(p.id, reason, ctx.actor);
    else if (input.action === "release") await releasePayout(p.id, ctx.actor);
    else if (input.action === "remove") await removePayout(p.id, reason, ctx.actor);
    else await adjustPayout(p.id, input.cents ?? 0, reason, ctx.actor);
    refresh(p.batchId);
    return null;
  });
}

/** The employee takes their cash tips from the drawer and acknowledges them on the shop's device. */
export async function acknowledgeCashAction(input: { payoutId: string; by: "pin" | "name"; pin?: string; name?: string }) {
  return safe(async () => {
    const ctx = await authorize(["drawer.manage", "tips.approve"]);
    const p = await payoutIn(ctx, input.payoutId);
    await acknowledgeCashPayout({ payoutId: p.id, by: input.by, pin: input.pin, name: input.name, actor: ctx.actor });
    refresh(p.batchId);
    return null;
  });
}

const shopSchema = z.object({
  schedule: z.enum(TIP_SCHEDULES),
  cardDelayDays: z.number().int().min(0, "The delay can't be negative").max(14, "Use a delay of 14 days or less"),
  weeklyDay: z.number().int().min(0).max(6),
  defaultMethod: z.enum(TIP_METHODS),
});

export async function setShopTipToBarberAction(shopId: string, on: boolean) {
  return safe(async () => {
    const ctx = await authorize("tips.settings");
    assertShopAccess(ctx, shopId);
    if (!ctx.isOwner) throw new AppError("forbidden", "Only the Brand Owner can turn tips to barbers' Stripe accounts on or off");
    const r = await setShopTipToBarber(shopId, z.boolean().parse(on), ctx.actor);
    refresh();
    revalidatePath("/admin/tips/settings");
    revalidatePath("/admin/tips/tracker");
    return r;
  });
}

export async function saveShopTipSettingsAction(shopId: string, input: z.input<typeof shopSchema>) {
  return safe(async () => {
    const ctx = await authorize("tips.settings");
    assertShopAccess(ctx, shopId);
    const r = await saveShopTipSettings(shopId, shopSchema.parse(input), ctx.actor);
    refresh();
    revalidatePath("/admin/tips/settings");
    return r;
  });
}
