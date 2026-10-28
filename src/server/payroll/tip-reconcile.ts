import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { staff, tipLedger, tipPayoutPeriods, tipPayouts, type TipPayoutMethod, type TipPayoutStatus } from "@/db/schema";
import { EXPORT_COLUMNS, PAID_TIP_COLUMNS, PAYROLL_TIP_COLUMNS, extraFromOf, hasTipColumns, sumColumns, toCents, type ExportRow, type ExtraFrom, type Line, type Mismatch } from "@/domain/payroll/calc";
import type { LocalDate } from "@/lib/time";
import { toCsv } from "@/server/reports";
import { recordMissingPayoutPeriods } from "@/server/tips/pay-periods";
import { payrollTipSplit } from "@/server/tips/payouts";

/** What the check needs of a shop's block on the Payroll Report: its rows, its iSolved file, and when it was locked. */
export interface TipCheckBlock {
  shopId: string;
  shop: string;
  lines: readonly (Pick<Line, "staffId" | "name"> & Partial<Pick<Line, "declaredCashTips">>)[];
  /** A row with its own `from` was filed separately (a final pay, N9), with that file's columns. */
  exportRows: readonly (ExportRow & { from?: ExtraFrom[] })[];
  exportHeaders?: string[];
  exportFrom?: ExtraFrom[];
  locked: { at: string } | null;
}

export interface TipCheckPayout {
  id: string;
  method: TipPayoutMethod;
  status: TipPayoutStatus;
  /** Tips less refunds from this period, and adjustments dated in it: what payroll counts. */
  tipsCents: number;
  adjustCents: number;
  /** The card fee netted from this period's card tips, where the shop nets it. */
  feeCents: number;
  instant: boolean;
  instantFeeCents: number;
  instantFeePaidBy: "employee" | "shop";
  stripePayoutId: string | null;
  stripeTransferId: string | null;
  sentAt: Date | null;
  paidAt: Date | null;
  /** The payout also has tips from another pay period (a batch across a period end). */
  split: boolean;
}

export interface TipCheckRow {
  shopId: string;
  shop: string;
  staffId: string;
  name: string;
  /** Every tip, refund and adjustment of the period in the tip ledger. */
  earnedCents: number;
  /** Of those, paid (or to be paid) through payroll. */
  inPayrollCents: number;
  /** The rest: paid straight to the employee (Stripe or cash), already or by a later batch. iSolved gets these as tips already received. */
  directCents: number;
  /** Direct payouts of the period that are paid. */
  paidCents: number;
  /** Of those, paid by the time the period was locked: what the locked file's memo column carries. Open periods: all of them. */
  paidAtLockCents: number;
  /** Approved or sent, not paid yet. */
  inFlightCents: number;
  /** Not paid yet: waiting for approval, held (their Stripe setup, or a manager), or not in a batch. */
  owedCents: number;
  /** Cash tips they declared for the period: in E_Cash Tips Recd_Dollars with their ticket tips. */
  declaredCents: number;
  /** In the shop's iSolved file. Null: they have no row in it. */
  exportCashTipsCents: number | null;
  exportPaidMemoCents: number;
  exportPayrollTipsCents: number;
  payouts: TipCheckPayout[];
  problems: string[];
}

export interface TipCheck {
  rows: TipCheckRow[];
  /** Every per-employee difference; those of shops still open block approve and lock while direct Stripe payouts are on. */
  mismatches: Mismatch[];
}

const CASH_TIPS = EXPORT_COLUMNS.findIndex((c) => c.from === "tipsOutside");
const CASH_TIPS_HEADER = EXPORT_COLUMNS[CASH_TIPS].header;
const dollars = (c: number) => c / 100;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * The W-2 check on a pay period, per employee and shop, to the cent: E_Cash Tips Recd in the iSolved
 * file is every tip in the tip ledger plus their declared cash tips (the file is the workbook's 8
 * columns; Charles declined separate tip codes). A period locked when the file still had tip columns
 * is checked against its own columns: cash tips without payroll tips, the paid-out memo against the
 * payouts paid by the lock, the tips-in-payroll column against the ledger. Every direct payout is
 * listed with its Stripe ids, so each one can be traced into the file it was reported in.
 */
