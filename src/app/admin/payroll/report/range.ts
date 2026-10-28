import "server-only";
import { rangeHeading, wholeWorkweeks } from "@/domain/report-range";
import type { StaffContext } from "@/server/auth/staff";
import { payPeriodPicker, payrollPresetChips, type PayPeriodPickerGroup } from "@/server/payroll/periods";
import { buildPayroll, narrowView, officialGroups, overlapMessage, type PayrollView, type RunKind } from "@/server/payroll/run";
import { type ReportLocations, type ResolvedRange, resolveLocations, resolveRange } from "../../reports/scope";

const PERIOD = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

export type PayrollRangeParams = { period?: string; preset?: string; from?: string; to?: string; shop?: string | string[] };

export interface PayrollRange {
  range: ResolvedRange;
  /** "Last pay period: Oct 4 – 17, 2026". */
  heading: string;
  locations: ReportLocations;
  /** A pay period of a pay group the shops shown are on (the usual run), whole workweeks for the shops picked, or a review of any other dates. */
  kind: RunKind;
  /** Approve and lock and the iSolved files apply (a pay period, or whole workweeks); adjustments only on a pay period. */
  official: boolean;
  /** What the page shows: the run cut down to the shops picked, or a review of the dates. */
  view: PayrollView | null;
  /** Official: what approve and lock covers. A pay period: every shop on it. Whole workweeks: the shops picked. */
  full: PayrollView | null;
  /** A pay period: shops picked that aren't on it (Dubuque runs on its own calendar). */
  offCalendar: { shopId: string; shop: string }[];
  /** A pay period: how many shops on it aren't shown. Approve and lock waits until every one is. */
  hidden: number;
  /** Locked runs the dates overlap: approve, lock and the files are blocked, with this message. */
  overlap: string | null;
  payPeriods: PayPeriodPickerGroup[];
  presets: { id: string; label: string }[];
}

/**
 * The dates and shops a Payroll Report page shows. Any range can be viewed. A full pay period of a
 * pay group is the usual run; dates from a Sunday to a Saturday that aren't one run for the shops
 * picked; anything else is a review. Links from before the picker (`period=<start>_<end>`) still
 * open that period. Every shop the viewer has is shown unless they pick some.
 */
export async function payrollRange(ctx: StaffContext, sp: PayrollRangeParams, key: string): Promise<PayrollRange> {
  const legacy = PERIOD.exec(sp.period ?? "");
  const p = legacy && !sp.from && !sp.preset ? { from: legacy[1], to: legacy[2] } : sp;
  const locations = await resolveLocations(ctx, { shop: sp.shop ?? "all" });
  const selected = locations.selection.shopIds;
  const presets = await payrollPresetChips(selected);
  const range = await resolveRange(p, { shopIds: selected, defaultPreset: "lastpayperiod", memory: { staffId: ctx.staff.id, key }, wholePayPeriod: true, presets });
  const heading = rangeHeading({ from: range.from, to: range.to, label: range.rangeLabel });
  const [groups, payPeriods] = await Promise.all([officialGroups(range.from, range.to), payPeriodPicker(selected)]);
  const on = groups.filter((g) => selected.includes(g.shopId));
  const base = { range, heading, locations, offCalendar: [], hidden: 0, payPeriods, presets };
  if (on.length) {
    const full = await buildPayroll(range.from, range.to);
    const shown = on.map((g) => g.shopId).filter((id) => ctx.shopIds.includes(id));
    const view = full ? narrowView(full, shown) : null;
    return {
      ...base,
      kind: "pay_period",
      official: true,
      view,
      full,
      offCalendar: selected.filter((id) => !groups.some((g) => g.shopId === id)).map((id) => ({ shopId: id, shop: ctx.shops.find((s) => s.id === id)?.name ?? "" })),
      hidden: full ? full.blocks.length - (view?.blocks.length ?? 0) : 0,
      overlap: full?.lockOverlaps.length ? overlapMessage(full.lockOverlaps) : null,
    };
  }
  if (wholeWorkweeks(range.from, range.to)) {
    const full = await buildPayroll(range.from, range.to, { weeks: { shopIds: selected } });
    if (full) return { ...base, kind: "weeks", official: true, view: full, full, overlap: full.lockOverlaps.length ? overlapMessage(full.lockOverlaps) : null };
  }
  const view = await buildPayroll(range.from, range.to, { review: { shopIds: selected } });
  return { ...base, kind: "review", official: false, view, full: null, overlap: null };
}

/** The link query that reopens the same dates and shops. */
export function payrollRangeQuery(r: Pick<PayrollRange, "range" | "locations">, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(r.range.preset ? { preset: r.range.preset } : { from: r.range.from, to: r.range.to });
  if (r.locations.shopParam) q.set("shop", r.locations.shopParam);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

/** The query a run's iSolved file downloads with: its pay group and dates, and for whole workweeks the shops the run covers. */
export function runFileQuery(view: Pick<PayrollView, "start" | "end" | "scopeShopIds">, payGroupId: string): string {
  const q = new URLSearchParams({ group: payGroupId, start: view.start, end: view.end });
  for (const id of view.scopeShopIds ?? []) q.append("shop", id);
  return q.toString();
}
