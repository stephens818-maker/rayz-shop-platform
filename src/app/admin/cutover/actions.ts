"use server";

import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { eq } from "drizzle-orm";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { CUTOVER_FILES, handBack, reconcileShop, recordFreeze, signOffAndSwitch } from "@/server/cutover";
import { AppError } from "@/server/errors";
import { importYtd, recordCpaSignOff, setPayoutCutoverDates, signOffPayoutReport } from "@/server/payout-cutover";
import { setSquireTipsEnd } from "@/server/tips/onboarding";
import { isValidLocalDate } from "@/lib/time";

const Shop = z.string().uuid();

const refresh = (shopId: string) => {
  revalidatePath("/admin/cutover");
  revalidatePath(`/admin/cutover/${shopId}`);
};

/** `local` is a datetime-local value in the shop's own time zone. */
export async function recordFreezeAction(shopId: string, local: string) {
  return safe(async () => {
    const ctx = await authorize("import.run");
    assertShopAccess(ctx, Shop.parse(shopId));
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { timezone: true } });
    const at = DateTime.fromISO(z.string().min(16).parse(local), { zone: shop?.timezone ?? "America/Chicago" });
    if (!at.isValid) throw new AppError("bad_request", "Enter the date and time Squire booking was turned off");
    await recordFreeze(ctx.actor, shopId, at.toJSDate());
    refresh(shopId);
    return null;
  });
}

const Files = z.object(
  Object.fromEntries(CUTOVER_FILES.map((f) => [f, z.object({ name: z.string().max(200), csv: z.string().min(1) }).optional()])) as Record<
    (typeof CUTOVER_FILES)[number],
    z.ZodOptional<z.ZodObject<{ name: z.ZodString; csv: z.ZodString }>>
  >,
);

export async function reconcileAction(shopId: string, files: z.input<typeof Files>) {
  return safe(async () => {
    const ctx = await authorize("import.run");
    assertShopAccess(ctx, Shop.parse(shopId));
    const r = await reconcileShop(ctx.actor, shopId, Files.parse(files));
    refresh(shopId);
    return { matched: r.matched, missing: r.missing };
  });
}

/** `staffWaiver`: the owner's reason to switch before everyone has finished Stripe payout setup. */
export async function signOffAction(shopId: string, staffWaiver?: string) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    assertShopAccess(ctx, Shop.parse(shopId));
    await signOffAndSwitch(ctx.actor, shopId, new Date(), { staffWaiver: z.string().max(500).optional().parse(staffWaiver) });
    refresh(shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

/** The last day Squire pays this shop's tips; empty clears it. */
export async function squireTipsEndAction(shopId: string, date: string) {
  return safe(async () => {
    const ctx = await authorize("import.run");
    assertShopAccess(ctx, Shop.parse(shopId));
    const end = date.trim() ? z.string().refine(isValidLocalDate, "Enter a date").parse(date.trim()) : null;
    await setSquireTipsEnd(ctx.actor, shopId, end);
    refresh(shopId);
    revalidatePath("/admin/tips/onboarding");
    return null;
  });
}

export async function handBackAction(shopId: string, url: string) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    assertShopAccess(ctx, Shop.parse(shopId));
    const r = await handBack(ctx.actor, shopId, z.string().trim().max(500).parse(url));
    refresh(shopId);
    revalidatePath("/admin/settings");
    return { bookings: r.bookings.length };
  });
}

const DateOrNull = z.string().trim().transform((d, c) => {
  if (!d) return null;
  if (!isValidLocalDate(d)) c.addIssue({ code: "custom", message: "Enter a date" });
  return d;
});

const StatementCents = z.string().trim().transform((v, c) => {
  if (!v) return null;
  const x = v.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(x)) {
    c.addIssue({ code: "custom", message: "Enter the statement's total in dollars and cents" });
    return z.NEVER;
  }
  return Math.round(Number(x) * 100);
});

/** Squire's last payout statement (tips covered through, and its total still owed) and its last payout day for this shop. */
export async function payoutDatesAction(shopId: string, v: { paidThrough: string; lastPayoutOn: string; statement?: string }) {
  return safe(async () => {
    const ctx = await authorize(["import.run", "tips.approve"]);
    assertShopAccess(ctx, Shop.parse(shopId));
    const statementCents = v.statement === undefined ? undefined : StatementCents.parse(v.statement);
    await setPayoutCutoverDates(ctx.actor, shopId, { paidThrough: DateOrNull.parse(v.paidThrough), lastPayoutOn: DateOrNull.parse(v.lastPayoutOn), statementCents });
    refresh(shopId);
    return null;
  });
}

/** The shop manager signs off the Squire-to-Ray'z tip payout reconciliation. */
export async function payoutReportSignOffAction(shopId: string) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    assertShopAccess(ctx, Shop.parse(shopId));
    await signOffPayoutReport(ctx.actor, shopId);
    refresh(shopId);
    return null;
  });
}

/** An owner records the CPA's sign-off of the tie-out the manager signed. */
export async function cpaSignOffAction(shopId: string, v: { name: string; signedOn: string }) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    assertShopAccess(ctx, Shop.parse(shopId));
    await recordCpaSignOff(ctx.actor, shopId, { name: z.string().parse(v.name), signedOn: z.string().parse(v.signedOn) });
    refresh(shopId);
    return null;
  });
}

/** Squire's year-to-date tips and sales per barber, for W-2 continuity. */
export async function ytdImportAction(shopId: string, v: { year: number; throughDate: string; csv: string }) {
  return safe(async () => {
    const ctx = await authorize("import.run");
    assertShopAccess(ctx, Shop.parse(shopId));
    const r = await importYtd(ctx.actor, shopId, z.object({ year: z.number().int(), throughDate: z.string(), csv: z.string().max(2_000_000) }).parse(v));
    refresh(shopId);
    return r;
  });
}
