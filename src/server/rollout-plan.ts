import { eq } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { shopRollouts, shops } from "@/db/schema";
import type { LocalDate } from "@/lib/time";
import { AppError } from "./errors";

export type PayrollSource = "platform" | "squire";
export type RolloutRow = typeof shopRollouts.$inferSelect;

export interface RolloutPlan {
  /** A rollout is planned once any shop has a row. Before that (a new brand, the demo, tests) every shop's payroll comes from here. */
  active: boolean;
  rows: Map<string, RolloutRow>;
  /** Where a shop's payroll comes from for the pay period a day is in. */
  sourceOf(shopId: string, date: LocalDate): PayrollSource;
  waveOf(shopId: string): 1 | 2;
  pilot: RolloutRow | null;
}

/**
 * With a rollout planned, a shop's payroll comes from this platform from its "payroll from" pay
 * period on. Before it, or with no date (or no row) yet, it comes from the Squire data imported for
 * the period: the safe side, since a shop that isn't on the platform has no punches or tickets here.
 */
export function planOf(list: readonly RolloutRow[]): RolloutPlan {
  const rows = new Map(list.map((r) => [r.shopId, r]));
  const active = list.length > 0;
  return {
    active,
    rows,
    sourceOf: (shopId, date) => {
      if (!active) return "platform";
      const from = rows.get(shopId)?.payrollFrom;
      return from && date >= from ? "platform" : "squire";
    },
    waveOf: (shopId) => (rows.get(shopId)?.wave === 1 ? 1 : 2),
    pilot: list.find((r) => r.wave === 1) ?? null,
  };
}

export async function loadRolloutPlan(tx: DBorTx = db): Promise<RolloutPlan> {
  return planOf(await tx.select().from(shopRollouts));
}

/**
 * Why a shop can't switch its booking over yet, or null. The pilot (wave 1) switches once it's
 * reconciled; the rest wait for an owner to sign off the pilot's first clean pay period.
 */
export async function switchRefusal(shopId: string, tx: DBorTx = db): Promise<string | null> {
  const plan = await loadRolloutPlan(tx);
  if (!plan.active || plan.waveOf(shopId) === 1) return null;
  const [shop] = await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
  const [pilot] = plan.pilot ? await tx.select({ name: shops.name, bookingMode: shops.bookingMode }).from(shops).where(eq(shops.id, plan.pilot.shopId)) : [];
  if (pilot && plan.pilot?.cleanSignedAt && pilot.bookingMode !== "external") return null;
  return pilot
    ? `${shop?.name ?? "This shop"} is in the second wave: it switches after ${pilot.name}'s first clean pay period on this platform is signed off on the Rollout page.`
    : `${shop?.name ?? "This shop"} is in the second wave, and no pilot shop is picked yet. Pick the pilot on the Rollout page; the rest switch after its first clean pay period.`;
}

export async function assertMaySwitch(shopId: string, tx: DBorTx = db) {
  const why = await switchRefusal(shopId, tx);
  if (why) throw new AppError("conflict", why);
}
