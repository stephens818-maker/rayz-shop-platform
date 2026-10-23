import type { EarningsResponse } from "@rayz/api";
import { isSnapshotPeriod, LATE_ADJUSTMENT_COPY, payPeriodFor } from "@rayz/api";
import { buildEarnings, earningsDays, nextOpenPeriod, payrollCsv, type AdjustmentRecord, type EarningsWorld } from "./engine";
import { TODAY, seedAdjustments, seedFloors, seedHours, seedPeriods, seedSales, seedShops, seedStaff } from "./fixtures";

export interface World extends EarningsWorld {
  today: string;
  snapshots: Map<string, EarningsResponse>;
}

export function createWorld(): World {
  const world: World = {
    today: TODAY,
    weekStartDay: 0,
    shops: seedShops(),
    staff: seedStaff(),
    hours: seedHours(),
    sales: seedSales(),
    adjustments: seedAdjustments(),
    periods: seedPeriods(),
    floors: seedFloors(),
    snapshots: new Map(),
  };
  for (const period of world.periods) {
    if (!isSnapshotPeriod(period.periodStatus)) continue;
    for (const person of world.staff) {
      const snap = buildEarnings(world, person.id, { from: period.start, to: period.end }, { snapshot: true });
      snap.computedAt = period.computedAt;
      snap.snapshotId = period.snapshotId;
      snap.isEstimate = false;
      world.snapshots.set(`${person.id}|${period.id}`, structuredClone(snap));
    }
  }
  return world;
}

export function earningsFor(world: World, staffId: string, range: { from: string; to: string }): EarningsResponse {
  const period = world.periods.find((p) => p.start === range.from && p.end === range.to);
  if (period && isSnapshotPeriod(period.periodStatus)) {
    const snap = world.snapshots.get(`${staffId}|${period.id}`);
    if (snap) return structuredClone(snap);
  }
  return buildEarnings(world, staffId, range);
}

export function declareCashTip(world: World, staffId: string, input: { shopId: string; amountCents: number; originalDate: string; postedOn: string }): AdjustmentRecord {
  if (input.amountCents < 0) throw new Error("Cash tips cannot be negative");
  const home = payPeriodFor(input.originalDate);
  const meta = world.periods.find((p) => p.id === home.id);
  const closed = !meta || meta.periodStatus !== "draft" || meta.payrollStatus !== "not_yet_processed";
  if (!closed) throw new Error("This period is still open. Declare the tip on the day it was received.");
  nextOpenPeriod(world, input.originalDate);
  const row: AdjustmentRecord = {
    id: `adj_${world.adjustments.length + 1}`,
    staffId,
    shopId: input.shopId,
    kind: "late_cash_tip",
    amountCents: input.amountCents,
    originalDate: input.originalDate,
    postedDate: input.postedOn,
    lateDeclaration: true,
    reducesPay: false,
    copy: LATE_ADJUSTMENT_COPY,
  };
  world.adjustments.push(row);
  return row;
}

export { earningsDays, payrollCsv };
