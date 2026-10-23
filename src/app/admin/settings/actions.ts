"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { shopClosures, shopHours, shops, terminalReaders } from "@/db/schema";
import { ReceiptBrandingSchema, receiptBranding } from "@/domain/connect";
import { US_TIMEZONES } from "@/domain/location-lifecycle";
import { checkSlug } from "@/server/location-admin";
import { MAX_CARD_FEE_RATE } from "@/domain/checkout";
import { hoursProblem } from "@/domain/hours";
import { normalizePhone } from "@/lib/phone";
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
  twilioNumber: z.string().trim().optional(),
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
    const { twilioNumber, ...v } = Info.parse(raw);
    const line = twilioNumber === undefined ? undefined : twilioNumber ? normalizePhone(twilioNumber) : null;
    if (twilioNumber && !line) throw new AppError("bad_request", "The Twilio number doesn't look like a US number");
    if (line) {
      const other = await db.query.shops.findFirst({ where: and(eq(shops.twilioNumber, line), ne(shops.id, shopId)), columns: { name: true } });
      if (other) throw new AppError("conflict", `${other.name} already uses that Twilio number`);
    }
    const values = { ...v, phone: v.phone || null, email: v.email || null, description: v.description || null, ...(line === undefined ? {} : { twilioNumber: line }) };
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

const Profile = z.object({
  slug: z.string().trim().toLowerCase(),
  timezone: z.string().refine((z) => US_TIMEZONES.some((t) => t.id === z), "Pick a US time zone"),
  accentColor: z
    .string()
    .trim()
    .refine((c) => !c || /^#[0-9a-fA-F]{6}$/.test(c), "Use a color like #1f2937"),
  logoUrl: z
    .string()
    .trim()
    .refine((u) => !u || /^https:\/\//.test(u), "Use an https:// address for the logo"),
});

/** The booking link and time zone are location setup (they break links and schedules); branding is shop settings. */
export async function saveShopProfileAction(shopId: string, raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    assertShopAccess(ctx, shopId);
    const v = Profile.parse(raw);
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (!before) throw new AppError("not_found", "Shop not found");
    const linkChanged = v.slug !== before.slug || v.timezone !== before.timezone;
    if (linkChanged && !can(ctx, "locations.setup")) throw new AppError("forbidden", "Only the Brand Owner or a Brand Admin can change the booking link or time zone");
    if (v.slug !== before.slug) {
      const problem = await checkSlug(v.slug, shopId);
      if (problem) throw new AppError("bad_request", problem);
    }
    const values = { slug: v.slug, timezone: v.timezone, accentColor: v.accentColor || null, logoUrl: v.logoUrl || null };
    await db.update(shops).set(values).where(eq(shops.id, shopId));
    await audit(ctx.actor, "shop.profile", "shop", shopId, { ...values, previousSlug: v.slug !== before.slug ? before.slug : undefined }, shopId);
    revalidatePath("/admin/settings");
    revalidatePath("/admin/setup");
    return null;
  });
}

const Reader = z.object({ label: z.string().trim().min(1, "Name the reader").max(40), serialNumber: z.string().trim().max(40), stripeReaderId: z.string().trim().max(60) });

export async function addReaderAction(shopId: string, raw: z.input<typeof Reader>) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    assertShopAccess(ctx, shopId);
    const v = Reader.parse(raw);
    if (v.stripeReaderId && (await db.query.terminalReaders.findFirst({ where: eq(terminalReaders.stripeReaderId, v.stripeReaderId), columns: { id: true } })))
      throw new AppError("conflict", "That reader is already registered to a shop");
    const [row] = await db
      .insert(terminalReaders)
      .values({ shopId, label: v.label, serialNumber: v.serialNumber || null, stripeReaderId: v.stripeReaderId || null })
      .returning({ id: terminalReaders.id });
    await audit(ctx.actor, "reader.add", "terminal_reader", row.id, v, shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

export async function setReaderActiveAction(id: string, active: boolean) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    const r = await db.query.terminalReaders.findFirst({ where: eq(terminalReaders.id, id) });
    if (!r) throw new AppError("not_found", "Reader not found");
    assertShopAccess(ctx, r.shopId);
    await db.update(terminalReaders).set({ active }).where(eq(terminalReaders.id, id));
    await audit(ctx.actor, active ? "reader.restore" : "reader.retire", "terminal_reader", id, { label: r.label }, r.shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

/** What this shop's printed and emailed receipts show. */
export async function saveReceiptAction(shopId: string, raw: z.input<typeof ReceiptBrandingSchema>) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    assertShopAccess(ctx, shopId);
    const v = ReceiptBrandingSchema.parse(raw);
    const values = { ...v, headline: v.headline?.trim() || null, footer: v.footer?.trim() || null };
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { receipt: true } });
    await db.update(shops).set({ receipt: values }).where(eq(shops.id, shopId));
    await audit(ctx.actor, "shop.receipt", "shop", shopId, { before: before ? receiptBranding(before.receipt) : null, after: values }, shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}
