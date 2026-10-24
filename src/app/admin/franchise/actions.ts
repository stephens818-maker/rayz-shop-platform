"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appBaseUrl } from "@/lib/deployment";
import { parsePercentBps } from "@/domain/franchise";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { type StaffContext, assertShopAccess, authorize, requireStaff } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { addFeeTerms, deleteRegion, moveShop, saveEntity, saveEntitySettings, saveFranchiseData, saveRegion, saveStandards } from "@/server/franchise-admin";
import { assertEntity, requireEntityAccess } from "@/server/hierarchy";
import { completeSimulatedEntityOnboarding, entityDashboardUrl, entityOnboardingUrl, refreshEntityAccount } from "@/server/payments/connect";

const BANKING = "Only the Brand Owner, a Franchisee Owner, or someone they've given the banking permission, can connect an owner group's Stripe account and bank";
const BRAND = "Only the brand can change owner groups, regions and royalty rates";

function refresh() {
  revalidatePath("/admin/franchise");
  revalidatePath("/admin/setup");
}

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return appBaseUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Banking on an owner group's account: entity.banking (franchisee owners) or payments.banking (the brand), inside reach. */
async function banker(entityId: string): Promise<StaffContext> {
  const ctx = await requireStaff();
  if (!ctx.permissions.has("entity.banking") && !ctx.permissions.has("payments.banking")) throw forbidden(BANKING);
  assertEntity(ctx, entityId);
  return ctx;
}

/** Creates the owner group's Stripe Connect account if needed and returns Stripe's hosted onboarding link. */
export async function startEntityOnboardingAction(entityId: string) {
  return safe(async () => {
    const ctx = await banker(entityId);
    const url = await entityOnboardingUrl(entityId, ctx.actor, await origin());
    refresh();
    return { url };
  });
}

export async function refreshEntityAccountAction(entityId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    if (!(["entity.finances", "entity.banking", "payments.accounts"] as const).some((p) => ctx.permissions.has(p))) throw forbidden();
    assertEntity(ctx, entityId);
    await refreshEntityAccount(entityId);
    refresh();
    return null;
  });
}

export async function completeSimulatedEntityOnboardingAction(entityId: string, withBank: boolean) {
  return safe(async () => {
    const ctx = await banker(entityId);
    await completeSimulatedEntityOnboarding(entityId, ctx.actor, { withBank });
    refresh();
    return null;
  });
}

export async function entityDashboardAction(entityId: string) {
  return safe(async () => {
    const ctx = await banker(entityId);
    const url = await entityDashboardUrl(entityId);
    if (!url) throw new AppError("bad_request", "The Stripe dashboard opens once onboarding is finished");
    await audit(ctx.actor, "payments.dashboard_opened", "owner_entity", entityId, {}, null);
    return { url };
  });
}

const Entity = z.object({
  name: z.string(),
  legalName: z.string().nullable(),
  kind: z.enum(["brand", "franchisee"]),
  contactEmail: z.string().nullable(),
  payrollCompanyCode: z.string().nullable(),
  status: z.enum(["onboarding", "active", "exited"]),
});

export async function saveEntityAction(id: string | null, raw: z.input<typeof Entity>) {
  return safe(async () => {
    const ctx = await authorize("entities.manage", BRAND);
    const r = await saveEntity(ctx.actor, id, Entity.parse(raw));
    refresh();
    return r;
  });
}

const Settings = z.object({ contactEmail: z.string().nullable(), payrollCompanyCode: z.string().nullable(), taxSettings: z.unknown() });

/** An owner group's own settings: its owner (entity.settings) or the brand. */
export async function saveEntitySettingsAction(entityId: string, raw: z.input<typeof Settings>) {
  return safe(async () => {
    const ctx = await requireStaff();
    requireEntityAccess(ctx, entityId, "entity.settings");
    await saveEntitySettings(ctx.actor, entityId, Settings.parse(raw));
    refresh();
    return null;
  });
}

const Terms = z.object({ effectiveFrom: z.string(), royaltyPct: z.string(), adFundPct: z.string(), collect: z.enum(["application_fee", "invoice"]) });

export async function addFeeTermsAction(entityId: string, raw: z.input<typeof Terms>) {
  return safe(async () => {
    const ctx = await authorize("entities.manage", BRAND);
    const v = Terms.parse(raw);
    const royaltyBps = parsePercentBps(v.royaltyPct || "0");
    const adFundBps = parsePercentBps(v.adFundPct || "0");
    if (royaltyBps == null || adFundBps == null) throw new AppError("bad_request", "Enter each rate as a percent, e.g. 6 or 6.5 (30% at most)");
    await addFeeTerms(ctx.actor, entityId, { effectiveFrom: v.effectiveFrom, royaltyBps, adFundBps, collect: v.collect });
    refresh();
    return null;
  });
}

const Region = z.object({ name: z.string(), ownerEntityId: z.string().uuid().nullable() });

export async function saveRegionAction(id: string | null, raw: z.input<typeof Region>) {
  return safe(async () => {
    const ctx = await authorize("entities.manage", BRAND);
    const r = await saveRegion(ctx.actor, id, Region.parse(raw));
    refresh();
    return r;
  });
}

export async function deleteRegionAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("entities.manage", BRAND);
    await deleteRegion(ctx.actor, id);
    refresh();
    return null;
  });
}

/** Moves a location to another owner group and/or region. */
export async function moveShopAction(shopId: string, ownerEntityId: string, regionId: string | null) {
  return safe(async () => {
    const ctx = await authorize("entities.manage", BRAND);
    assertShopAccess(ctx, shopId);
    const r = await moveShop(ctx.actor, shopId, { ownerEntityId, regionId });
    refresh();
    revalidatePath("/admin", "layout");
    return r;
  });
}

export async function saveStandardsAction(raw: unknown) {
  return safe(async () => {
    const ctx = await authorize("standards.manage", "Only the brand sets brand standards");
    await saveStandards(ctx.actor, raw);
    refresh();
    return null;
  });
}

export async function saveFranchiseDataAction(raw: unknown) {
  return safe(async () => {
    const ctx = await authorize("entities.manage", "Only the brand decides how client data is shared with franchisees");
    await saveFranchiseData(ctx.actor, raw);
    refresh();
    return null;
  });
}
