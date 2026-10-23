import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { Cell, Column, ViewCtx, listTable } from "@/domain/report-views";
import type { Permission } from "@/domain/permissions";
import { formatCents } from "@/lib/money";
import type { ReportData } from "./report-data";
import { ReportScope, staffSelection } from "./reports";
import { attendanceRows, laborRows } from "./time-clock";

const text = (label: string): Column => ({ label });
const int = (label: string): Column => ({ label, kind: "int" });
const hours = (label: string): Column => ({ label, kind: "hours" });
const money = (label: string): Column => ({ label, kind: "money" });
const ratioMoney = (label: string): Column => ({ label, kind: "money", sum: false });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });
const byName = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0]));

async function labels(ids: string[]) {
  return new Map((ids.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)) : []).map((s) => [s.id, s.label]));
}

/**
 * Labor hours per shop and barber, sales per labor hour, and with "See pay rates" the labor cost
 * (hourly rate × hours, overtime at the multiplier) and labor as a share of sales. Without it the
 * rate and cost columns aren't there at all, on screen or in the CSV.
 */
export async function laborData(scope: ReportScope, loc: ViewCtx, perms: ReadonlySet<Permission> | undefined): Promise<ReportData> {
  const rates = !!perms?.has("payroll.rates");
  const rows = await laborRows(scope.shopIds, scope.from, scope.to, staffSelection(scope));
  const name = await labels([...new Set(rows.map((r) => r.staffId))]);
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));
  const sales = (r: (typeof rows)[number]) => r.serviceCents + r.productCents;
  const cost = (r: (typeof rows)[number]) => r.regularCost + r.otCost;
  const perHour = (salesCents: number, min: number) => (min > 0 ? Math.round(salesCents / (min / 60)) : null);
  const share = (costCents: number, salesCents: number) => (salesCents > 0 ? costCents / salesCents : null);

  const columns = [text("Barber"), hours("Labor hours"), hours("OT hours"), money("Service sales"), money("Product sales"), ratioMoney("Sales per labor hour")];
  if (rates) columns.push(ratioMoney("Hourly rate"), money("Labor cost"), pct("Labor % of sales"));
  const derive = (c: Cell[]) => {
    const out = [...c];
    const min = Number(c[1] ?? 0);
    const s = Number(c[3] ?? 0) + Number(c[4] ?? 0);
    out[5] = perHour(s, min);
    if (rates) out[8] = share(Number(c[7] ?? 0), s);
    return out;
  };
  const cells = (label: string, r: Pick<(typeof rows)[number], "workedMin" | "otMin" | "serviceCents" | "productCents" | "regularCost" | "otCost" | "rate">): Cell[] => {
    const base: Cell[] = [label, r.workedMin, r.otMin, r.serviceCents, r.productCents, perHour(r.serviceCents + r.productCents, r.workedMin)];
    if (rates) base.push(r.rate === null ? null : Math.round(r.rate * 100), r.regularCost + r.otCost, share(r.regularCost + r.otCost, r.serviceCents + r.productCents));
    return base;
  };
  const totalMin = rows.reduce((a, r) => a + r.workedMin, 0);
  const totalSales = rows.reduce((a, r) => a + sales(r), 0);
  const totalCost = rows.reduce((a, r) => a + cost(r), 0);
  const noRate = rows.filter((r) => r.workedMin > 0 && !r.rate).length;
  return {
    stats: [
      { label: "Labor hours", value: (totalMin / 60).toFixed(1), hint: `${(rows.reduce((a, r) => a + r.otMin, 0) / 60).toFixed(1)} h overtime` },
      { label: "Sales per labor hour", value: totalMin ? formatCents(Math.round(totalSales / (totalMin / 60))) : "—", hint: "service and product sales ÷ clocked hours" },
      ...(rates
        ? [
            { label: "Labor cost", value: formatCents(totalCost), hint: "hourly rate × hours, OT at the multiplier" },
            { label: "Labor % of sales", value: totalSales ? `${((totalCost / totalSales) * 100).toFixed(1)}%` : "—", hint: noRate ? `${noRate} with hours but no rate count $0` : undefined },
          ]
        : []),
    ],
    tables: [
      listTable(loc, {
        id: "barbers",
        title: "By barber",
        columns,
        rows: rows.map((r) => ({ shopId: r.shopId, staffId: r.staffId, key: r.staffId, cells: cells(name.get(r.staffId) ?? "Unknown", r) })),
        merge: true,
        derive,
        sort: byName,
      }),
      listTable(loc, {
        id: "shops",
        title: "By shop",
        columns: [text("Shop"), ...columns.slice(1)],
        rows: [...new Set(rows.map((r) => r.shopId))].map((shopId) => {
          const mine = rows.filter((r) => r.shopId === shopId);
          const sum = (f: (r: (typeof rows)[number]) => number) => mine.reduce((a, r) => a + f(r), 0);
          const c = cells(shopName.get(shopId) ?? "", {
            workedMin: sum((r) => r.workedMin),
            otMin: sum((r) => r.otMin),
            serviceCents: sum((r) => r.serviceCents),
            productCents: sum((r) => r.productCents),
            regularCost: sum((r) => r.regularCost),
            otCost: sum((r) => r.otCost),
            rate: null,
          });
          return { shopId, key: shopId, cells: c };
        }),
        derive,
        sort: byName,
      }),
    ],
    notes: [
      "Hours are clocked worked time (unpaid breaks out) plus any hours added on the Hours page. A workweek's overtime counts in the range when the week starts in it.",
      ...(rates ? [] : ["Pay rates and labor cost show only with the \"See pay rates and labor cost\" permission."]),
    ],
  };
}

