/**
 * Customer app kill switches. Each is on unless the Brand Owner or a Brand Admin turns it off under
 * Setup → App switches (through the brand change scope, so it takes effect at once, no deploy), or the env
 * var APP_KILL lists it (comma-separated) for an emergency from Vercel. Per-shop booking is each
 * shop's own "Online booking on" switch; force-upgrade is the minimum app version.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { shopSyncState, shops } from "@/db/schema";
import { brandColumn } from "./brand-sync/settings";
import { localValue } from "./brand-sync/store";
import { AppError } from "./errors";

export const APP_SWITCHES = ["booking", "payments", "family", "pushMarketing"] as const;
export type AppSwitch = (typeof APP_SWITCHES)[number];
export type AppSwitches = Record<AppSwitch, boolean>;

export const APP_SWITCH_LABEL: Record<AppSwitch, string> = {
  booking: "Booking in the app and on the website",
  payments: "Saved cards and paying in the app",
  family: "Family profiles in the app",
  pushMarketing: "Marketing push notifications",
};

const killedByEnv = () => new Set((process.env.APP_KILL ?? "").split(",").map((s) => s.trim()).filter(Boolean));

export function switchesFrom(stored: Record<string, unknown> | null | undefined): AppSwitches {
  const env = killedByEnv();
  return Object.fromEntries(APP_SWITCHES.map((k) => [k, !env.has(k) && stored?.[k] !== false])) as AppSwitches;
}

let cache: { at: number; v: AppSwitches } | null = null;

export async function appSwitches(): Promise<AppSwitches> {
  if (cache && Date.now() - cache.at < 5_000 && !process.env.VITEST) return cache.v;
  const v = switchesFrom(await brandColumn("appSwitches"));
  cache = { at: Date.now(), v };
  return v;
}

export const resetAppSwitchCache = () => {
  cache = null;
};

const OFF_MESSAGE = "This is turned off for now. Please try again later or call the shop.";

export async function assertSwitch(k: AppSwitch) {
  if (!(await appSwitches())[k]) throw new AppError("forbidden", OFF_MESSAGE, { switch: k });
}

/** Switches a shop can have its own of (Setup → Sync status); the rest are app-wide. */
export const SHOP_SWITCHES = ["booking", "payments"] as const satisfies readonly AppSwitch[];
type ShopSwitch = (typeof SHOP_SWITCHES)[number];
const isShopSwitch = (k: AppSwitch): k is ShopSwitch => (SHOP_SWITCHES as readonly string[]).includes(k);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The app switches at one shop: booking and payments are the shop's own value where it has one,
 * else the brand's; the others are the brand's. APP_KILL turns anything off everywhere.
 */
export async function shopSwitches(shopRef: string | null | undefined): Promise<AppSwitches> {
  const all = await appSwitches();
  if (!shopRef) return all;
  const shopId = UUID.test(shopRef) ? shopRef : (await db.query.shops.findFirst({ where: eq(shops.slug, shopRef), columns: { id: true } }))?.id;
  const own = await localValue<Partial<AppSwitches>>("app", "switches", shopId);
  if (!own) return all;
  const env = killedByEnv();
  return { ...all, ...Object.fromEntries(SHOP_SWITCHES.map((k) => [k, !env.has(k) && (typeof own[k] === "boolean" ? own[k] : all[k])])) };
}

/** As assertSwitch, at one shop (an id or booking slug). */
export async function assertShopSwitch(k: AppSwitch, shopRef: string | null | undefined) {
  if (!(await shopSwitches(shopRef))[k]) throw new AppError("forbidden", OFF_MESSAGE, { switch: k });
}

/** What the app shows: booking and payments are on where any shop that's open has them on; each shop is checked when it's used. */
export async function appFeatures(): Promise<AppSwitches> {
  const all = await appSwitches();
  const env = killedByEnv();
  const open = await db.select({ id: shops.id }).from(shops).where(ne(shops.status, "archived"));
  const own = await db.select({ shopId: shopSyncState.shopId, local: shopSyncState.local }).from(shopSyncState).where(and(eq(shopSyncState.key, "app:switches"), isNotNull(shopSyncState.local)));
  const byShop = new Map(own.map((r) => [r.shopId, r.local as Partial<AppSwitches>]));
  const out = { ...all };
  for (const k of APP_SWITCHES) {
    if (!isShopSwitch(k) || env.has(k) || !open.length) continue;
    out[k] = open.some((s) => {
      const v = byShop.get(s.id)?.[k];
      return typeof v === "boolean" ? v : all[k];
    });
  }
  return out;
}

/** Switches APP_KILL holds off, which the page can't turn back on. */
export const envKilled = (): AppSwitch[] => APP_SWITCHES.filter((k) => killedByEnv().has(k));
