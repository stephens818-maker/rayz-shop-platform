"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isValidLocalDate } from "@/lib/time";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { importSquireReport, savePlan, signCleanPeriod } from "@/server/rollout";

const Shop = z.string().uuid();
const Day = z.string().refine(isValidLocalDate, "Enter a date");
const DayOrNull = z
  .string()
  .trim()
  .transform((d) => d || null)
  .refine((d) => d === null || isValidLocalDate(d), "Enter a date");

const refresh = () => {
  revalidatePath("/admin/rollout");
  revalidatePath("/admin/payroll/report");
};

/** A shop's place in the rollout: its wave, planned go-live day, first pay period paid from here, and Squire backup. */
export async function savePlanAction(shopId: string, v: { wave: number; plannedOn: string; payrollFrom: string; squireBackupUntil: string; note: string }) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    assertShopAccess(ctx, Shop.parse(shopId));
    const p = z.object({ wave: z.union([z.literal(1), z.literal(2)]), plannedOn: DayOrNull, payrollFrom: DayOrNull, squireBackupUntil: DayOrNull, note: z.string().max(300) }).parse(v);
    await savePlan(ctx.actor, shopId, { ...p, note: p.note || null });
    refresh();
    return null;
  });
}

/** The shop's Squire Commissions report for a pay period paid from Squire data. */
export async function importSquireAction(shopId: string, periodStart: string, file: { name: string; text: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    assertShopAccess(ctx, Shop.parse(shopId));
    const f = z.object({ name: z.string().max(200), text: z.string().min(1).max(2_000_000) }).parse(file);
    const r = await importSquireReport(ctx.actor, shopId, Day.parse(periodStart), { name: f.name || null, text: f.text });
    refresh();
    return r;
  });
}

/** An owner signs off the pilot's clean pay period; the rest of the shops can switch from then on. */
export async function signCleanPeriodAction(shopId: string, periodStart: string, note: string) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    assertShopAccess(ctx, Shop.parse(shopId));
    await signCleanPeriod(ctx.actor, shopId, Day.parse(periodStart), z.string().max(300).parse(note));
    refresh();
    revalidatePath("/admin/cutover");
    return null;
  });
}
