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

export async function signOffAction(shopId: string) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    assertShopAccess(ctx, Shop.parse(shopId));
    await signOffAndSwitch(ctx.actor, shopId);
    refresh(shopId);
    revalidatePath("/admin/settings");
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