export async function checkPayrollTips(blocks: readonly TipCheckBlock[], start: LocalDate, end: LocalDate, tx: DBorTx = db): Promise<TipCheck> {
  const shopIds = blocks.map((b) => b.shopId);
  if (!shopIds.length) return { rows: [], mismatches: [] };
  const split = await payrollTipSplit(shopIds, start, end, tx);
  await recordMissingPayoutPeriods(tx, shopIds);
  const [earned, recorded] = await Promise.all([
    tx
      .select({ shopId: tipLedger.shopId, staffId: tipLedger.staffId, cents: sql<number>`sum(${tipLedger.amountCents})::int` })
      .from(tipLedger)
      .where(and(inArray(tipLedger.shopId, shopIds), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end)))
      .groupBy(tipLedger.shopId, tipLedger.staffId),
    tx
      .select({ r: tipPayoutPeriods, p: tipPayouts, periods: sql<number>`(select count(*)::int from ${tipPayoutPeriods} x where x.payout_id = ${tipPayouts.id})` })
      .from(tipPayoutPeriods)
      .innerJoin(tipPayouts, eq(tipPayouts.id, tipPayoutPeriods.payoutId))
      .where(and(inArray(tipPayoutPeriods.shopId, shopIds), eq(tipPayoutPeriods.periodStart, start), ne(tipPayoutPeriods.method, "payroll"))),
  ]);
  const key = (shopId: string, staffId: string) => `${staffId}|${shopId}`;
  const keys = new Set<string>([...earned.map((e) => key(e.shopId, e.staffId)), ...recorded.map((x) => key(x.r.shopId, x.r.staffId))]);
  for (const b of blocks) for (const r of b.exportRows) keys.add(key(b.shopId, r.staffId));
  const nameOf = new Map(blocks.flatMap((b) => b.lines.map((l) => [l.staffId, l.name] as const)));
  const declaredOf = new Map(blocks.flatMap((b) => b.lines.map((l) => [key(b.shopId, l.staffId), toCents(l.declaredCashTips ?? 0)] as const)));
  const missing = [...new Set([...keys].map((k) => k.split("|")[0]).filter((id) => !nameOf.has(id)))];
  if (missing.length) for (const s of await tx.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, missing))) nameOf.set(s.id, s.label);

  const rows: TipCheckRow[] = [];
  const mismatches: Mismatch[] = [];
  for (const b of blocks) {
    const from = extraFromOf(b);
    const at = (r: TipCheckBlock["exportRows"][number] | undefined, ks: readonly ExtraFrom[]) => (r ? toCents(sumColumns(r.from ?? from, r.values, ks)) : 0);
    const lockedAt = b.locked ? new Date(b.locked.at) : null;
    for (const k of [...keys].filter((x) => x.endsWith(`|${b.shopId}`))) {
      const staffId = k.split("|")[0];
      const row = b.exportRows.find((r) => r.staffId === staffId);
      const mine = recorded.filter((x) => x.r.staffId === staffId && x.r.shopId === b.shopId);
      const cents = (x: (typeof mine)[number]) => x.r.tipsCents + x.r.adjustCents;
      const earnedCents = earned.find((e) => e.staffId === staffId && e.shopId === b.shopId)?.cents ?? 0;
      const inPayrollCents = split.get(k)?.inPayrollCents ?? 0;
      // Payroll never takes tips below zero (SB-C2); a deducted refund bigger than the period's tips is the shop's cost past that.
      const directCents = Math.max(0, earnedCents) - inPayrollCents;
      const paid = mine.filter((x) => x.p.status === "paid");
      const paidCents = paid.reduce((a, x) => a + cents(x), 0);
      const paidAtLockCents = lockedAt ? paid.filter((x) => x.p.paidAt && x.p.paidAt <= lockedAt).reduce((a, x) => a + cents(x), 0) : paidCents;
      const inFlightCents = mine.filter((x) => x.p.status === "approved" || x.p.status === "processing").reduce((a, x) => a + cents(x), 0);
      const declaredCents = declaredOf.get(k) ?? 0;
      const oldLayout = hasTipColumns(row?.from ?? from);
      const r: TipCheckRow = {
        shopId: b.shopId,
        shop: b.shop,
        staffId,
        name: nameOf.get(staffId) ?? "Unknown",
        earnedCents,
        declaredCents,
        inPayrollCents,
        directCents,
        paidCents,
        paidAtLockCents,
        inFlightCents,
        owedCents: directCents - paidCents - inFlightCents,
        exportCashTipsCents: row ? toCents((row.values[CASH_TIPS] ?? 0) + sumColumns(row.from ?? from, row.values, ["cardTipsOutside"])) : null,
        exportPaidMemoCents: at(row, PAID_TIP_COLUMNS),
        exportPayrollTipsCents: at(row, PAYROLL_TIP_COLUMNS),
        payouts: mine.map((x) => ({
          id: x.p.id,
          method: x.p.method,
          status: x.p.status,
          tipsCents: x.r.tipsCents,
          adjustCents: x.r.adjustCents,
          feeCents: x.r.feeCents,
          instant: x.p.instant,
          instantFeeCents: x.p.instantFeeCents,
          instantFeePaidBy: x.p.instantFeePaidBy,
          stripePayoutId: x.p.stripePayoutId,
          stripeTransferId: x.p.stripeTransferId,
          sentAt: x.p.sentAt,
          paidAt: x.p.paidAt,
          split: x.periods > 1,
        })),
        problems: [],
      };
      const flag = (column: string, report: number, other: number, detail: string) => {
        r.problems.push(detail);
        mismatches.push({ shopId: b.shopId, column, check: "tips", report: dollars(report), other: dollars(other), detail: `${b.shop}: ${r.name}: ${detail}` });
      };
      const exported = r.exportCashTipsCents ?? 0;
      const wantCash = oldLayout ? directCents : Math.max(0, earnedCents) + declaredCents;
      if (exported !== wantCash)
        flag(
          CASH_TIPS_HEADER,
          exported,
          wantCash,
          r.exportCashTipsCents === null
            ? `${usd(wantCash)} of tips, and no row in the iSolved file`
            : oldLayout
              ? `the iSolved file has ${usd(exported)} of tips already received; the tip ledger has ${usd(directCents)} paid outside payroll`
              : `the iSolved file has ${usd(exported)} of tips received; the tip ledger has ${usd(Math.max(0, earnedCents))}${declaredCents ? ` and they declared ${usd(declaredCents)} in cash` : ""}`,
        );
      if (!oldLayout) {
        if (r.earnedCents || r.inFlightCents || r.paidCents || r.problems.length || exported) rows.push(r);
        continue;
      }
      if (r.exportPaidMemoCents !== paidAtLockCents)
        flag(
          "Tips already paid out",
          r.exportPaidMemoCents,
          paidAtLockCents,
          `the iSolved file marks ${usd(r.exportPaidMemoCents)} as already paid out; their payouts for the period ${lockedAt ? "paid by the lock " : ""}add up to ${usd(paidAtLockCents)}`,
        );
      if (r.exportPayrollTipsCents !== inPayrollCents)
        flag("Tips in payroll", r.exportPayrollTipsCents, inPayrollCents, `the iSolved file pays ${usd(r.exportPayrollTipsCents)} of tips in payroll; the tip ledger has ${usd(inPayrollCents)}`);
      if (r.earnedCents || r.inFlightCents || r.paidCents || r.problems.length || exported) rows.push(r);
    }
  }
  rows.sort((a, b) => a.shop.localeCompare(b.shop) || a.name.localeCompare(b.name));
  return { rows, mismatches };
}

