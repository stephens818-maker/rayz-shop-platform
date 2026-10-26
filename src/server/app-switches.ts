/**
 * Customer app kill switches. Each is on unless the Brand Owner or a Brand Admin turns it off under
 * Setup → App switches (stored on brand_settings, so it takes effect at once, no deploy), or the env
 * var APP_KILL lists it (comma-separated) for an emergency from Vercel. Per-shop booking is each
 * shop's own "Online booking on" switch; force-upgrade is the minimum app version.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings } from "@/db/schema";
import { Actor, audit } from "./audit";
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
  const row = await db.query.brandSettings.findFirst({ where: eq(brandSettings.id, 1), columns: { appSwitches: true } });
  const v = switchesFrom(row?.appSwitches);
  cache = { at: Date.now(), v };
  return v;
}

export const resetAppSwitchCache = () => {
  cache = null;
};

export async function assertSwitch(k: AppSwitch) {
  if (!(await appSwitches())[k]) throw new AppError("forbidden", "This is turned off for now. Please try again later or call the shop.", { switch: k });
}

export async function saveAppSwitches(actor: Actor, next: Partial<AppSwitches>) {
  const row = await db.query.brandSettings.findFirst({ where: eq(brandSettings.id, 1), columns: { appSwitches: true } });
  const stored = { ...(row?.appSwitches ?? {}) };
  for (const k of APP_SWITCHES) if (typeof next[k] === "boolean") stored[k] = next[k];
  await db
    .insert(brandSettings)
    .values({ id: 1, loyalty: {}, appSwitches: stored })
    .onConflictDoUpdate({ target: brandSettings.id, set: { appSwitches: stored, updatedAt: new Date() } });
  resetAppSwitchCache();
  await audit(actor, "app_switches.update", "brand_settings", null, stored);
  return switchesFrom(stored);
}

/** Switches APP_KILL holds off, which the page can't turn back on. */
export const envKilled = (): AppSwitch[] => APP_SWITCHES.filter((k) => killedByEnv().has(k));
