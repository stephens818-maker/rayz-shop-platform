"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { ownerEntities, shops } from "@/db/schema";
import { PAYMENTS_MODES, ownerEntityProblem } from "@/domain/connect";
import { appBaseUrl } from "@/lib/deployment";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, authorize, staffGrantor } from "@/server/auth/staff";
import { LocationAdmin, archiveLocation, checkSlug, closeTemporarily, createLocation, goLive, reopen } from "@/server/location-admin";
import type { LocationDraftInput } from "@/domain/location-draft";
import { AppError, forbidden, notFound } from "@/server/errors";
import { deleteRegion, saveRegion, setShopRegion } from "@/server/regions";
import {
  completeSimulatedEntityOnboarding,
  completeSimulatedOnboarding,
  entityDashboardUrl,
  entityOnboardingUrl,
  expressDashboardUrl,
  onboardingUrl,
  refreshAccount,
  refreshEntityAccount,
  registerReader,
  setPaymentsMode,
  setStatementDescriptor,
} from "@/server/payments/connect";

const BANKING = "Only the Brand Owner, or someone they've given the banking permission, can connect or change a shop's Stripe account and bank";
const BRAND_RECORD = "Owner entities are records every shop shares, so changing them needs access to all shops";

function refresh(shopId?: string) {
  revalidatePath("/admin/setup");
  revalidatePath("/admin/reports/shop-accounts");
  if (shopId) revalidatePath("/admin/checkout", "layout");
}

async function shopFor(ctx: StaffContext, shopId: string) {
  assertShopAccess(ctx, shopId);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, name: true } });
  if (!shop) throw notFound("Shop");
  return shop;
}

/** The origin the person is using, so Stripe sends them back to the same place. */
async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return appBaseUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Creates the shop's connected account if needed and returns a fresh Stripe-hosted onboarding link. */
export async function startPaymentsOnboardingAction(shopId: string) {
  return safe(async () => {
    const ctx = await authorize("payments.banking", BANKING);
    await shopFor(ctx, shopId);
    const url = await onboardingUrl(shopId, ctx.actor, await origin());
    refresh(shopId);
    return { url };
  });
}

export async function refreshPaymentsAccountAction(shopId: string) {
  return safe(async () => {
    const ctx = await authorize("payments.accounts");
    await shopFor(ctx, shopId);
    await refreshAccount(shopId);
    refresh(shopId);
    return null;
  });
}

/** No Stripe keys: stands in for Stripe's hosted onboarding so the rest of the flow can be tried. */
export async function completeSimulatedOnboardingAction(shopId: string, withBank: boolean) {
  return safe(async () => {
    const ctx = await authorize("payments.banking", BANKING);
    await shopFor(ctx, shopId);
    await completeSimulatedOnboarding(shopId, ctx.actor, { withBank });
    refresh(shopId);
    return null;
  });
}

export async function expressDashboardAction(shopId: string) {
  return safe(async () => {
    const ctx = await authorize("payments.banking", BANKING);
    await shopFor(ctx, shopId);
    const url = await expressDashboardUrl(shopId);
    if (!url) throw new AppError("bad_request", "The Stripe dashboard opens once onboarding is finished");
    await audit(ctx.actor, "payments.dashboard_opened", "shop", shopId, {}, shopId);
    return { url };
  });
}

/** Where the shop's card money settles: the brand's account, its own or its owner's connected account, or nowhere (cash only). */
export async function setPaymentsModeAction(shopId: string, mode: string) {
  return safe(async () => {
    const ctx = await authorize("payments.banking", BANKING);
    await shopFor(ctx, shopId);
    const m = z.enum(PAYMENTS_MODES).parse(mode);
    await setPaymentsMode(shopId, m, ctx.actor);
    refresh(shopId);
    return null;
  });
}