/** Late clock-ins, early clock-outs, missed punches, forgotten clock-outs and scheduled days with no punch. */
export async function attendanceData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const rows = await attendanceRows(scope.shopIds, scope.from, scope.to, staffSelection(scope));
  const name = await labels([...new Set(rows.map((r) => r.staffId))]);
  const multi = loc.shops.length > 1;
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    stats: [
      { label: "Late clock-ins", value: String(sum((r) => r.late)), hint: `${sum((r) => r.lateMin)} minutes in all` },
      { label: "Left early", value: String(sum((r) => r.earlyOut)), hint: `${sum((r) => r.earlyOutMin)} minutes in all` },
      { label: "Missed punches", value: String(sum((r) => r.missed)), hint: `${sum((r) => r.forgotOut)} forgotten clock-outs` },
      { label: "Scheduled, no punch", value: String(sum((r) => r.scheduledNoShow)), hint: "scheduled days with no clock-in and no time off" },
    ],
    tables: [
      listTable(loc, {
        id: "barbers",
        title: "By barber",
        columns: [text("Barber"), int("Shifts"), int("Late"), int("Minutes late"), int("Left early"), int("Minutes early"), int("Early in"), int("Missed punches"), int("Forgot to clock out"), int("Scheduled, no punch")],
        rows: rows.map((r) => ({
          shopId: r.shopId,
          staffId: r.staffId,
          key: r.staffId,
          cells: [name.get(r.staffId) ?? "Unknown", r.shifts, r.late, r.lateMin, r.earlyOut, r.earlyOutMin, r.earlyIn, r.missed, r.forgotOut, r.scheduledNoShow],
        })),
        merge: true,
        sort: byName,
      }),
      listTable(loc, {
        id: "days",
        title: "Day by day",
        subtitle: "Only days with something to look at.",
        columns: [text("Date"), text("Barber"), int("Late"), int("Minutes late"), int("Left early"), int("Minutes early"), int("Missed punches"), int("Forgot to clock out"), int("Scheduled, no punch")],
        rows: rows
          .filter((r) => r.late || r.earlyOut || r.missed || r.forgotOut || r.scheduledNoShow)
          .map((r) => ({ shopId: r.shopId, staffId: r.staffId, cells: [r.date, name.get(r.staffId) ?? "Unknown", r.late, r.lateMin, r.earlyOut, r.earlyOutMin, r.missed, r.forgotOut, r.scheduledNoShow] })),
        keepShop: multi,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[1]).localeCompare(String(b[1])),
      }),
    ],
    notes: ["Late and early are against the barber's schedule at that shop, outside the grace minutes set under Time clock setup."],
  };
}
