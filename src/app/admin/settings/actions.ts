"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { shopClosures, shopHours, shops, terminalReaders } from "@/db/schema";
import { ReceiptBrandingSchema, receiptBranding } from "@/domain/connect";
import { US_TIMEZONES } from "@/domain/location-lifecycle";
import { checkSlug } from "@/server/location-admin";
import type { CardFeeOverride } from "@/domain/card-fee-policy";
import { brandFeePolicy, canEditShopFee, saveShopFeeOverride, } from "@/server/payments/card-fee";
import { hoursProblem } from "@/domain/hours";
import { normalizePhone } from "@/lib/phone";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, authorize, can } from "@/server/auth/staff";
import { squireHistory } from "@/server/cutover";
import { assertShopMayEdit, noteShopEdit } from "@/server/brand-sync/engine";
import { receiptValue } from "@/server/brand-sync/adapters/location";
import { AppError } from "@/server/errors";
import { same } from "@/domain/brand-sync";
import { ShopHandoffSchema } from "@/domain/handoff";
import { saveShopHandoff, shopHandoffConfig } from "@/server/handoff";
import { Permission, SHOP_PART_PERMISSION, SHOP_SETTING_FIELDS, ShopSettingPart, shopSettingsDenied } from "@/domain/permissions";
import { cleanOperator, operatorProblem } from "@/domain/phone-operator";
import { saveDrawerOpening } from "@/server/drawer";
import { overridesFromColumns } from "@/domain/location-defaults";
import { noteShopColumnChanges } from "@/server/location-defaults";

/** "Edit every shop setting", or the permission for this part of them. */
const partPerms = (...parts: ShopSettingPart[]): Permission[] => ["settings.shop", ...parts.map((p) => SHOP_PART_PERMISSION[p])];
const FIELD_LABEL: Record<keyof typeof SHOP_SETTING_FIELDS, string> = {
  name: "name",
  address: "address",
  city: "city",
  state: "state",
  zip: "ZIP",
  phone: "phone",
  email: "email",
  description: "description",
  twilioNumber: "Twilio number",
  bookingEnabled: "online booking switch",
  bookingMode: "where clients book",
  externalBookingUrl: "external booking link",
  cancelCutoffMinutes: "cancel cutoff",
  minLeadMinutes: "minimum notice",
  bookingWindowDays: "booking window",
  bufferMinutes: "buffer",
  drawerOpeningCents: "drawer opening balance",
};

/** The address, phone and email are saved with the location profile; older callers may still send them here. */
const Info = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().length(2).toUpperCase().optional(),
  zip: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  twilioNumber: z.string().trim().optional(),
  email: z.string().trim().optional(),
  description: z.string().trim(),
  bookingEnabled: z.boolean(),
  bookingMode: z.enum(["platform", "external"]).optional(),
  externalBookingUrl: z.string().trim().optional(),
  cancelCutoffMinutes: z.number().int().min(0).max(1440),
  minLeadMinutes: z.number().int().min(0).max(1440),
  bookingWindowDays: z.number().int().min(1).max(365),
  bufferMinutes: z.number().int().min(0).max(60),
  tipPresets: z.array(z.number().int().min(1).max(100)).min(1).max(4).optional(),
});

