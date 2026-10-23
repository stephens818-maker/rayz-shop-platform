"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { ownerEntities, shops } from "@/db/schema";
import { ownerEntityProblem } from "@/domain/connect";
import { appBaseUrl } from "@/lib/deployment";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { completeSimulatedOnboarding, expressDashboardUrl, onboardingUrl, refreshAccount } from "@/server/payments/connect";

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
    const ctx = await authorize("payments.accounts");
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
    const ctx = await authorize("payments.accounts");
    await shopFor(ctx, shopId);
    await completeSimulatedOnboarding(shopId, ctx.actor, { withBank });
    refresh(shopId);
    return null;
  });
}

export async function expressDashboardAction(shopId: string) {
  return safe(async () => {
    const ctx = await authorize("payments.accounts");
    await shopFor(ctx, shopId);
    const url = await expressDashboardUrl(shopId);
    if (!url) throw new AppError("bad_request", "The Stripe dashboard opens once onboarding is finished");
    await audit(ctx.actor, "payments.dashboard_opened", "shop", shopId, {}, shopId);
    return { url };
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

const Owner = z.object({ name: z.string().trim(), legalName: z.string().trim().nullable(), kind: z.enum(["brand", "franchisee"]), contactEmail: z.string().trim().nullable() });

export async function saveOwnerEntityAction(id: string | null, raw: z.input<typeof Owner>) {
  return safe(async () => {
    const ctx = await authorize("payments.accounts");
    if (!ctx.brandWide) throw forbidden(BRAND_RECORD);
    const v = Owner.parse(raw);
    const problem = ownerEntityProblem(v);
    if (problem) throw new AppError("bad_request", problem);
    const values = { name: v.name, legalName: v.legalName || null, kind: v.kind, contactEmail: v.contactEmail || null };
    if (id) {
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
