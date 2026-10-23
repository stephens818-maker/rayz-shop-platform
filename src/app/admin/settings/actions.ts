"use server";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { ownerEntities, services, shopClosures, shopHours, shopServices, shops } from "@/db/schema";
import { MAX_CARD_FEE_RATE } from "@/domain/checkout";
import { hoursProblem } from "@/domain/hours";
import { slugify } from "@/lib/ids";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, authorize, can } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { saveLoyaltyConfig } from "@/server/loyalty";

const Info = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim(),
  city: z.string().trim(),
  state: z.string().trim().length(2).toUpperCase(),
  zip: z.string().trim(),
  phone: z.string().trim(),
  email: z.string().trim(),
  description: z.string().trim(),
  bookingEnabled: z.boolean(),
  cancelCutoffMinutes: z.number().int().min(0).max(1440),
  minLeadMinutes: z.number().int().min(0).max(1440),
  bookingWindowDays: z.number().int().min(1).max(365),
  bufferMinutes: z.number().int().min(0).max(60),
  tipPresets: z.array(z.number().int().min(1).max(100)).min(1).max(4),
});

export async function saveShopInfoAction(shopId: string, raw: z.input<typeof Info>) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    assertShopAccess(ctx, shopId);
    const v = Info.parse(raw);
    const values = { ...v, phone: v.phone || null, email: v.email || null, description: v.description || null };
    await db.update(shops).set(values).where(eq(shops.id, shopId));
    await audit(ctx.actor, "shop.update", "shop", shopId, values, shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

const Money = z.object({
  serviceTaxRate: z.number().min(0).max(0.2),
  productTaxRate: z.number().min(0).max(0.2),
  taxRatesVerified: z.boolean(),
  cardFeeEnabled: z.boolean(),
  cardFeeRate: z.number().min(0).max(MAX_CARD_FEE_RATE, `The card fee can't exceed ${MAX_CARD_FEE_RATE * 100}%`),
  cardFeeAppliesToTip: z.boolean(),
});

/** Taxes and card fees are compliance settings with their own permission. */
export async function saveShopMoneyAction(shopId: string, raw: z.input<typeof Money>) {
  return safe(async () => {
    const ctx = await authorize("settings.taxes");
    assertShopAccess(ctx, shopId);
    const v = Money.parse(raw);
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
    await db
      .update(shops)
      .set({ ...v, serviceTaxRate: v.serviceTaxRate.toFixed(5), productTaxRate: v.productTaxRate.toFixed(5), cardFeeRate: v.cardFeeRate.toFixed(5) })
      .where(eq(shops.id, shopId));
    await audit(
      ctx.actor,
      "shop.tax_fee",
      "shop",
      shopId,
      { before: before && { serviceTaxRate: before.serviceTaxRate, productTaxRate: before.productTaxRate, cardFeeEnabled: before.cardFeeEnabled, cardFeeRate: before.cardFeeRate }, after: v },
      shopId,
    );
    revalidatePath("/admin/settings");
    return null;
  });
}

export async function saveHoursAction(shopId: string, rows: { weekday: number; openMin: number; closeMin: number }[]) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    assertShopAccess(ctx, shopId);
    const sunday = await db.query.shopHours.findFirst({ where: and(eq(shopHours.shopId, shopId), eq(shopHours.weekday, 0)) });
    const problem = hoursProblem(rows, { canSetSunday: can(ctx, "settings.brand"), currentSunday: sunday ?? null });
    if (problem) throw new AppError(problem.code, problem.message);
    await db.transaction(async (tx) => {
      await tx.delete(shopHours).where(eq(shopHours.shopId, shopId));
      if (rows.length) await tx.insert(shopHours).values(rows.map((r) => ({ ...r, shopId })));
      await audit(ctx.actor, "shop.hours", "shop", shopId, { rows }, shopId, tx);
    });
    revalidatePath("/admin/settings");
    return null;
  });
}

export async function addClosureAction(shopId: string, date: string, reason: string, allShops: boolean) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    const ids = allShops ? ctx.shopIds : [shopId];
    for (const id of ids) {
      assertShopAccess(ctx, id);
      await db.insert(shopClosures).values({ shopId: id, date, reason: reason || "Closed" }).onConflictDoNothing();
    }
    await audit(ctx.actor, "shop.closure_add", "shop", shopId, { date, reason, allShops }, shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

export async function removeClosureAction(shopId: string, date: string) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    assertShopAccess(ctx, shopId);
    await db.delete(shopClosures).where(and(eq(shopClosures.shopId, shopId), eq(shopClosures.date, date)));
    await audit(ctx.actor, "shop.closure_remove", "shop", shopId, { date }, shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

const Loyalty = z.object({
  enabled: z.boolean(),
  thresholdCents: z.number().int().min(100),
  rewardCents: z.number().int().min(100),
  rewardExpiryDays: z.number().int().min(1).nullable(),
  progressExpiryDays: z.number().int().min(1).nullable(),
  redeemableOn: z.enum(["services", "all"]),
  stackWithPromos: z.boolean(),
});

export async function saveLoyaltyAction(raw: z.input<typeof Loyalty>) {
  return safe(async () => {
    const ctx = await authorize("settings.brand", "Only the Brand Owner can change the loyalty program");
    const v = Loyalty.parse(raw);
    await saveLoyaltyConfig(v);
    await audit(ctx.actor, "loyalty.config", "brand", "1", v, null);
    revalidatePath("/admin/settings");
    return null;
  });
}

const NewShop = z.object({ name: z.string().trim().min(2), city: z.string().trim().min(1), state: z.string().trim().length(2).toUpperCase(), address: z.string().trim(), zip: z.string().trim(), phone: z.string().trim() });

/** New locations start with the full brand menu at default prices, Mon–Sat hours, and booking off until staffed. */
export async function createShopAction(raw: z.input<typeof NewShop>) {
  return safe(async () => {
    const ctx = await authorize("settings.brand", "Only the Brand Owner can open a new shop");
    const v = NewShop.parse(raw);
    const slug = slugify(v.name);
    if (await db.query.shops.findFirst({ where: eq(shops.slug, slug) })) throw new AppError("conflict", "A shop with that name already exists");
    const id = await db.transaction(async (tx) => {
      const brandOwner = await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.kind, "brand"), orderBy: asc(ownerEntities.createdAt) });
      const [s] = await tx
        .insert(shops)
        .values({ ...v, slug, phone: v.phone || null, bookingEnabled: false, taxRatesVerified: false, serviceTaxRate: "0", productTaxRate: "0", ownerEntityId: brandOwner?.id ?? null })
        .returning({ id: shops.id });
      await tx.insert(shopHours).values([1, 2, 3, 4, 5, 6].map((weekday) => ({ shopId: s.id, weekday, openMin: 9 * 60, closeMin: weekday === 6 ? 15 * 60 : 19 * 60 })));
      const all = await tx.select({ id: services.id }).from(services).where(eq(services.active, true));
      if (all.length) await tx.insert(shopServices).values(all.map((x) => ({ shopId: s.id, serviceId: x.id, enabled: true })));
      await audit(ctx.actor, "shop.create", "shop", s.id, v, s.id, tx);
      return s.id;
    });
    revalidatePath("/admin", "layout");
    return { id };
  });
}
