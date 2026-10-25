import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, staffShops } from "@/db/schema";
import { boothRentForDays, commissionBetween, monthStart, monthsBetween, versionOn, zeroTotals, type CommissionTotals, type CompVersion } from "@/domain/compensation";
import { Cell, Column, ViewCtx, listTable, segKey } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, type LocalDate } from "@/lib/time";
import { commissionLines, loadCompensationSettings, setupRates, versionsFor } from "./compensation";
import type { ReportData } from "./report-data";
import { ReportScope, ZERO_SALES, ZERO_TENDER, salesTotalsAt, staffSelection, tenderAt } from "./reports";
import { PAID, ids, rows, staffFilter } from "./report-sql";
import { laborRows } from "./time-clock-export";

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

const hours = (label: string): Column => ({ label, kind: "hours" });

/** Squire's Commission Payout layout. Due to the shop is what came in less what's due to barbers. */
const PAYOUT_COLUMNS = [
  hours("Hours worked"),
  money("Card"),
  money("Cash"),
  money("GC used"),
  money("GC bought"),
  money("Total"),
  money("Commissionable sales"),
  pct("Commission %"),
  money("Barber commission"),
  money("Tips: online booking"),
  money("Tips: POS"),
  money("Tips: gift card"),
  money("Due to barber"),
  money("Tax"),
  money("Due to shop"),
];

/**
 * Tips on each barber's tickets by where they came from: paid with a gift card, chosen while
 * booking online (up to the booking tip on the appointment), or added at the register.
 */
async function tipSources(scope: ReportScope) {
  const r = await rows<{ shop_id: string; staff_id: string | null; gc: number; online: number }>(sql`
    select s.shop_id, s.staff_id,
      coalesce(sum(g.gc), 0)::int gc,
      coalesce(sum(least(greatest(s.tip_cents - coalesce(g.gc, 0), 0), coalesce(a.booking_tip_cents, 0))), 0)::int online
    from sales s
    left join appointments a on a.id = s.appointment_id
    left join lateral (select sum(p.tip_cents)::int gc from payments p where p.sale_id = s.id and p.method = 'gift_card' and p.status <> 'voided') g on true
    where s.shop_id in ${ids(scope)} and s.business_date between ${scope.from} and ${scope.to} and s.status in ${PAID} and s.is_imported = false
    ${staffFilter(sql`s.staff_id`, scope)}
    group by 1, 2`);
  return new Map(r.filter((x) => x.staff_id).map((x) => [`${x.shop_id}|${x.staff_id}`, { gc: x.gc, online: x.online }]));
}

/** Per barber at each shop, everything the payout table needs besides commission. */
async function payoutInputs(scope: ReportScope) {
  const g = [{ byShop: true, byStaff: true }];
  const [labor, tender, totals, tips] = await Promise.all([laborRows(scope.shopIds, scope.from, scope.to, staffSelection(scope)), tenderAt(scope, g), salesTotalsAt(scope, g), tipSources(scope)]);
  return (shopId: string, staffId: string) => {
    const k = segKey(shopId, staffId);
    const t = tender[k] ?? ZERO_TENDER();
    const x = totals[k] ?? ZERO_SALES();
    const src = tips.get(`${shopId}|${staffId}`) ?? { gc: 0, online: 0 };
    return {
      workedMin: labor.find((l) => l.staffId === staffId && l.shopId === shopId)?.workedMin ?? 0,
      card: t.cardCents,
      cash: t.cashCents,
      gcUsed: t.giftCardCents,
      gcBought: x.giftCardsSoldCents,
      tax: x.taxCents,
      tipsGc: src.gc,
      tipsOnline: Math.min(src.online, Math.max(0, x.tipsCents - src.gc)),
      tipsTotal: x.tipsCents,
    };
  };
}

type PayoutInputs = ReturnType<Awaited<ReturnType<typeof payoutInputs>>>;

