import type { ReasonViewer } from "@/domain/block-reasons";
import { STATUS_LABEL } from "@/domain/staff-time";
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

/**
 * Who's working, off and blocked, per day, shop and barber, with a per-barber summary and the time
 * by reason. Private reasons are "Blocked" or "Time off" unless `reasons` may see them.
 */
export async function staffingData(scope: ReportScope, loc: ViewCtx, reasons: ReasonViewer): Promise<ReportData> {
  const capped = diffDays(scope.to, scope.from) + 1 > STAFFING_MAX_DAYS;
  const from = capped ? addDays(scope.to, -(STAFFING_MAX_DAYS - 1)) : scope.from;
  const rows = await staffingFor(scope.shopIds, from, scope.to, reasons, staffSelection(scope));
  const multi = loc.shops.length > 1;
  type Row = (typeof rows)[number];
  const span = (b: Row["blocks"][number]) => `${minutesToLabel(b.startMin)}–${minutesToLabel(b.endMin % (24 * 60))}`;
  const named = (b: Row["blocks"][number]) => (b.note ? `${b.label} (${b.note})` : b.label);
  const blocksText = (r: Row) =>
    r.blocks
      .filter((b) => b.category !== "time_off")
      .map((b) => `${named(b)} ${span(b)}`)
      .join(", ");
  const offText = (r: Row) =>
    r.blocks
      .filter((b) => b.category === "time_off")
      .map((b) => (b.startMin === 0 && b.endMin >= 24 * 60 ? named(b) : `${named(b)} ${span(b)}`))
      .join(", ");
  const byReason = rows.flatMap((r) =>
    r.blocks.map((b) => {
      const kind = b.category === "time_off" ? "Time off" : "Block";
      const wholeDay = b.startMin === 0 && b.endMin >= 24 * 60;
      const minutes = wholeDay ? r.offMin * Number(r.scheduledMin > 0) : b.endMin - b.startMin;
      return { shopId: r.shopId, staffId: r.staffId, key: `${kind}|${b.label}`, cells: [b.label, kind, 1, minutes] as Cell[] };
    }),
  );
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
        columns: [text("Date"), text("Barber"), text("Status"), hours("Scheduled"), hours("Time off"), hours("Blocked"), text("Time off for"), text("Blocks"), int("Bookings")],
        rows: rows.map((r) => ({ shopId: r.shopId, staffId: r.staffId, cells: [r.date, r.label, statusText(r), r.scheduledMin, r.offMin, r.blockedMin, offText(r), blocksText(r), r.booked] })),
        keepShop: multi,
        sort: byDay,
      }),
      listTable(loc, {
        id: "reasons",
        title: "By reason",
        subtitle: "Each block and time off entry per barber and day. A whole day off counts the hours they were scheduled.",
        columns: [text("Reason"), text("Kind"), int("Entries"), hours("Hours")],
        rows: byReason,
        merge: true,
        sort: (a, b) => String(a[1]).localeCompare(String(b[1])) || Number(b[3]) - Number(a[3]),
      }),
    ],
    notes: capped ? [`Day-by-day rows cover the last ${STAFFING_MAX_DAYS} days of the range.`] : undefined,
  };
}