const money = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

/**
 * The payroll-period tip report as a CSV for payroll: one line per employee and shop (tips earned, in
 * payroll, paid direct, still owed, what the iSolved file carries and whether it matches), then one
 * line per direct payout with its Stripe ids. Account and card numbers never appear; Stripe ids only.
 */
export function tipCheckCsv(check: TipCheck, start: LocalDate, end: LocalDate): string {
  const lines: (string | number | null)[][] = [
    ["Pay period", `${start} to ${end}`],
    [],
    [
      "Shop",
      "Employee",
      "Tips earned",
      "Tips in payroll",
      "Tips paid direct (to iSolved as received)",
      "Paid out",
      "Paid out by the lock",
      "Sent, not paid yet",
      "Still owed",
      `iSolved ${CASH_TIPS_HEADER}`,
      "iSolved tips already paid out (memo)",
      "iSolved tips in payroll",
      "Matches",
      "Problems",
    ],
    ...check.rows.map((r) => [
      r.shop,
      r.name,
      money(r.earnedCents),
      money(r.inPayrollCents),
      money(r.directCents),
      money(r.paidCents),
      money(r.paidAtLockCents),
      money(r.inFlightCents),
      money(r.owedCents),
      money(r.exportCashTipsCents),
      money(r.exportPaidMemoCents),
      money(r.exportPayrollTipsCents),
      r.problems.length ? "no" : "yes",
      r.problems.join("; "),
    ]),
    [],
    ["Shop", "Employee", "Payout", "Method", "Status", "Tips", "Adjustments", "Card fee netted", "Instant fee", "Instant fee paid by", "Stripe transfer", "Stripe payout", "Sent", "Paid", "Also has tips from another period"],
    ...check.rows.flatMap((r) =>
      r.payouts.map((p) => [
        r.shop,
        r.name,
        p.id,
        p.method,
        p.status,
        money(p.tipsCents),
        money(p.adjustCents),
        money(p.feeCents),
        money(p.instantFeeCents),
        p.instantFeeCents ? p.instantFeePaidBy : "",
        p.stripeTransferId,
        p.stripePayoutId,
        p.sentAt?.toISOString() ?? "",
        p.paidAt?.toISOString() ?? "",
        p.split ? "yes" : "",
      ]),
    ),
  ];
  return toCsv(lines[0] as string[], lines.slice(1));
}
