import "server-only";
import { payPeriodFor } from "@/domain/payroll";
import { LocalDate, addDays, isValidLocalDate, todayLocal, weekdayOf } from "@/lib/time";
import { barberLabel } from "@/domain/barbers";
import { LocationGroup, LocationSelection, locationLabel } from "@/domain/locations";
import type { ReportKey } from "@/domain/permissions";
import { ReportView, ViewCtx, parseReportView, parseView, totalLabel } from "@/domain/report-views";
import type { StaffContext } from "@/server/auth/staff";
import { ReportBarbers, reportBarbers, staffLabels } from "@/server/barbers";
import { reportLocations, visibleGroups } from "@/server/locations";
import type { ReportScope } from "@/server/reports";

/**
 * `shop` and `staff` are one id, several (repeated or comma-separated), "all", or "group:<id>".
 * `view` is "combined", "shops", "barbers" or "shops_barbers".
 */
export type ReportParams = { preset?: string; from?: string; to?: string; shop?: string | string[]; staff?: string | string[]; view?: string };

export const PRESETS: { id: string; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "7d", label: "Last 7 days" },
  { id: "month", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "payperiod", label: "This pay period" },
  { id: "lastpayperiod", label: "Last pay period" },
  { id: "30d", label: "Last 30 days" },
  { id: "ytd", label: "Year to date" },
];

export function presetRange(id: string, today: LocalDate = todayLocal()): { from: LocalDate; to: LocalDate } {
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week":
      return { from: addDays(today, -weekdayOf(today)), to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: monthStart, to: today };
    case "lastmonth": {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case "payperiod": {
      const p = payPeriodFor(today);
      return { from: p.start, to: today < p.end ? today : p.end };
    }
    case "lastpayperiod": {
      const p = payPeriodFor(addDays(payPeriodFor(today).start, -1));
      return { from: p.start, to: p.end };
    }
    case "ytd":
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: addDays(today, -6), to: today };
  }
}

export interface ReportLocations {
  selection: LocationSelection;
  /** Saved groups with at least one of the viewer's shops, cut down to those shops. */
  groups: LocationGroup[];
  loc: ViewCtx;
  /** "Quad Cities: Kimberly, Moline…", "All shops", one shop's name. */
  label: string;
  /** The canonical `shop` URL value, or null for the current shop. */
  shopParam: string | null;
}

/**
 * Which shops a report covers and how they're shown. Shops outside the viewer's access are refused;
 * a saved group is cut down to the shops they have. One shop is always shown combined.
 */
export async function resolveLocations(ctx: StaffContext, p: { shop?: string | string[]; view?: string }): Promise<ReportLocations> {
  const { selection, groups } = await reportLocations(ctx, p.shop);
  const names = new Map(ctx.shops.map((s) => [s.id, s.name]));
  const n = selection.shopIds.length;
  const loc: ViewCtx = {
    view: n > 1 ? parseView(p.view) : "combined",
    shops: selection.shopIds.map((id) => ({ id, name: names.get(id) ?? "" })),
    totalLabel: totalLabel(n, ctx.brandWide && n === ctx.shopIds.length),
  };
  return {
    selection,
    groups: visibleGroups(groups, ctx.shopIds).map((g) => ({ ...g, shopIds: g.shopIds.filter((id) => ctx.shopIds.includes(id)) })),
    loc,
    label: locationLabel(selection, ctx.shops, ctx.brandWide),
    shopParam: selection.param,
  };
}

/** Reports that break down by barber: tickets, appointments, tips or ratings each have one. */
export const BARBER_REPORTS: ReadonlySet<ReportKey> = new Set([
  "my_sales",
  "sales_summary",
  "sales_by_barber",
  "services_vs_products",
  "tips_payroll",
  "card_vs_cash",
  "discounts_refunds",
  "kpis",
  "heatmap",
  "client_ratings",
]);

export const defaultView = (report?: ReportKey): ReportView => (report === "sales_by_barber" ? "barbers" : "combined");

