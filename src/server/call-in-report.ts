import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { appointmentOutreach, callIns, staff, staffShops } from "@/db/schema";
import type { ReasonViewer } from "@/domain/block-reasons";
import { CALL_IN_KIND_LABEL, OPTION_LABEL, OutreachOption, OutreachStatus } from "@/domain/outreach";
import { Cell, Column, ListRow, ViewCtx, listTable } from "@/domain/report-views";
import { endOfLocalDay, startOfLocalDay } from "@/lib/time";
import { reasonShower } from "./block-reasons";
import type { ReportData } from "./report-data";
import { ReportScope, staffSelection } from "./reports";
import { rangeLabel } from "./staff-time";

const text = (label: string): Column => ({ label });
const int = (label: string): Column => ({ label, kind: "int" });

/** What each status counts as in the report. "Rebooked" covers clients who kept the new barber too. */
const BUCKET: Record<OutreachStatus, "rebooked" | "declined" | "no_response" | "open" | "closed"> = {
  pending: "open",
  notified: "open",
  delivered: "open",
  unreachable: "no_response",
  no_response: "no_response",
  rebooked: "rebooked",
  declined: "declined",
  cancelled: "closed",
};

/**
 * Call-ins in the range by shop and barber, and how outreach went for the appointments they hit.
 * A call-in for all of a barber's shops counts at their first shop in the selection; its appointments
 * count where they were booked. Private reasons show as "Time off" unless the viewer may see them.
 */
export async function callInReportData(scope: ReportScope, loc: ViewCtx, reasons: ReasonViewer): Promise<ReportData> {
  const from = startOfLocalDay(scope.from);
  const to = endOfLocalDay(scope.to);
  const sel = staffSelection(scope);
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const works = await db
    .select({ staffId: staffShops.staffId, shopId: staffShops.shopId, primary: staffShops.isPrimary })
    .from(staffShops)
    .where(inArray(staffShops.shopId, scope.shopIds));
  const staffIds = [...new Set(works.map((w) => w.staffId))].filter((id) => !sel || sel.includes(id));
  const rows = staffIds.length
    ? await db
        .select({ c: callIns, label: staff.displayLabel })
        .from(callIns)
        .innerJoin(staff, eq(staff.id, callIns.staffId))
        .where(
          and(
            inArray(callIns.staffId, staffIds),
            isNull(callIns.cancelledAt),
            lte(callIns.startsAt, to),
            gte(callIns.endsAt, from),
            or(isNull(callIns.shopId), inArray(callIns.shopId, scope.shopIds)),
          ),
        )
    : [];
  const ids = rows.map((r) => r.c.id);
  const outreach = ids.length
    ? await db
        .select()
        .from(appointmentOutreach)
        .where(and(inArray(appointmentOutreach.callInId, ids), inArray(appointmentOutreach.shopId, scope.shopIds)))
    : [];
  const show = await reasonShower(reasons);
  const order = new Map(scope.shopIds.map((id, i) => [id, i]));
  const homeShop = (c: (typeof rows)[number]["c"]) =>
    c.shopId ??
    works
      .filter((w) => w.staffId === c.staffId)
      .sort((a, b) => Number(b.primary) - Number(a.primary) || (order.get(a.shopId) ?? 0) - (order.get(b.shopId) ?? 0))[0]?.shopId ??
    scope.shopIds[0];
  const tally = (os: typeof outreach) => {
    const n = { rebooked: 0, declined: 0, no_response: 0, open: 0, closed: 0, flagged: 0, moved: 0 };
    for (const o of os) {
      n[BUCKET[o.status]]++;
      if (o.flaggedAt && BUCKET[o.status] !== "rebooked" && BUCKET[o.status] !== "declined") n.flagged++;
      if (o.reassignedStaffId) n.moved++;
    }
    return n;
  };
  const label = new Map(rows.map((r) => [r.c.staffId, r.label]));

  const barberRows: ListRow[] = [
    ...rows.map((r) => ({ shopId: homeShop(r.c), staffId: r.c.staffId, key: r.c.staffId, cells: [r.label, 1, 0, 0, 0, 0, 0, 0, 0] as Cell[] })),
    ...outreach.map((o) => {
      const t = tally([o]);
      return { shopId: o.shopId, staffId: o.originalStaffId, key: o.originalStaffId, cells: [label.get(o.originalStaffId) ?? "", 0, 1, t.moved, t.rebooked, t.declined, t.no_response, t.open, t.flagged] as Cell[] };
    }),
  ];
  const optionRows: ListRow[] = outreach
    .filter((o) => o.option)
    .map((o) => {
      const t = tally([o]);
      return { shopId: o.shopId, staffId: o.originalStaffId, key: o.option!, cells: [OPTION_LABEL[o.option as OutreachOption], 1, t.rebooked, t.declined, t.no_response, t.open] as Cell[] };
    });
  const logRows: ListRow[] = rows.map((r) => {
    const mine = outreach.filter((o) => o.callInId === r.c.id);
    const t = tally(mine);
    const reason = show({ staffId: r.c.staffId, reasonId: r.c.reasonId, reason: r.c.reason, note: r.c.note }, true);
    const kind = reason.hidden ? "Time off" : CALL_IN_KIND_LABEL[r.c.kind];
    return {
      shopId: homeShop(r.c),
      staffId: r.c.staffId,
      cells: [r.c.fromDate, r.label, kind, reason.label, rangeLabel(r.c), mine.length, t.rebooked, t.declined, t.no_response, t.open, t.flagged] as Cell[],
    };
  });
  const all = tally(outreach);
  const reached = outreach.filter((o) => o.attempts > 0).length;
  return {
    stats: [
      { label: "Call-ins", value: String(rows.length), hint: `${new Set(rows.map((r) => r.c.staffId)).size} barbers` },
      { label: "Appointments hit", value: String(outreach.length), hint: `${reached} contacted` },
      { label: "Kept or rebooked", value: String(all.rebooked), hint: outreach.length ? `${Math.round((all.rebooked / outreach.length) * 100)}% of appointments hit` : undefined },
      { label: "Needs staff", value: String(all.flagged), hint: `${all.no_response} with no response` },
    ],
    tables: [
      listTable(loc, {
        id: "barbers",
        title: "By barber",
        subtitle: "Rebooked counts clients who kept the barber they were moved to, and those who picked a new time.",
        columns: [text("Barber"), int("Call-ins"), int("Appointments hit"), int("Moved to another barber"), int("Rebooked"), int("Declined"), int("No response"), int("Still open"), int("Flagged")],
        rows: barberRows,
        merge: true,
        sort: (a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])),
      }),
      listTable(loc, {
        id: "options",
        title: "By outreach option",
        columns: [text("Option"), int("Appointments"), int("Rebooked"), int("Declined"), int("No response"), int("Still open")],
        rows: optionRows,
        merge: true,
      }),
      listTable(loc, {
        id: "call_ins",
        title: "Call-ins",
        columns: [
          text("Date"),
          text("Barber"),
          text("Kind"),
          text("Reason"),
          text("Time"),
          int("Appointments hit"),
          int("Rebooked"),
          int("Declined"),
          int("No response"),
          int("Still open"),
          int("Flagged"),
        ],
        rows: logRows,
        keepShop: loc.shops.length > 1,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[1]).localeCompare(String(b[1])),
      }),
    ],
  };
}