export async function saveStatementDescriptorAction(shopId: string, descriptor: string | null) {
  return safe(async () => {
    const ctx = await authorize("payments.banking", BANKING);
    await shopFor(ctx, shopId);
    const saved = await setStatementDescriptor(shopId, descriptor, ctx.actor);
    refresh(shopId);
    return { descriptor: saved };
  });
}

/** Registers a Stripe Terminal reader to the shop's Terminal Location with the code the reader shows. */
export async function registerReaderAction(shopId: string, v: { label: string; registrationCode: string; serialNumber: string | null }) {
  return safe(async () => {
    const ctx = await authorize(["settings.shop", "payments.accounts"], "Registering card readers needs shop settings access");
    await shopFor(ctx, shopId);
    const label = v.label.trim();
    if (!label || label.length > 40) throw new AppError("bad_request", "Name the reader (up to 40 characters), e.g. Front counter");
    const row = await registerReader(shopId, { label, registrationCode: v.registrationCode, serialNumber: v.serialNumber }, ctx.actor);
    refresh(shopId);
    revalidatePath("/admin/settings");
    return { id: row.id, stripeReaderId: row.stripeReaderId };
  });
}

export async function setShopOwnerAction(shopId: string, ownerEntityId: string) {
  return safe(async () => {
    const ctx = await authorize("payments.accounts");
    const shop = await shopFor(ctx, shopId);
    const owner = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, ownerEntityId) });
    if (!owner) throw notFound("Owner");
    const [before] = await db.select({ id: shops.ownerEntityId }).from(shops).where(eq(shops.id, shopId));
    await db.update(shops).set({ ownerEntityId }).where(eq(shops.id, shopId));
    await audit(ctx.actor, "shop.owner", "shop", shopId, { shop: shop.name, from: before?.id ?? null, to: ownerEntityId, owner: owner.name }, shopId);
    refresh();
    return null;
  });
}

const Owner = z.object({
  name: z.string().trim(),
  legalName: z.string().trim().nullable(),
  contactEmail: z.string().trim().nullable(),
  kind: z.enum(["brand", "franchisee"]).default("brand"),
});

export async function saveOwnerEntityAction(id: string | null, raw: z.input<typeof Owner>) {
  return safe(async () => {
    const ctx = await authorize("payments.accounts");
    if (!ctx.brandWide) throw forbidden(BRAND_RECORD);
    const v = Owner.parse(raw);
    const problem = ownerEntityProblem(v);
    if (problem) throw new AppError("bad_request", problem);
    const values = { name: v.name, legalName: v.legalName || null, contactEmail: v.contactEmail || null, kind: v.kind };
    if (id) {
      const current = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, id), columns: { isDefault: true } });
      if (!current) throw notFound("Owner");
      if (current.isDefault && v.kind !== "brand") throw new AppError("bad_request", "Ray'z Corporate owns new locations by default, so it can't be a franchisee");
      const [row] = await db
        .update(ownerEntities)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(ownerEntities.id, id))
        .returning();
      if (!row) throw notFound("Owner");
      await audit(ctx.actor, "owner_entity.update", "owner_entity", id, values, null);
      refresh();
      return { id };
    }
    const [row] = await db.insert(ownerEntities).values(values).returning();
    await audit(ctx.actor, "owner_entity.create", "owner_entity", row.id, values, null);
    refresh();
    return { id: row.id };
  });
}

/** An owner entity's own Stripe account, shared by its shops in payments mode "entity". Brand-wide, like the owner records. */
async function entityBanking(entityId: string) {
  const ctx = await authorize("payments.banking", BANKING);
  if (!ctx.brandWide) throw forbidden(BRAND_RECORD);
  const owner = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, z.string().uuid().parse(entityId)), columns: { id: true } });
  if (!owner) throw notFound("Owner");
  return ctx;
}

export async function startEntityOnboardingAction(entityId: string) {
  return safe(async () => {
    const ctx = await entityBanking(entityId);
    const url = await entityOnboardingUrl(entityId, ctx.actor, await origin());
    refresh();
    return { url };
  });
}

