import "server-only";
import { rangeHeading } from "@/domain/report-range";
import type { StaffContext } from "@/server/auth/staff";
import { payPeriodPicker, type PayPeriodPickerGroup } from "@/server/payroll/periods";
import { buildPayroll, narrowView, officialGroups, type PayrollView } from "@/server/payroll/run";
import { type ReportLocations, type ResolvedRange, resolveLocations, resolveRange } from "../../reports/scope";

const PERIOD = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

export type PayrollRangeParams = { period?: string; preset?: string; from?: string; to?: string; shop?: string | string[] };

export interface PayrollRange {
  range: ResolvedRange;
  /** "Last pay period: Oct 4 – 17, 2026". */
  heading: string;
  locations: ReportLocations;
  /** The dates are one full pay period of a pay group the shops shown are on: approve and lock, adjustments and the iSolved files apply. */
  official: boolean;
  /** What the page shows: the official period cut down to the shops picked, or a review of the dates. */
  view: PayrollView | null;
  /** Official: the whole pay period, every shop on it, which approve and lock covers. */
  full: PayrollView | null;
  /** Official: shops picked that aren't on this pay period (Dubuque runs on its own calendar). */
  offCalendar: { shopId: string; shop: string }[];
  /** Official: how many shops on this pay period aren't shown. Approve and lock waits until every one is. */
  hidden: number;
  payPeriods: PayPeriodPickerGroup[];
}

/**
 * The dates and shops a Payroll Report page shows. Any range can be reviewed; only a full pay period
 * of a pay group is official. Links from before the picker (`period=<start>_<end>`) still open
 * that period. Every shop the viewer has is shown unless they pick some.
 */
export async function payrollRange(ctx: StaffContext, sp: PayrollRangeParams, key: string): Promise<PayrollRange> {
  const legacy = PERIOD.exec(sp.period ?? "");
  const p = legacy && !sp.from && !sp.preset ? { from: legacy[1], to: legacy[2] } : sp;
  const locations = await resolveLocations(ctx, { shop: sp.shop ?? "all" });
  const selected = locations.selection.shopIds;
  const range = await resolveRange(p, { shopIds: selected, defaultPreset: "lastpayperiod", memory: { staffId: ctx.staff.id, key }, wholePayPeriod: true });
  const heading = rangeHeading({ from: range.from, to: range.to, label: range.rangeLabel });
  const [groups, payPeriods] = await Promise.all([officialGroups(range.from, range.to), payPeriodPicker(selected)]);
  const on = groups.filter((g) => selected.includes(g.shopId));
  if (!on.length) {
    const view = await buildPayroll(range.from, range.to, { review: { shopIds: selected } });
    return { range, heading, locations, official: false, view, full: null, offCalendar: [], hidden: 0, payPeriods };
  }
  const full = await buildPayroll(range.from, range.to);
  const shown = on.map((g) => g.shopId).filter((id) => ctx.shopIds.includes(id));
  const view = full ? narrowView(full, shown) : null;
  return {
    range,
    heading,
    locations,
    official: true,
    view,
    full,
    offCalendar: selected.filter((id) => !groups.some((g) => g.shopId === id)).map((id) => ({ shopId: id, shop: ctx.shops.find((s) => s.id === id)?.name ?? "" })),
    hidden: full ? full.blocks.length - (view?.blocks.length ?? 0) : 0,
    payPeriods,
  };
}

/** The link query that reopens the same dates and shops. */
export function payrollRangeQuery(r: Pick<PayrollRange, "range" | "locations">, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(r.range.preset ? { preset: r.range.preset } : { from: r.range.from, to: r.range.to });
  if (r.locations.shopParam) q.set("shop", r.locations.shopParam);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}
