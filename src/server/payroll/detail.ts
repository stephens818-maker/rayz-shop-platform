import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { payrollExportSends } from "@/db/schema";
import { employeePay, inNameOrder, toCents } from "@/domain/payroll/calc";
import { rangeText } from "@/domain/report-range";
import { SHOP_TZ, type LocalDate } from "@/lib/time";
import { toCsv } from "@/server/reports";
import { approvalOf, payrollRunView, type BlockView, type PayrollView } from "./run";
import type { TipCheckRow } from "./tip-reconcile";

/** The per-employee figures of the payroll detail file, in cents (hours in hundredths), in column order. */
const MONEY = [
  ["Hourly pay", (p) => p.hourlyPayCents],
  ["Service commission", (p) => p.serviceCommissionCents],
  ["Product commission", (p) => p.productCommissionCents],
  ["Late commission", (p) => p.lateCommissionCents],
  ["Greater-of top-up", (p) => p.topUpCents],
  ["Commission over hourly", (p) => p.commissionOverHourlyCents],
  ["Guarantee top-up", (p) => p.guaranteeTopUpCents],
  ["OT pay", (p) => p.overtimePayCents],
  ["Training pay", (p) => p.trainingPayCents],
  ["PTO pay", (p) => p.ptoPayCents],
  ["Total wages", (p) => p.wagesCents],
  ["Tips (ticket)", (p) => p.tipsCents],
  ["Declared cash tips", (p) => p.declaredCashTipsCents],
  ["Cash Tips Recd (iSolved)", (p) => p.cashTipsReceivedCents],
  ["Gross pay", (p) => p.grossCents],
] as const satisfies readonly (readonly [string, (p: ReturnType<typeof employeePay>) => number])[];

const HOURS = [
  ["Regular hours", (l) => l.hours],
  ["OT hours", (l) => l.otHours],
  ["Training hours", (l) => l.trainingHours],
  ["PTO hours", (l) => l.ptoHours],
] as const satisfies readonly (readonly [string, (l: BlockView["lines"][number]) => number])[];

const SALES = [
  ["Service sales", (l) => l.service],
  ["Product sales", (l) => l.product],
] as const satisfies readonly (readonly [string, (l: BlockView["lines"][number]) => number])[];

const TIP_SPLIT = ["Card tips paid via Stripe", "Tips through payroll"] as const;

export const DETAIL_HEADERS = [
  "Shop",
  "Employee Number",
  "Employee",
  ...HOURS.map(([h]) => h),
  "Hourly rate",
  ...SALES.map(([h]) => h),
  "Greater-of applied",
  ...MONEY.map(([h]) => h),
  ...TIP_SPLIT,
  "Stripe transfers",
];

const money = (cents: number) => (cents / 100).toFixed(2);
const hrs = (centi: number) => (centi / 100).toFixed(2);
const centi = (h: number) => Math.round(h * 100);

type Sums = { hours: number[]; sales: number[]; money: number[]; tips: number[] };
const zero = (): Sums => ({ hours: HOURS.map(() => 0), sales: SALES.map(() => 0), money: MONEY.map(() => 0), tips: TIP_SPLIT.map(() => 0) });
const add = (a: Sums, b: Sums) => {
  for (const k of ["hours", "sales", "money", "tips"] as const) b[k].forEach((v, i) => (a[k][i] += v));
};
const totalRow = (label: string, s: Sums) => [label, "", "Total", ...s.hours.map(hrs), "", ...s.sales.map(money), "", ...s.money.map(money), ...s.tips.map(money), ""];

/**
 * The payroll detail and reconciliation file: per employee per shop, hours (OT as allocated across
 * shops), hourly pay, commission, the greater-of and its top-up, training, PTO, tips by how they were
 * paid, total wages and gross, then each shop's total and (with more than one shop) every shop's.
 * Every pay figure is the Payroll Report line's, so it ties to the report and the iSolved file to the
 * cent. Card tips paid via Stripe are read from the tip transfers: the period's tips transferred to
 * the barber's Stripe account at the sale (pending or sent), plus any other tips a paid Stripe payout
 * carried, as the iSolved preview's tip check has them; then the transfers that carried them.
 */
