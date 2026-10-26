"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { services, shopServices } from "@/db/schema";
import { durationProblem } from "@/domain/timing";
import { slugify } from "@/lib/ids";
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

const Master = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1),
  kind: z.enum(["service", "addon"]),
  category: z.string().trim().min(1),
  description: z.string().trim().nullable(),
  defaultPriceCents: z.number().int().min(0),
  defaultDurationMin: z.number().int().min(5).max(480),
  active: z.boolean(),
  sortOrder: z.number().int(),
});

export async function saveMasterServiceAction(raw: z.input<typeof Master>) {
  return safe(async () => {
    const ctx = await authorize("catalog.manage");
    const m = Master.parse(raw);
    const { id, ...values } = m;
    const step = id ? (await db.query.services.findFirst({ where: eq(services.id, id), columns: { durationStepMin: true } }))?.durationStepMin : 5;
    const problem = durationProblem(m.defaultDurationMin, step ?? 5);
    if (problem) throw new AppError("bad_request", problem);
    let serviceId = id;
    if (id) {
      await db.update(services).set(values).where(eq(services.id, id));
    } else {
      const base = slugify(m.name);
      if (!base) throw new AppError("bad_request", "Name needs letters or numbers");
      const exists = await db.query.services.findFirst({ where: eq(services.slug, base) });
      const [row] = await db
        .insert(services)
        .values({ ...values, slug: exists ? `${base}-${Date.now().toString(36).slice(-4)}` : base })
        .returning({ id: services.id });
      serviceId = row.id;
    }
    await audit(ctx.actor, id ? "service.update" : "service.create", "service", serviceId!, values, null);
    revalidatePath("/admin/services");
    return { id: serviceId };
  });
}