/** Without "See every barber's numbers", reports that break down by barber show only the viewer's own. "My sales" always does. */
export const selfOnly = (ctx: Pick<StaffContext, "permissions">, report: ReportKey) => report === "my_sales" || !ctx.permissions.has("reports.all_staff");

export interface ReportBarberScope extends ReportBarbers {
  /** "All barbers", "Floaters: Jamie, Daisey", one name. */
  label: string;
  /** The viewer may pick barbers (they can see everyone's numbers and the report isn't "My sales"). */
  pickable: boolean;
}

export interface ReportViewState {
  barbers: ReportBarberScope | null;
  /** The view asked for in the URL. The shown view (`viewOf(loc)`) drops what doesn't apply: by location with one shop, by barber with one barber. */
  viewParam: ReportView;
  defaultView: ReportView;
  /** The canonical `staff` URL value, or null for all barbers or yourself. */
  staffParam: string | null;
}

/**
 * Adds the barber filter and the view to a set of shops. The view combines location and barber:
 * combined, by location, by barber, or by location and barber. A report without a barber on its
 * rows ignores the barber half.
 */
export async function resolveBarberView(
  ctx: StaffContext,
  p: { staff?: string | string[]; view?: string },
  report: ReportKey,
  l: ReportLocations,
): Promise<ReportLocations & ReportViewState & { staffIds: string[] | null }> {
  const def = defaultView(report);
  const viewParam = parseReportView(p.view) ?? def;
  const n = l.selection.shopIds.length;
  const view = n > 1 && (viewParam === "shops" || viewParam === "shops_barbers") ? "shops" : "combined";
  const brandAll = ctx.brandWide && n === ctx.shopIds.length;
  if (!BARBER_REPORTS.has(report)) return { ...l, loc: { ...l.loc, view }, barbers: null, viewParam, defaultView: def, staffParam: null, staffIds: null };

  const self = selfOnly(ctx, report);
  const [r, names] = await Promise.all([reportBarbers(ctx, p.staff, { selfOnly: self }), staffLabels()]);
  const sel = r.selection;
  const atShops = r.visible.filter((b) => b.active !== false && b.shopIds.some((id) => l.selection.shopIds.includes(id)));
  const barbers = sel.staffIds ? sel.staffIds.map((id) => ({ id, name: names[id] ?? "Unknown" })) : atShops.map((b) => ({ id: b.id, name: b.name }));
  const one = sel.staffIds?.length === 1;
  const loc: ViewCtx = {
    ...l.loc,
    view,
    byBarber: !one && (viewParam === "barbers" || viewParam === "shops_barbers"),
    barbers,
    staffNames: names,
    totalLabel: totalLabel(n, brandAll, sel.staffIds?.length ?? null),
  };
  return {
    ...l,
    loc,
    barbers: { ...r, label: barberLabel(sel, (id) => names[id] ?? "Unknown"), pickable: !self },
    viewParam,
    defaultView: def,
    staffParam: sel.param,
    staffIds: sel.staffIds,
  };
}

export type ResolvedScope = ReportScope & ReportLocations & ReportViewState & { preset: string | null };

/**
 * Dates, shops and barbers for a report. Shops and barbers are always limited to the viewer's
 * access; people who may only see their own numbers, and "My sales", always get their own.
 */
export async function resolveScope(ctx: StaffContext, p: ReportParams, report: ReportKey): Promise<ResolvedScope> {
  const custom = p.from && p.to && isValidLocalDate(p.from) && isValidLocalDate(p.to);
  const preset = custom ? null : (p.preset ?? "7d");
  let { from, to } = custom ? { from: p.from!, to: p.to! } : presetRange(preset!);
  if (from > to) [from, to] = [to, from];
  const v = await resolveBarberView(ctx, p, report, await resolveLocations(ctx, p));
  return { shopIds: v.selection.shopIds, from, to, preset, ...v };
}
