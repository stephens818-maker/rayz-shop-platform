import { CATEGORY_LABEL, STATUS_LABEL } from "@/domain/staff-time";
import { Cell, Column, ViewCtx, listTable } from "@/domain/report-views";
import { addDays, diffDays, minutesToLabel } from "@/lib/time";
import type { ReportData } from "./report-data";
import { ReportScope, staffSelection } from "./reports";
import { staffingFor } from "./staff-time";

/** Longest range the staffing report lays out day by day. */
export const STAFFING_MAX_DAYS = 92;

const text = (label: string): Column => ({ label });
const int = (label: string): Column => ({ label, kind: "int" });
const hours = (label: string): Column => ({ label, kind: "hours" });
const byDay = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]));

/** Who's working, off and blocked, per day, shop and barber, with a per-barber summary. */
export async function staffingData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const capped = diffDays(scope.to, scope.from) + 1 > STAFFING_MAX_DAYS;
  const from = capped ? addDays(scope.to, -(STAFFING_MAX_DAYS - 1)) : scope.from;
  const rows = await staffingFor(scope.shopIds, from, scope.to, staffSelection(scope));
  const multi = loc.shops.length > 1;
  const blocksText = (r: (typeof rows)[number]) =>
    r.blocks
      .filter((b) => b.category !== "time_off")
      .map((b) => `${CATEGORY_LABEL[b.category] ?? b.reason} ${minutesToLabel(b.startMin)}–${minutesToLabel(b.endMin % (24 * 60))}`)
      .join(", ");
  const statusText = (r: (typeof rows)[number]) => STATUS_LABEL[r.status] + (r.pending ? " (time off pending)" : "");
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const blockedMin = rows.reduce((a, r) => a + r.blockedMin, 0);
  return {
    stats: [
      { label: "Working", value: String(count((r) => r.status === "working")), hint: "barber days" },
      { label: "Off", value: String(count((r) => r.status === "off")), hint: `${count((r) => r.status === "partly_off")} partly off` },
      { label: "Time off pending", value: String(count((r) => r.pending)), hint: "barber days waiting for a manager" },
      { label: "Blocked", value: `${(blockedMin / 60).toFixed(1)} h`, hint: "lunch, breaks and other blocks in their hours" },
    ],
    tables: [
      listTable(loc, {
        id: "barbers",
        title: "By barber",
        columns: [text("Barber"), int("Days working"), int("Days off"), int("Days partly off"), hours("Scheduled"), hours("Time off"), hours("Blocked"), int("Bookings")],
        rows: rows.map((r) => ({
          shopId: r.shopId,
          staffId: r.staffId,
          key: r.staffId,
          cells: [r.label, r.status === "working" ? 1 : 0, r.status === "off" ? 1 : 0, r.status === "partly_off" ? 1 : 0, r.scheduledMin, r.offMin, r.blockedMin, r.booked],
        })),
        merge: true,
        sort: (a, b) => String(a[0]).localeCompare(String(b[0])),
      }),
      listTable(loc, {
        id: "days",
        title: "Day by day",
        subtitle: capped ? `Showing the last ${STAFFING_MAX_DAYS} days of the range.` : undefined,
        columns: [text("Date"), text("Barber"), text("Status"), hours("Scheduled"), hours("Time off"), hours("Blocked"), text("Blocks"), int("Bookings")],
        rows: rows.map((r) => ({ shopId: r.shopId, staffId: r.staffId, cells: [r.date, r.label, statusText(r), r.scheduledMin, r.offMin, r.blockedMin, blocksText(r), r.booked] })),
        keepShop: multi,
        sort: byDay,
      }),
    ],
    notes: capped ? [`Day-by-day rows cover the last ${STAFFING_MAX_DAYS} days of the range.`] : undefined,
  };
}
