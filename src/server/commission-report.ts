import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, staffShops } from "@/db/schema";
import { boothRentForDays, commissionBetween, monthStart, monthsBetween, versionOn, zeroTotals, type CommissionTotals, type CompVersion } from "@/domain/compensation";
import { Cell, Column, ViewCtx, listTable } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, type LocalDate } from "@/lib/time";
import { commissionLines, loadCompensationSettings, setupRates, versionsFor } from "./compensation";
import type { ReportData } from "./report-data";
import { ReportScope, staffSelection } from "./reports";

const text = (label: string): Column => ({ label });
const money = (label: string): Column => ({ label, kind: "money" });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });
const byName = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0]));
const byMonth = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]));

/** Booth rent due over [from, to], day by day from the version in effect each day. */
export function boothRentBetween(sorted: readonly CompVersion[], from: LocalDate, to: LocalDate): number {
  let cents = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = versionOn(sorted, d);
    if (v?.boothRentCents != null && v.boothRentFrequency) cents += boothRentForDays({ cents: v.boothRentCents, frequency: v.boothRentFrequency }, 1);
  }
  return Math.round(cents);
}

const COLUMNS = [
  money("Service gross"),
  money("Service discounts"),
  money("Service refunds"),
  money("Net service"),
  money("Service commission"),
  pct("Service rate"),
  money("Product gross"),
  money("Product discounts"),
  money("Product refunds"),
  money("Net product"),
  money("Product commission"),
  money("Total commission"),
  money("Booth rent due"),
  money("Commission less rent"),
];

/** Cells from the first money column on; the label columns come before. */
function figures(t: CommissionTotals, rentCents: number): Cell[] {
  const svc = Math.round(t.serviceCommissionCents);
  const prod = Math.round(t.productCommissionCents);
  return [
    t.serviceGrossCents,
    t.serviceDiscountCents,
    t.serviceRefundCents,
    t.serviceNetCents,
    svc,
    t.serviceNetCents ? svc / t.serviceNetCents : null,
    t.productGrossCents,
    t.productDiscountCents,
    t.productRefundCents,
    t.productNetCents,
    prod,
    svc + prod,
    rentCents,
    svc + prod - rentCents,
  ];
}

/** Rates, totals and the rent-less figure from the added-up cells. `at` is where the money columns start. */
const derive = (at: number) => (c: Cell[]) => {
  const out = [...c];
  const n = (i: number) => Number(c[at + i] ?? 0);
  out[at + 5] = n(3) ? n(4) / n(3) : null;
  out[at + 11] = n(4) + n(10);
  out[at + 13] = n(4) + n(10) - n(12);
  return out;
};

/**
 * Commission per barber and location for the range, from each barber's pay plan (Payroll setup's
 * rates where they have none, or where it leaves one blank), on the sales payroll counts: net of
 * discounts, less refunds given in the range. By month too, since tiers run on monthly sales. Booth
 * rent due is the plan's rent for the days in the range, on the barber's first shop. Nothing shows
 * while compensation fields are off.
 */
export async function commissionPayoutData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const comp = await loadCompensationSettings();
  if (!comp.enabled) return { stats: [], tables: [], notes: ["Compensation fields are off. The brand turns them on under Payroll → Compensation."] };
  const sel = staffSelection(scope);
  const lines = await commissionLines(sel, monthStart(scope.from), scope.to);
  const versions = await versionsFor(sel ?? [...lines.keys()]);
  const people = [...new Set([...lines.keys(), ...[...versions.entries()].filter(([, v]) => v.some((x) => x.boothRentCents !== null)).map(([id]) => id)])].filter((id) => !sel || sel.includes(id));
  const [names, homes, fbOf] = people.length
    ? await Promise.all([
        db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, people)),
        db.select({ staffId: staffShops.staffId, shopId: staffShops.shopId }).from(staffShops).innerJoin(shops, eq(shops.id, staffShops.shopId)).where(inArray(staffShops.staffId, people)).orderBy(asc(shops.name)),
        setupRates(people),
      ])
    : [[], [], await setupRates([])];
  const name = new Map(names.map((n) => [n.id, n.label]));
  const inScope = new Set(scope.shopIds);

  type Row = { shopId: string; staffId: string; key: string; cells: Cell[] };
  const barberRows: Row[] = [];
  const monthRows: Row[] = [];
  let svcTotal = 0;
  let prodTotal = 0;
  let rentTotal = 0;
  for (const staffId of people) {
    const vs = versions.get(staffId) ?? [];
    const fb = fbOf(staffId);
    const mine = lines.get(staffId) ?? [];
    const label = name.get(staffId) ?? "Unknown";
    const rentShop = homes.find((h) => h.staffId === staffId && inScope.has(h.shopId))?.shopId;
    const rent = rentShop ? boothRentBetween(vs, scope.from, scope.to) : 0;
    const byShop = commissionBetween(mine, vs, fb, scope.from, scope.to);
    if (rent && rentShop && !byShop.has(rentShop)) byShop.set(rentShop, zeroTotals());
    for (const [shopId, t] of byShop) {
      if (!inScope.has(shopId)) continue;
      const r = shopId === rentShop ? rent : 0;
      const cells = figures(t, r);
      svcTotal += Number(cells[4]);
      prodTotal += Number(cells[10]);
      rentTotal += r;
      barberRows.push({ shopId, staffId, key: staffId, cells: [label, ...cells] });
    }
    for (const m of monthsBetween(scope.from, scope.to)) {
      const month = commissionBetween(mine, vs, fb, m.start, m.end);
      const monthRent = rentShop ? boothRentBetween(vs, m.start, m.end) : 0;
      if (monthRent && rentShop && !month.has(rentShop)) month.set(rentShop, zeroTotals());
      for (const [shopId, t] of month) {
        if (!inScope.has(shopId)) continue;
        monthRows.push({ shopId, staffId, key: `${m.start.slice(0, 7)}|${staffId}`, cells: [formatDate(m.start, "yyyy-MM (MMM)"), label, ...figures(t, shopId === rentShop ? monthRent : 0)] });
      }
    }
  }

  return {
    stats: [
      { label: "Service commission", value: formatCents(svcTotal), hint: "net service sales × each barber's rates" },
      { label: "Product commission", value: formatCents(prodTotal) },
      { label: "Total commission", value: formatCents(svcTotal + prodTotal) },
      ...(rentTotal ? [{ label: "Booth rent due", value: formatCents(rentTotal), hint: "for the days in the range" }] : []),
    ],
    tables: [
      listTable(loc, { id: "barbers", title: "By barber", columns: [text("Barber"), ...COLUMNS], rows: barberRows, merge: true, derive: derive(1), sort: byName }),
      listTable(loc, { id: "months", title: "By month", columns: [text("Month"), text("Barber"), ...COLUMNS], rows: monthRows, merge: true, derive: derive(2), sort: byMonth }),
    ],
    notes: [
      "Rates come from each barber's compensation plan in effect on the day of the sale; whatever a plan leaves blank (and anyone without a plan) uses Payroll setup's rates.",
      "Tiers run on the month's net service sales to date, at every shop. A month split across ranges adds up: each part gets what the month to date earned at its end less what it had earned by its start.",
      "Sales count on the day they were paid, net of discounts; refunds on the day they were given, at the rate the sale earned. Squire imports and tickets with no barber are left out, as in payroll.",
    ],
  };
}