export async function saveShopInfoAction(shopId: string, raw: z.input<typeof Info>) {
  return safe(async () => {
    const ctx = await authorize(partPerms("details", "booking", "phone"));
    assertShopAccess(ctx, shopId);
    const { twilioNumber, externalBookingUrl, ...v } = Info.parse(raw);
    const external = externalBookingUrl === undefined ? undefined : externalBookingUrl || null;
    if (external && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(external)) throw new AppError("bad_request", "The external booking link must be a full https:// address");
    if (v.bookingMode === "external" && !external) throw new AppError("bad_request", "Enter the external booking link, or keep booking here");
    const line = twilioNumber === undefined ? undefined : twilioNumber ? normalizePhone(twilioNumber) : null;
    if (twilioNumber && !line) throw new AppError("bad_request", "The Twilio number doesn't look like a US number");
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (!before) throw new AppError("not_found", "Shop not found");
    if (v.bookingMode && v.bookingMode !== before.bookingMode && (await squireHistory(shopId))) {
      throw new AppError("conflict", "This shop has Squire history, so moving its online booking to or from Squire happens on Squire cutover, where bookings, loyalty and gift cards are reconciled first");
    }
    const values = Object.fromEntries(
      Object.entries({ ...v, phone: v.phone === undefined ? undefined : v.phone || null, email: v.email === undefined ? undefined : v.email || null, description: v.description || null, twilioNumber: line, externalBookingUrl: external }).filter(([, x]) => x !== undefined),
    ) as Partial<typeof shops.$inferInsert>;
    const denied = shopSettingsDenied(ctx.permissions, before, values as Partial<Record<keyof typeof SHOP_SETTING_FIELDS, unknown>>);
    if (denied.length) throw new AppError("forbidden", `You can't change the shop's ${denied.map((f) => FIELD_LABEL[f]).join(", ")}`);
    if (line) {
      const other = await db.query.shops.findFirst({ where: and(eq(shops.twilioNumber, line), ne(shops.id, shopId)), columns: { name: true } });
      if (other) throw new AppError("conflict", `${other.name} already uses that Twilio number`);
    }
    await assertDefaultsUnlocked(ctx, before, values);
    await db.update(shops).set(values).where(eq(shops.id, shopId));
    await noteShopColumnChanges(shopId, overridesFromColumns(values));
    await noteShopEdit("location_default", Object.keys(overridesFromColumns(values)), shopId);
    await audit(ctx.actor, "shop.update", "shop", shopId, values, shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

/** A location default saved from the shop's own settings changes only where the brand lets shop managers. */
async function assertDefaultsUnlocked(ctx: Awaited<ReturnType<typeof authorize>>, before: Record<string, unknown>, values: Record<string, unknown>) {
  const changed = Object.entries(overridesFromColumns(values)).filter(([k]) => {
    const col = k as keyof typeof before;
    return k in before && !same(before[col], values[col]);
  });
  if (changed.length) await assertShopMayEdit(ctx, "location_default");
}

const Money = z.object({
  serviceTaxRate: z.number().min(0).max(0.2),
  productTaxRate: z.number().min(0).max(0.2),
  taxRatesVerified: z.boolean(),
});

/** Taxes are a compliance setting with their own permission. The card fee has its own editor (settings.card_fee). */
export async function saveShopMoneyAction(shopId: string, raw: z.input<typeof Money>) {
  return safe(async () => {
    const ctx = await authorize("settings.taxes");
    assertShopAccess(ctx, shopId);
    const v = Money.parse(raw);
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (before && (Number(before.serviceTaxRate) !== Number(v.serviceTaxRate.toFixed(5)) || Number(before.productTaxRate) !== Number(v.productTaxRate.toFixed(5)))) await assertShopMayEdit(ctx, "taxes");
    await db
      .update(shops)
      .set({ ...v, serviceTaxRate: v.serviceTaxRate.toFixed(5), productTaxRate: v.productTaxRate.toFixed(5) })
      .where(eq(shops.id, shopId));
    await audit(
      ctx.actor,
      "shop.tax_fee",
      "shop",
      shopId,
      { before: before && { serviceTaxRate: before.serviceTaxRate, productTaxRate: before.productTaxRate, taxRatesVerified: before.taxRatesVerified }, after: v },
      shopId,
    );
    await noteShopEdit("taxes", ["rates"], shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

/**
 * One shop's own surcharge settings on top of the brand's, or null to follow the brand. Brand admins,
 * or people who edit the shop's checkout settings when the brand lets shop managers. Audited.
 */
export async function saveShopCardFeeAction(shopId: string, override: CardFeeOverride | null) {
  return safe(async () => {
    const ctx = await authorize(["settings.card_fee", ...partPerms("checkout")]);
    assertShopAccess(ctx, shopId);
    if (!canEditShopFee(ctx.permissions, await brandFeePolicy())) throw new AppError("forbidden", "The brand keeps the card surcharge view only for shop managers");
    await saveShopFeeOverride(ctx.actor, shopId, override);
    await noteShopEdit("card_fee", ["brand"], shopId);
    revalidatePath("/admin/settings");
    revalidatePath("/admin/card-fee");
    return null;
  });
}

export async function saveHoursAction(shopId: string, rows: { weekday: number; openMin: number; closeMin: number }[]) {
  return safe(async () => {
    const ctx = await authorize(partPerms("hours"));
    assertShopAccess(ctx, shopId);
    const sunday = await db.query.shopHours.findFirst({ where: and(eq(shopHours.shopId, shopId), eq(shopHours.weekday, 0)) });
    const problem = hoursProblem(rows, { canSetSunday: can(ctx, "settings.brand"), currentSunday: sunday ?? null });
    if (problem) throw new AppError(problem.code, problem.message);
    const current = await db.select({ weekday: shopHours.weekday, openMin: shopHours.openMin, closeMin: shopHours.closeMin }).from(shopHours).where(eq(shopHours.shopId, shopId));
    const week = (rs: { weekday: number; openMin: number; closeMin: number }[]) => [...rs].sort((a, b) => a.weekday - b.weekday).map((r) => `${r.weekday}:${r.openMin}-${r.closeMin}`).join(",");
    if (week(current) !== week(rows)) await assertShopMayEdit(ctx, "hours");
    await db.transaction(async (tx) => {
      await tx.delete(shopHours).where(eq(shopHours.shopId, shopId));
      if (rows.length) await tx.insert(shopHours).values(rows.map((r) => ({ ...r, shopId })));
      await audit(ctx.actor, "shop.hours", "shop", shopId, { rows }, shopId, tx);
    });
    await noteShopEdit("hours", ["week"], shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

export async function addClosureAction(shopId: string, date: string, reason: string, allShops: boolean) {
  return safe(async () => {
    const ctx = await authorize(partPerms("hours"));
    if (allShops && ctx.brandWide) throw new AppError("bad_request", "Closing several shops goes through Brand defaults → Holiday closures, which picks the shops");
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
    const ctx = await authorize(partPerms("hours"));
    assertShopAccess(ctx, shopId);
    await db.delete(shopClosures).where(and(eq(shopClosures.shopId, shopId), eq(shopClosures.date, date)));
    await audit(ctx.actor, "shop.closure_remove", "shop", shopId, { date }, shopId);
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
    .refine((u) => !u || /^https:\/\//.test(u),
      "Use an https:// address for the logo",
    ),
});

/** The booking link and time zone are location setup (they break links and schedules); branding is shop settings. */
export async function saveShopProfileAction(shopId: string, raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await authorize(partPerms("details"));
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
    await assertDefaultsUnlocked(ctx, before, { accentColor: values.accentColor });
    await db.update(shops).set(values).where(eq(shops.id, shopId));
    await noteShopColumnChanges(shopId, overridesFromColumns({ accentColor: values.accentColor }));
    await noteShopEdit("location_default", ["accentColor"], shopId);
    await audit(ctx.actor, "shop.profile", "shop", shopId, { ...values, previousSlug: v.slug !== before.slug ? before.slug : undefined }, shopId);
    revalidatePath("/admin/settings");
    revalidatePath("/admin/setup");
    return null;
  });
}

const Reader = z.object({ label: z.string().trim().min(1, "Name the reader").max(40), serialNumber: z.string().trim().max(40), stripeReaderId: z.string().trim().max(60) });

export async function addReaderAction(shopId: string, raw: z.input<typeof Reader>) {
  return safe(async () => {
    const ctx = await authorize(partPerms("checkout"));
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
    const ctx = await authorize(partPerms("checkout"));
    const r = await db.query.terminalReaders.findFirst({ where: eq(terminalReaders.id, id) });
    if (!r) throw new AppError("not_found", "Reader not found");
    assertShopAccess(ctx, r.shopId);
    await db.update(terminalReaders).set({ active }).where(eq(terminalReaders.id, id));
    await audit(ctx.actor, active ? "reader.restore" : "reader.retire", "terminal_reader", id, { label: r.label }, r.shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

/** What this shop's receipts show. */
export async function saveReceiptAction(shopId: string, raw: z.input<typeof ReceiptBrandingSchema>) {
  return safe(async () => {
    const ctx = await authorize(partPerms("checkout"));
    assertShopAccess(ctx, shopId);
    const v = ReceiptBrandingSchema.parse(raw);
    const values = { ...v, headline: v.headline?.trim() || null, footer: v.footer?.trim() || null, reviewFollowUp: { ...v.reviewFollowUp, enabled: v.reviewFollowUp.enabled && !!v.reviewUrl } };
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { receipt: true } });
    if (!same(receiptValue(receiptBranding(before?.receipt)), receiptValue(values))) await assertShopMayEdit(ctx, "receipt");
    await db.update(shops).set({ receipt: values }).where(eq(shops.id, shopId));
    await audit(ctx.actor, "shop.receipt", "shop", shopId, { before: before ? receiptBranding(before.receipt) : null, after: values }, shopId);
    await noteShopEdit("receipt", ["branding"], shopId);
    revalidatePath("/admin/settings");
    return null;
  });
}

/** The customer screen at checkout for one location. With tips on the reader, the presets are pushed to its Stripe Terminal readers. */
export async function saveShopHandoffAction(shopId: string, raw: z.input<typeof ShopHandoffSchema>) {
  return safe(async () => {
    const ctx = await authorize(partPerms("checkout"));
    assertShopAccess(ctx, shopId);
    const next = ShopHandoffSchema.parse(raw);
    const current = await shopHandoffConfig(shopId);
    if (!same(current.shop.tips, next.tips)) await assertShopMayEdit(ctx, "tips");
    const r = await saveShopHandoff(shopId, next, ctx.actor);
    await noteShopEdit("tips", ["screen"], shopId);
    revalidatePath("/admin/settings");
    return r.reader;
  });
}

/** What the cash drawer opens with unless whoever opens it counts something else. */
export async function saveDrawerOpeningAction(shopId: string, cents: number) {
  return safe(async () => {
    const ctx = await authorize(partPerms("checkout"));
    assertShopAccess(ctx, shopId);
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (shop) await assertDefaultsUnlocked(ctx, shop, { drawerOpeningCents: Math.round(cents) });
    await saveDrawerOpening(shopId, Math.round(cents), ctx.actor);
    await noteShopColumnChanges(shopId, overridesFromColumns({ drawerOpeningCents: Math.round(cents) }));
    await noteShopEdit("location_default", ["drawerOpeningCents"], shopId);
    revalidatePath("/admin/settings");
    revalidatePath("/admin/drawer");
    return null;
  });
}

const Operator = z.object({
  enabled: z.boolean(),
  answer: z.enum(["fallback", "first"]),
  minutesPerCall: z.number().int(),
  greeting: z.string().trim().max(300).nullable(),
  speech: z.boolean().optional().default(false),
  transcripts: z.boolean().optional().default(true),
});

/** How the phone operator answers this shop's number. */
export async function savePhoneOperatorAction(shopId: string, raw: z.input<typeof Operator>) {
  return safe(async () => {
    const ctx = await authorize(partPerms("phone"));
    assertShopAccess(ctx, shopId);
    const v = Operator.parse(raw);
    const problem = operatorProblem(v);
    if (problem) throw new AppError("bad_request", problem);
    const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { phoneOperator: true, twilioNumber: true } });
    if (!before) throw new AppError("not_found", "Shop not found");
    if (v.enabled && !before.twilioNumber) throw new AppError("conflict", "Give the shop a Twilio number first");
    const after = cleanOperator({ ...v, greeting: v.greeting || null });
    await db.update(shops).set({ phoneOperator: { ...after } }).where(eq(shops.id, shopId));
    await audit(ctx.actor, "shop.phone_operator", "shop", shopId, { before: cleanOperator(before.phoneOperator), after }, shopId);
    revalidatePath("/admin/settings");
    revalidatePath("/admin/phone-agent");
    return null;
  });
}