export function detailRows(blocks: readonly BlockView[], tipRows: readonly TipCheckRow[]): (string | number)[][] {
  const tipsOf = new Map(tipRows.map((r) => [`${r.staffId}|${r.shopId}`, r] as const));
  const out: (string | number)[][] = [];
  const all = zero();
  for (const b of blocks) {
    const shop = zero();
    for (const l of b.lines) {
      const p = employeePay(l);
      const t = tipsOf.get(`${l.staffId}|${b.shopId}`);
      const paidByStripe = (t?.transferredCents ?? 0) + (t?.otherStripeCents ?? 0);
      const carried = [
        ...(t?.tipTransfers ?? []).filter((x) => x.status === "pending" || x.status === "sent").map((x) => x.stripeTransferId),
        ...(t?.payouts ?? []).filter((x) => x.method === "stripe" && x.status === "paid").map((x) => x.stripeTransferId),
      ];
      const s: Sums = { hours: HOURS.map(([, f]) => centi(f(l))), sales: SALES.map(([, f]) => toCents(f(l))), money: MONEY.map(([, f]) => f(p)), tips: [paidByStripe, toCents(l.tipsInPayroll)] };
      add(shop, s);
      out.push([
        b.shop,
        l.input.employeeNumber ?? "",
        l.name,
        ...s.hours.map(hrs),
        money(p.hourlyRateCents),
        ...s.sales.map(money),
        p.appliedRule,
        ...s.money.map(money),
        ...s.tips.map(money),
        [...new Set(carried.filter(Boolean))].join(" "),
      ]);
    }
    out.push(totalRow(b.shop, shop));
    add(all, shop);
  }
  if (blocks.length > 1) out.push(totalRow("All shops", all));
  return out;
}

export type DetailStatus = "draft" | "approved" | "locked" | "sent";

async function statusOf(view: PayrollView): Promise<DetailStatus> {
  const [sent] = await db.select({ id: payrollExportSends.id }).from(payrollExportSends).where(and(eq(payrollExportSends.periodStart, view.start), eq(payrollExportSends.periodEnd, view.end)));
  if (sent) return "sent";
  if (view.locked === "all") return "locked";
  return (await approvalOf(view))?.current ? "approved" : "draft";
}

/** Why the detail file can't be made: the Payroll Report's $0.00 reconciliation gate, and the tips against the Stripe payouts and tip transfers. */
export function detailRefusal(view: PayrollView): string | null {
  if (view.mismatches.length) return `Totals don't reconcile to $0.00, so the payroll detail file isn't made: ${view.mismatches.slice(0, 3).map((m) => m.detail).join("; ")}${view.mismatches.length > 3 ? `; and ${view.mismatches.length - 3} more` : ""}.`;
  if (view.tips.mismatches.length) return `${view.tips.mismatches.length} tip difference${view.tips.mismatches.length === 1 ? "" : "s"} against the Stripe payouts and tip transfers: fix them before downloading the payroll detail file.`;
  return null;
}

/**
 * The payroll detail file for a pay period (or whole workweeks for the shops given), brand-wide or
 * for the shops picked: CSV, separate from the iSolved file (which it never changes).
 */
export async function payrollDetailFile(
  start: LocalDate,
  end: LocalDate,
  o: { shopIds: readonly string[] | null; allowed: readonly string[] },
): Promise<{ refused: string; status: number } | { fileName: string; body: string; status: DetailStatus; rows: number; shops: string[] }> {
  const view = await payrollRunView(start, end, o.shopIds, { clockChecks: false });
  if (!view) return { refused: "None of your shops has a pay period, or whole workweeks, with those dates.", status: 404 };
  const blocks = inNameOrder(
    view.blocks.filter((b) => o.allowed.includes(b.shopId) && (!o.shopIds || o.shopIds.includes(b.shopId))),
    view.settings.sheetOrder,
    (b) => [b.exportTab, b.shop],
  );
  if (!blocks.length) return { refused: "None of your shops has a pay period, or whole workweeks, with those dates.", status: 404 };
  const why = detailRefusal(view);
  if (why) return { refused: why, status: 409 };
  const status = await statusOf(view);
  const brand = blocks.length === view.blocks.length && blocks.length > 1;
  const shops = brand ? "All shops" : blocks.map((b) => b.shop).join(", ");
  const heading = toCsv(["Report", "Date range", "Shops", "Time zone", "Status"], [["Payroll detail and reconciliation", rangeText(start, end), shops, SHOP_TZ, status === "draft" ? "DRAFT (not approved)" : status]]);
  const rows = detailRows(blocks, view.tips.rows.filter((r) => blocks.some((b) => b.shopId === r.shopId)));
  const label = brand ? "All shops" : blocks.length === 1 ? blocks[0].shop : "Shops";
  const fileName = `${status === "draft" ? "DRAFT - " : ""}Payroll detail ${label} ${start} to ${end}.csv`.replace(/[^\w .-]/g, "");
  return { fileName, body: `${heading}\n${toCsv(DETAIL_HEADERS, rows)}`, status, rows: blocks.reduce((a, b) => a + b.lines.length, 0), shops: blocks.map((b) => b.shopId) };
}
