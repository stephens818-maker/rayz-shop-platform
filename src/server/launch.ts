import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { AppError, notFound } from "@/server/errors";

/**
 * The brand instant is when the store apps leave the full-screen coming-soon state.
 * Each shop has its own gate. A shop with no `shops.launch_at` stays on Squire, even after
 * the brand instant. Core should call `shopLaunchState` / `assertLaunched` for any public
 * web path that does not already go through `createAppointment`.
 *
 * `LAUNCH_AT` (ISO-8601 UTC) overrides `brand_settings.launch_at`. It does not open a shop.
 */
export type LaunchSurface = "booking" | "payments" | "push";

export interface LaunchState {
  launched: boolean;
  /** ISO-8601 UTC, or null when no launch time is configured. */
  launchAt: string | null;
  /** `shop` when this answer is about one shop. `brand` for the app-release instant. */
  scope: "brand" | "shop";
}

export const COMING_SOON_MESSAGE = "Ray'z isn't open in the app yet. Coming soon.";

/** Shown for a shop that is still on Squire. Apps must not offer booking or payment. */
export const DEFAULT_CLOSED_SHOP_COPY = "Book with us at this shop the usual way.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse an env timestamp. Blank means "not set". An unparseable value is a misconfiguration, not a silent launch. */
export function parseLaunchAt(raw: string | null | undefined): Date | null {
  if (raw == null || raw.trim() === "") return null;
  const at = new Date(raw.trim());
  if (Number.isNaN(at.getTime())) throw new AppError("internal", "LAUNCH_AT must be an ISO-8601 UTC timestamp.");
  return at;
}

/**
 * A shop is live only when its own instant is set and has passed.
 * The brand instant is ignored here on purpose: opening the apps must not open every shop.
 */
export function effectiveLaunch(shopLaunchAt: Date | null | undefined, brand: LaunchState, now = new Date()): LaunchState {
  void brand;
  if (shopLaunchAt) {
    return { launched: now.getTime() >= shopLaunchAt.getTime(), launchAt: shopLaunchAt.toISOString(), scope: "shop" };
  }
  return { launched: false, launchAt: null, scope: "shop" };
}

export async function launchState(now = new Date()): Promise<LaunchState> {
  const fromEnv = process.env.LAUNCH_AT?.trim();
  const at = fromEnv
    ? parseLaunchAt(fromEnv)
    : ((await db.query.brandSettings.findFirst({ columns: { launchAt: true } }))?.launchAt ?? null);
  const launchAt = at ? at.toISOString() : null;
  return { launched: at !== null && now.getTime() >= at.getTime(), launchAt, scope: "brand" };
}

/** Sentence the apps show on a shop that is not taking Rayz bookings. Env wins over the brand column. */
export async function closedShopCopy(): Promise<string> {
  const fromEnv = process.env.CLOSED_SHOP_COPY?.trim();
  if (fromEnv) return fromEnv;
  const fromDb = (await db.query.brandSettings.findFirst({ columns: { closedShopCopy: true } }))?.closedShopCopy?.trim();
  return fromDb || DEFAULT_CLOSED_SHOP_COPY;
}

export async function shopLaunchState(shopRef: string, now = new Date()): Promise<LaunchState & { shopId: string; slug: string }> {
  const where = UUID_RE.test(shopRef) ? or(eq(shops.id, shopRef), eq(shops.slug, shopRef)) : eq(shops.slug, shopRef);
  const shop = await db.query.shops.findFirst({ where, columns: { id: true, slug: true, launchAt: true } });
  if (!shop) throw notFound("Shop");
  const state = effectiveLaunch(shop.launchAt, await launchState(now), now);
  return { ...state, shopId: shop.id, slug: shop.slug };
}

/** Shops open on their own instant while the brand apps are still on the coming-soon screen. */
export async function pilotShopSlugs(now = new Date()): Promise<string[]> {
  const brand = await launchState(now);
  if (brand.launched) return [];
  const rows = await db.select({ slug: shops.slug, launchAt: shops.launchAt, active: shops.active }).from(shops);
  return rows.filter((row) => row.active && row.launchAt && now.getTime() >= row.launchAt.getTime()).map((row) => row.slug);
}

export async function assertLaunched(surface: LaunchSurface, now = new Date(), shopRef?: string | null): Promise<void> {
  const state = shopRef ? await shopLaunchState(shopRef, now) : await launchState(now);
  if (state.launched) return;
  const copy = shopRef ? await closedShopCopy() : null;
  throw new AppError("forbidden", copy ?? COMING_SOON_MESSAGE, {
    reason: "not_launched",
    surface,
    launched: false,
    launchAt: state.launchAt,
    scope: state.scope,
    shopId: shopRef && "shopId" in state ? state.shopId : null,
    closedCopy: copy,
  });
}
