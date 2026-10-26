"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { services, shopServices } from "@/db/schema";
import { durationProblem } from "@/domain/timing";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { assertShopMayEdit, noteShopEdit } from "@/server/brand-sync/engine";
import { AppError } from "@/server/errors";

const Override = z.object({
  enabled: z.boolean(),
  bookableOnline: z.boolean(),
  priceCents: z.number().int().min(0).nullable(),
  durationMin: z.number().int().min(5).max(480).nullable(),
  nameOverride: z.string().trim().max(80).nullable(),
});

export async function saveShopServiceAction(shopId: string, serviceId: string, raw: z.input<typeof Override>) {
  return safe(async () => {
    const ctx = await authorize(["catalog.prices", "catalog.manage"]);
    assertShopAccess(ctx, shopId);
    const o = Override.parse(raw);
    if (o.durationMin !== null) {
      const svc = await db.query.services.findFirst({ where: eq(services.id, serviceId), columns: { durationStepMin: true } });
      const problem = durationProblem(o.durationMin, svc?.durationStepMin ?? 5);
      if (problem) throw new AppError("bad_request", problem);
    }
    const values = { ...o, nameOverride: o.nameOverride || null };
    const before = await db.query.shopServices.findFirst({ where: and(eq(shopServices.shopId, shopId), eq(shopServices.serviceId, serviceId)) });
    const offered = (r: { enabled: boolean; priceCents: number | null; durationMin: number | null } | undefined) => (r ? [r.enabled, r.priceCents, r.durationMin].join("|") : "false||");
    if (offered(before) !== offered(values)) await assertShopMayEdit(ctx, "service");
    await db
      .insert(shopServices)
      .values({ shopId, serviceId, ...values })
      .onConflictDoUpdate({ target: [shopServices.shopId, shopServices.serviceId], set: values });
    await audit(ctx.actor, "service.shop_override", "service", serviceId, values, shopId);
    await noteShopEdit("service", [serviceId], shopId);
    revalidatePath("/admin/services");
    return null;
  });
}
