import "server-only";
import { payPeriodFor } from "@/domain/payroll";
import { LocalDate, addDays, isValidLocalDate, todayLocal, weekdayOf } from "@/lib/time";
import { LocationGroup, LocationSelection, locationLabel } from "@/domain/locations";
import type { ReportKey } from "@/domain/permissions";
import { ViewCtx, parseView, totalLabel } from "@/domain/report-views";
import type { StaffContext } from "@/server/auth/staff";
import { reportLocations, visibleGroups } from "@/server/locations";
import type { ReportScope } from "@/server/reports";

/** `shop` is one shop id, several (repeated or comma-separated), "all", or "group:<id>". `view` is "combined" or "shops". */
export type ReportParams = { preset?: string; from?: string; to?: string; shop?: string | string[]; staff?: string; view?: string };

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

export type ResolvedScope = ReportScope & ReportLocations & { preset: string | null };

/**
 * Dates, shops and barber for a report. Shops are always limited to the viewer's access; "My sales"
 * is always the viewer's own tickets, whatever the URL says.
 */
export async function resolveScope(ctx: StaffContext, p: ReportParams, report?: ReportKey): Promise<ResolvedScope> {
  const custom = p.from && p.to && isValidLocalDate(p.from) && isValidLocalDate(p.to);
  const preset = custom ? null : (p.preset ?? "7d");
  let { from, to } = custom ? { from: p.from!, to: p.to! } : presetRange(preset!);
  if (from > to) [from, to] = [to, from];
  const locations = await resolveLocations(ctx, p);
  const staffId = report === "my_sales" ? ctx.staff.id : p.staff || null;
  return { shopIds: locations.selection.shopIds, from, to, staffId, preset, ...locations };
}