export async function refreshEntityAccountAction(entityId: string) {
  return safe(async () => {
    await entityBanking(entityId);
    await refreshEntityAccount(entityId);
    refresh();
    return null;
  });
}

export async function completeSimulatedEntityOnboardingAction(entityId: string, withBank: boolean) {
  return safe(async () => {
    const ctx = await entityBanking(entityId);
    await completeSimulatedEntityOnboarding(entityId, ctx.actor, { withBank });
    refresh();
    return null;
  });
}

export async function entityDashboardAction(entityId: string) {
  return safe(async () => {
    const ctx = await entityBanking(entityId);
    const url = await entityDashboardUrl(entityId);
    if (!url) throw new AppError("bad_request", "The Stripe dashboard opens once onboarding is finished");
    await audit(ctx.actor, "payments.dashboard_opened", "owner_entity", entityId, {}, null);
    return { url };
  });
}

const REGIONS = "Regions group every location, so changing them needs access to all shops";

async function regionAdmin() {
  const ctx = await authorize("locations.setup", "Only the Brand Owner or a Brand Admin can change regions");
  if (!ctx.brandWide) throw forbidden(REGIONS);
  return ctx;
}

export async function saveRegionAction(id: string | null, name: string) {
  return safe(async () => {
    const ctx = await regionAdmin();
    const row = await saveRegion(ctx.actor, id, z.string().parse(name));
    refresh();
    revalidatePath("/admin/reports/rollup");
    return { id: row.id };
  });
}

export async function deleteRegionAction(id: string) {
  return safe(async () => {
    const ctx = await regionAdmin();
    await deleteRegion(ctx.actor, z.string().uuid().parse(id));
    refresh();
    revalidatePath("/admin/reports/rollup");
    return null;
  });
}

export async function setShopRegionAction(shopId: string, regionId: string | null) {
  return safe(async () => {
    const ctx = await regionAdmin();
    await setShopRegion(ctx.actor, z.string().uuid().parse(shopId), regionId ? z.string().uuid().parse(regionId) : null);
    refresh(shopId);
    revalidatePath("/admin/reports/rollup");
    return null;
  });
}

async function locationAdmin(): Promise<LocationAdmin> {
  const ctx = await authorize("locations.setup", "Only the Brand Owner or a Brand Admin can add, open or archive locations");
  return { actor: ctx.actor, brandWide: ctx.brandWide, shopIds: ctx.shopIds, grantor: staffGrantor(ctx) };
}

function refreshLocations() {
  revalidatePath("/admin", "layout");
  revalidatePath("/", "layout");
}

export async function checkSlugAction(slug: string) {
  return safe(async () => {
    await locationAdmin();
    return checkSlug(slug.trim().toLowerCase());
  });
}

export async function createLocationAction(draft: LocationDraftInput) {
  return safe(async () => {
    const r = await createLocation(await locationAdmin(), draft);
    refreshLocations();
    return r;
  });
}

export async function goLiveAction(shopId: string, cashOnly: boolean) {
  return safe(async () => {
    await goLive(await locationAdmin(), shopId, { cashOnly });
    refreshLocations();
    return null;
  });
}

export async function closeLocationAction(shopId: string, until: string | null, note: string | null) {
  return safe(async () => {
    await closeTemporarily(await locationAdmin(), shopId, { until: until || null, note });
    refreshLocations();
    return null;
  });
}

export async function reopenLocationAction(shopId: string) {
  return safe(async () => {
    await reopen(await locationAdmin(), shopId);
    refreshLocations();
    return null;
  });
}

export async function archiveLocationAction(shopId: string, confirmName: string) {
  return safe(async () => {
    const m = await locationAdmin();
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { name: true } });
    if (!shop) throw notFound("Location");
    if (confirmName.trim().toLowerCase() !== shop.name.toLowerCase()) throw new AppError("bad_request", `Type ${shop.name} to confirm`);
    const r = await archiveLocation(m, shopId);
    refreshLocations();
    return r;
  });
}