export function payoutCells(p: PayoutInputs, t: CommissionTotals, rentCents: number): Cell[] {
  const commission = Math.round(t.serviceCommissionCents) + Math.round(t.productCommissionCents);
  const base = t.serviceNetCents + t.productNetCents;
  const total = p.card + p.cash + p.gcUsed;
  const tipsPos = p.tipsTotal - p.tipsOnline - p.tipsGc;
  const dueBarber = commission + p.tipsTotal - rentCents;
  return [p.workedMin, p.card, p.cash, p.gcUsed, p.gcBought, total, base, base ? commission / base : null, commission, p.tipsOnline, tipsPos, p.tipsGc, dueBarber, p.tax, total - dueBarber];
}

/** Every payout figure adds up but the rate; `at` is where the payout columns start. */
export const derivePayout = (at: number) => (c: Cell[]) => {
  const out = [...c];
  const base = Number(c[at + 6] ?? 0);
  out[at + 7] = base ? Number(c[at + 8] ?? 0) / base : null;
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
  // By barber, the barber is the row group, so the Barber column would repeat it.
  const named = !loc.byBarber;
  const who = (label: string): Cell[] => (named ? [label] : []);

  type Row = { shopId: string; staffId: string; key: string; cells: Cell[] };
  const barberRows: Row[] = [];
  const monthRows: Row[] = [];
  const payoutRows: Row[] = [];
  const pay = await payoutInputs(scope);
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
      barberRows.push({ shopId, staffId, key: staffId, cells: [...who(label), ...cells] });
      payoutRows.push({ shopId, staffId, key: staffId, cells: [...who(label), ...payoutCells(pay(shopId, staffId), t, r)] });
    }
    for (const m of monthsBetween(scope.from, scope.to)) {
      const month = commissionBetween(mine, vs, fb, m.start, m.end);
      const monthRent = rentShop ? boothRentBetween(vs, m.start, m.end) : 0;
      if (monthRent && rentShop && !month.has(rentShop)) month.set(rentShop, zeroTotals());
      for (const [shopId, t] of month) {
        if (!inScope.has(shopId)) continue;
        monthRows.push({ shopId, staffId, key: `${m.start.slice(0, 7)}|${staffId}`, cells: [formatDate(m.start, "yyyy-MM (MMM)"), ...who(label), ...figures(t, shopId === rentShop ? monthRent : 0)] });
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
      listTable(loc, { id: "payout", title: "Commission payout", columns: [...(named ? [text("Barber")] : []), ...PAYOUT_COLUMNS], rows: payoutRows, merge: true, derive: derivePayout(named ? 1 : 0), sort: named ? byName : undefined }),
      listTable(loc, { id: "barbers", title: "By barber", columns: [...(named ? [text("Barber")] : []), ...COLUMNS], rows: barberRows, merge: true, derive: derive(named ? 1 : 0), sort: named ? byName : undefined }),
      listTable(loc, { id: "months", title: "By month", columns: [text("Month"), ...(named ? [text("Barber")] : []), ...COLUMNS], rows: monthRows, merge: true, derive: derive(named ? 2 : 1), sort: byMonth }),
    ],
    notes: [
      "Commission payout: Total is what the barber's tickets took in (card, cash and gift card balances used, tips and tax included). Tips are split by where they came from: paid with a gift card, chosen while booking online, or added at the register. Due to barber is commission plus tips less booth rent; due to shop is the rest of Total, tax included.",
      "Rates come from each barber's compensation plan in effect on the day of the sale; whatever a plan leaves blank (and anyone without a plan) uses Payroll setup's rates.",
      "Tiers run on the month's net service sales to date, at every shop. A month split across ranges adds up: each part gets what the month to date earned at its end less what it had earned by its start.",
      "Sales count on the day they were paid, net of discounts; refunds on the day they were given, at the rate the sale earned. Squire imports and tickets with no barber are left out, as in payroll.",
    ],
  };
}
