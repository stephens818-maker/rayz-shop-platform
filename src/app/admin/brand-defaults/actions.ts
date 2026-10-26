"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { DEFAULT_FIELDS, DefaultKey, SECTION_SHOP_PERMISSIONS, isDefaultKey } from "@/domain/location-defaults";
import type { Permission } from "@/domain/permissions";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { assertShopMayEdit, noteShopEdit } from "@/server/brand-sync/engine";
import { AppError, forbidden } from "@/server/errors";
import { clearShopOverride, saveBrandDefault, setShopOverride } from "@/server/location-defaults";

function keyOf(raw: string): DefaultKey {
  if (!isDefaultKey(raw)) throw new AppError("bad_request", "Unknown setting");
  return raw;
}

/** A starting role has to exist and work at a shop: not a shop login, not an all-shops role. */
async function checkRole(key: DefaultKey, value: unknown) {
  if (DEFAULT_FIELDS[key].kind !== "role") return;
  const r = await db.query.roles.findFirst({ where: eq(roles.key, String(value)) });
  if (!r || r.key === "shop_login" || r.defaultScope === "all") throw new AppError("bad_request", "Pick a role for people who work at a shop");
}

const refresh = () => {
  revalidatePath("/admin/brand-defaults");
  revalidatePath("/admin/settings");
};

/** Brand values reach every following location, so they need brand settings and every shop. */
export async function saveBrandDefaultAction(rawKey: string, value: unknown) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    if (!ctx.brandWide) throw forbidden("Brand defaults apply at every shop, so they need access to all shops");
    const key = keyOf(rawKey);
    await checkRole(key, value);
    const r = await saveBrandDefault(ctx.actor, key, value);
    refresh();
    return r;
  });
}

const shopPerms = (key: DefaultKey) => [...SECTION_SHOP_PERMISSIONS[DEFAULT_FIELDS[key].section]] as Permission[];

export async function setShopOverrideAction(shopId: string, rawKey: string, value: unknown) {
  return safe(async () => {
    const key = keyOf(rawKey);
    const ctx = await authorize(shopPerms(key));
    assertShopAccess(ctx, shopId);
    await checkRole(key, value);
    await assertShopMayEdit(ctx, "location_default");
    await setShopOverride(ctx.actor, shopId, key, value);
    await noteShopEdit("location_default", [key], shopId);
    refresh();
    return null;
  });
}

export async function clearShopOverrideAction(shopId: string, rawKey: string) {
  return safe(async () => {
    const key = keyOf(rawKey);
    const ctx = await authorize(shopPerms(key));
    assertShopAccess(ctx, shopId);
    await clearShopOverride(ctx.actor, shopId, key);
    await noteShopEdit("location_default", [key], shopId);
    refresh();
    return null;
  });
}
