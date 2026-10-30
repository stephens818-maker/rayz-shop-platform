import "server-only";
import { barberLabel } from "@/domain/barbers";
import { LocationGroup, LocationSelection, locationLabel } from "@/domain/locations";
import { PAYROLL_REPORTS, type ReportKey } from "@/domain/permissions";
import { PAY_PERIOD_PRESET, calendarForShops, payGroupPeriod, payPeriodByNumber, payPeriodRange } from "@/server/payroll/periods";
import { PAY_GROUP_PERIOD_PRESET, PAY_PERIOD_NUMBER_PRESET, PRESETS, presetRange } from "@/domain/report-range";
import { payPeriodFor } from "@/domain/payroll";
import { type LocalDate, addDays, isValidLocalDate, todayLocal } from "@/lib/time";
import { lastRange, rememberRange } from "@/server/report-range-memory";
import { ReportView, ViewCtx, parseReportView, parseView, totalLabel } from "@/domain/report-views";
import type { StaffContext } from "@/server/auth/staff";
import { ReportBarbers, reportBarbers, staffLabels } from "@/server/barbers";
import { reportLocations, visibleGroups } from "@/server/locations";
import type { ReportScope } from "@/server/reports";
import { brandCalendar } from "@/server/payroll/groups";

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
  "pph",
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
  pph: "lastpayperiod",
  ...Object.fromEntries(PAYROLL_REPORTS.map((k) => [k, "lastpayperiod"])),
  payroll_overtime: "payperiod",
  payroll_w2_codes: "ytd",
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

export interface ResolvedRange {
  from: LocalDate;
  to: LocalDate;
  /** The preset picked, or null for custom dates. */
  preset: string | null;
  /** "Last pay period", "Pay period 22 (Dubuque)", "Month to date"; null for custom dates. */
  rangeLabel: string | null;
  /** The pay group a specific pay period was picked on. */
  payGroupId: string | null;
}

export interface RangeOptions {
  /** The shops the range is for: "This pay period" and "Last pay period" follow their pay calendar. */
  shopIds: readonly string[];
  defaultPreset: string;
  /** Remembers the person's last range under this key, and opens on it when the link has none. */
  memory?: { staffId: string; key: string } | null;
  /** "This pay period" runs to the period's last day, not today (the Payroll Report reviews whole periods). */
  wholePayPeriod?: boolean;
  /** A report's own presets, for their labels. */
  presets?: readonly { id: string; label: string }[];
  today?: LocalDate;
}

/**
 * The dates a report covers: custom from/to (calendar days in America/Chicago), a preset, a pay
 * period chip or a specific pay period by number. Without dates in the link it opens on the range
 * the person last picked there, then on the report's default.
 */
export async function resolveRange(p: Pick<ReportParams, "preset" | "from" | "to">, o: RangeOptions): Promise<ResolvedRange> {
  const today = o.today ?? todayLocal();
  const isCustom = (x: Pick<ReportParams, "from" | "to">) => !!(x.from && x.to && isValidLocalDate(x.from) && isValidLocalDate(x.to));
  const explicit = isCustom(p) || !!p.preset;
  const remembered = !explicit && o.memory ? await lastRange(o.memory.staffId, o.memory.key) : null;
  const q: Pick<ReportParams, "preset" | "from" | "to"> = explicit ? p : remembered ? remembered : {};
  const out = await rangeOf(q, o, today, isCustom(q));
  const relative = p.preset === "pp:last" || p.preset === "pp:current";
  if (explicit && o.memory) await rememberRange(o.memory.staffId, o.memory.key, out.preset ? { preset: relative && !isCustom(p) ? p.preset! : out.preset } : { from: out.from, to: out.to });
  return out;
}

async function rangeOf(q: Pick<ReportParams, "preset" | "from" | "to">, o: RangeOptions, today: LocalDate, custom: boolean): Promise<ResolvedRange> {
  if (custom) {
    const [from, to] = q.from! <= q.to! ? [q.from!, q.to!] : [q.to!, q.from!];
    return { from, to, preset: null, rangeLabel: null, payGroupId: null };
  }
  const preset = q.preset ?? o.defaultPreset;
  if (preset.startsWith(PAY_PERIOD_NUMBER_PRESET)) {
    const n = await payPeriodByNumber(preset);
    if (n) return { from: n.from, to: n.to, preset: n.id, rangeLabel: n.label, payGroupId: n.payGroupId };
    return rangeOf({}, { ...o, defaultPreset: o.defaultPreset.startsWith(PAY_PERIOD_NUMBER_PRESET) ? "lastpayperiod" : o.defaultPreset }, today, false);
  }
  if (preset.startsWith(PAY_GROUP_PERIOD_PRESET)) {
    const g = await payGroupPeriod(preset, today);
    if (g) return { from: g.from, to: g.to, preset: g.id, rangeLabel: g.label, payGroupId: g.payGroupId };
    return rangeOf({}, { ...o, defaultPreset: o.defaultPreset.startsWith(PAY_GROUP_PERIOD_PRESET) ? "lastpayperiod" : o.defaultPreset }, today, false);
  }
  if (preset.startsWith(PAY_PERIOD_PRESET)) {
    const period = (await payPeriodRange(preset, today)) ?? (await payPeriodRange("pp:last", today))!;
    const label = preset === "pp:current" ? "This pay period" : preset === "pp:last" ? "Last pay period" : (o.presets?.find((x) => x.id === period.id)?.label ?? "Pay period");
    return { from: period.from, to: period.to, preset: period.id, rangeLabel: label, payGroupId: null };
  }
  const known = o.presets?.find((x) => x.id === preset && PRESETS.some((p) => p.id === x.id)) ?? PRESETS.find((x) => x.id === preset) ?? o.presets?.find((x) => x.id === preset);
  const id = known ? preset : "7d";
  const cal = id === "payperiod" || id === "lastpayperiod" ? await calendarForShops(o.shopIds) : await brandCalendar();
  const r = presetRange(id, today, cal);
  const to = !o.wholePayPeriod ? r.to : id === "payperiod" ? payPeriodFor(today, cal).end : id === "week" ? addDays(r.from, 6) : r.to;
  return { from: r.from, to, preset: id, rangeLabel: (known ?? PRESETS.find((x) => x.id === "7d"))!.label, payGroupId: null };
}

export type ResolvedScope = ReportScope & ReportLocations & ReportViewState & Omit<ResolvedRange, "from" | "to">;

/**
 * Dates, shops and barbers for a report. Shops and barbers are always limited to the viewer's
 * access; people who may only see their own numbers, and "My sales", always get their own. With
 * `remember` (a report page, not an export or the assistant), the range is kept as the person's
 * last one on this report, and a link without dates opens on it.
 */
export async function resolveScope(ctx: StaffContext, p: ReportParams, report: ReportKey, o: { remember?: boolean; presets?: readonly { id: string; label: string }[] } = {}): Promise<ResolvedScope> {
  const v = await resolveBarberView(ctx, p, report, await resolveLocations(ctx, p));
  const r = await resolveRange(p, {
    shopIds: v.selection.shopIds,
    defaultPreset: DEFAULT_PRESET[report] ?? "7d",
    memory: o.remember ? { staffId: ctx.staff.id, key: report } : null,
    presets: o.presets,
  });
  return { shopIds: v.selection.shopIds, ...r, ...v };
}
