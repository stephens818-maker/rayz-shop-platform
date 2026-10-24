"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { services, shopServices } from "@/db/schema";
import { LOCAL_PRICES, priceStandardProblem } from "@/domain/brand-standards";
import { durationProblem } from "@/domain/timing";
import { slugify } from "@/lib/ids";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { assertLocalService } from "@/server/standards";

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
    const before = await db.query.shopServices.findFirst({ where: and(eq(shopServices.shopId, shopId), eq(shopServices.serviceId, serviceId)) });
    await assertLocalService(ctx, serviceId, {
      priceCents: o.priceCents !== (before?.priceCents ?? null) ? o.priceCents : null,
      nameOverride: (o.nameOverride || null) !== (before?.nameOverride ?? null) ? o.nameOverride || null : null,
      durationMin: o.durationMin !== (before?.durationMin ?? null) ? o.durationMin : null,
    });
    if (o.durationMin !== null) {
      const svc = await db.query.services.findFirst({ where: eq(services.id, serviceId), columns: { durationStepMin: true } });
      const problem = durationProblem(o.durationMin, svc?.durationStepMin ?? 5);
      if (problem) throw new AppError("bad_request", problem);
    }
    const values = { ...o, nameOverride: o.nameOverride || null };
    await db
      .insert(shopServices)
      .values({ shopId, serviceId, ...values })
      .onConflictDoUpdate({ target: [shopServices.shopId, shopServices.serviceId], set: values });
    await audit(ctx.actor, "service.shop_override", "service", serviceId, values, shopId);
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
  localPrice: z.enum(LOCAL_PRICES).default("open"),
  priceFloorCents: z.number().int().min(0).nullable().default(null),
  priceCeilingCents: z.number().int().min(0).nullable().default(null),
  localName: z.boolean().default(true),
  localDuration: z.boolean().default(true),
});

export async function saveMasterServiceAction(raw: z.input<typeof Master>) {
  return safe(async () => {
    const ctx = await authorize("catalog.manage");
    const m = Master.parse(raw);
    const { id, ...values } = m;
    const standard = priceStandardProblem({ brandPriceCents: m.defaultPriceCents, localPrice: m.localPrice, priceFloorCents: m.priceFloorCents, priceCeilingCents: m.priceCeilingCents });
    if (standard) throw new AppError("bad_request", standard);
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
