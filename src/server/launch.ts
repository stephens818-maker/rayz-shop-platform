import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { AppError, notFound } from "@/server/errors";

/**
 * One brand launch instant, plus an optional per-shop instant for a pilot or a hold-back.
 * Core should call `launchState` / `shopLaunchState` / `assertLaunched` for any public web path
 * that does not already go through `createAppointment` (the booking wizard's POST /api/v1/appointments is already gated).
 *
 * `LAUNCH_AT` (ISO-8601 UTC) overrides `brand_settings.launch_at`. A shop with `shops.launch_at` set
 * uses that instant instead of the brand. Null on the shop follows the brand. If the brand is unset
 * and the shop is unset, that shop is not live.
 */
export type LaunchSurface = "booking" | "payments" | "push";

export interface LaunchState {
  launched: boolean;
  /** ISO-8601 UTC, or null when no launch time is configured. */
  launchAt: string | null;
  /** `shop` when this shop has its own instant. `brand` when it follows LAUNCH_AT. */
  scope: "brand" | "shop";
}

export const COMING_SOON_MESSAGE = "Ray'z isn't open in the app yet. Coming soon.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse an env timestamp. Blank means "not set". An unparseable value is a misconfiguration, not a silent launch. */
export function parseLaunchAt(raw: string | null | undefined): Date | null {
  if (raw == null || raw.trim() === "") return null;
  const at = new Date(raw.trim());
  if (Number.isNaN(at.getTime())) throw new AppError("internal", "LAUNCH_AT must be an ISO-8601 UTC timestamp.");
  return at;
}

/** A shop instant wins. Otherwise the shop follows the brand. */
export function effectiveLaunch(shopLaunchAt: Date | null | undefined, brand: LaunchState, now = new Date()): LaunchState {
  if (shopLaunchAt) {
    return { launched: now.getTime() >= shopLaunchAt.getTime(), launchAt: shopLaunchAt.toISOString(), scope: "shop" };
  }
  return { launched: brand.launched, launchAt: brand.launchAt, scope: "brand" };
}

export async function launchState(now = new Date()): Promise<LaunchState> {
  const fromEnv = process.env.LAUNCH_AT?.trim();
  const at = fromEnv
    ? parseLaunchAt(fromEnv)
    : ((await db.query.brandSettings.findFirst({ columns: { launchAt: true } }))?.launchAt ?? null);
  const launchAt = at ? at.toISOString() : null;
  return { launched: at !== null && now.getTime() >= at.getTime(), launchAt, scope: "brand" };
}

export async function shopLaunchState(shopRef: string, now = new Date()): Promise<LaunchState & { shopId: string; slug: string }> {
  const where = UUID_RE.test(shopRef) ? or(eq(shops.id, shopRef), eq(shops.slug, shopRef)) : eq(shops.slug, shopRef);
  const shop = await db.query.shops.findFirst({ where, columns: { id: true, slug: true, launchAt: true } });
  if (!shop) throw notFound("Shop");
  const state = effectiveLaunch(shop.launchAt, await launchState(now), now);
  return { ...state, shopId: shop.id, slug: shop.slug };
}

/** Shops that are open on their own instant while the brand is still closed. */
export async function pilotShopSlugs(now = new Date()): Promise<string[]> {
  const brand = await launchState(now);
  if (brand.launched) return [];
  const rows = await db.select({ slug: shops.slug, launchAt: shops.launchAt, active: shops.active }).from(shops);
  return rows.filter((row) => row.active && row.launchAt && now.getTime() >= row.launchAt.getTime()).map((row) => row.slug);
}

export async function assertLaunched(surface: LaunchSurface, now = new Date(), shopRef?: string | null): Promise<void> {
  const state = shopRef ? await shopLaunchState(shopRef, now) : await launchState(now);
  if (state.launched) return;
  throw new AppError("forbidden", COMING_SOON_MESSAGE, {
    reason: "not_launched",
    surface,
    launched: false,
    launchAt: state.launchAt,
    scope: state.scope,
    shopId: shopRef && "shopId" in state ? state.shopId : null,
  });
}
