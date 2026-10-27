import "server-only";
import { isValidLocalDate } from "@/lib/time";
import { barberLabel } from "@/domain/barbers";
import { LocationGroup, LocationSelection, locationLabel } from "@/domain/locations";
import { PAYROLL_REPORTS, type ReportKey } from "@/domain/permissions";
import { PAY_PERIOD_PRESET, payPeriodRange } from "@/server/payroll/periods";
import { PRESETS, presetRange } from "@/domain/report-range";
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

export { PRESETS, presetRange };

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
  "operations",
  "rebook_rate",
  "checkout_prompts",
  "heatmap",
  "client_ratings",
  "service_times",
  "labor",
  "commission_payout",
  "attendance",
  "google_reviews",
  "campaign_center",
  "lapsed_clients",
  "openings",
  "end_of_day",
  "leaderboard",
  "sales_tax",
  "retention",
  "acquisition",
  "phone_operator",
  "appointments",
  "staffing",
  "call_ins",
  "tip_payouts",
  "gift_cards",
  "cash_drawer",
  ...PAYROLL_REPORTS,
]);

/**
 * Reports with no barber anywhere in them: stock, purchasing, Stripe accounts, loyalty rewards, the
 * Morning Dashboard and the audit log. Every other report takes the barber filter.
 */
export const NO_BARBER_REPORTS: ReadonlySet<ReportKey> = new Set(["inventory", "inventory_movement", "sell_through", "low_stock", "purchasing", "shop_accounts", "rollup", "loyalty", "morning_dashboard", "audit_log"]);

export const defaultView = (report?: ReportKey): ReportView => (report === "sales_by_barber" || report === "service_times" ? "barbers" : "combined");

/** The range a report opens on without one in the URL. */
const DEFAULT_PRESET: Partial<Record<ReportKey, string>> = {
  end_of_day: "lastday",
  analytics: "4w",
  sales_tax: "lastmonth",
  retention: "lastquarter",
  rebook_rate: "lastquarter",
  leaderboard: "month",
  phone_operator: "30d",
  acquisition: "30d",
  ...Object.fromEntries(PAYROLL_REPORTS.map((k) => [k, "pp:last"])),
  payroll_overtime: "pp:current",
};

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
  const [r, names] = await Promise.all([reportBarbers(ctx, report === "my_sales" ? null : p.staff, { selfOnly: self }), staffLabels(ctx.brandWide ? undefined : ctx.shopIds)]);
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
  let preset = custom ? null : (p.preset ?? DEFAULT_PRESET[report] ?? "7d");
  const period = preset?.startsWith(PAY_PERIOD_PRESET) ? ((await payPeriodRange(preset)) ?? (await payPeriodRange("pp:last"))) : null;
  if (period) preset = period.id;
  let { from, to } = custom ? { from: p.from!, to: p.to! } : (period ?? presetRange(preset!));
  if (from > to) [from, to] = [to, from];
  const v = await resolveBarberView(ctx, p, report, await resolveLocations(ctx, p));
  return { shopIds: v.selection.shopIds, from, to, preset, ...v };
}
