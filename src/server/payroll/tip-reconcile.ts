import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { paymentTransfers, sales, staff, tipLedger, tipPayoutPeriods, tipPayouts, type PaymentTransferStatus, type TipPayoutMethod, type TipPayoutStatus } from "@/db/schema";
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

/** A card tip of the period transferred to the barber's Stripe account at the sale (payment_transfers, kind tip). */
export interface TipCheckTransfer {
  id: string;
  saleId: string;
  paymentId: string;
  date: LocalDate;
  cents: number;
  status: PaymentTransferStatus;
  stripeTransferId: string | null;
  /** The tip ledger entry it pays; null when the ledger has none (a problem). */
  ledgerCents: number | null;
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
  /** Card tips of the period transferred to their Stripe account at the sale (tip transfers pending or sent), read from the transfers themselves. */
  transferredCents: number;
  /** Other tips of the period paid to them through Stripe: in a paid Stripe payout and not transferred at the sale. */
  otherStripeCents: number;
  tipTransfers: TipCheckTransfer[];
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
const TIP_TRANSFERS = "Card tips transferred to Stripe at the sale";
const dollars = (c: number) => c / 100;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * The W-2 check on a pay period, per employee and shop, to the cent: E_Cash Tips Recd in the iSolved
 * file is every tip in the tip ledger plus their declared cash tips (the file is the workbook's 8
 * columns; Charles declined separate tip codes). A period locked when the file still had tip columns
 * is checked against its own columns: cash tips without payroll tips, the paid-out memo against the
 * payouts paid by the lock, the tips-in-payroll column against the ledger. Every direct payout is
 * listed with its Stripe ids, so each one can be traced into the file it was reported in. Card tips
 * sent to barbers at the sale are read from their tip transfers, and each must be its tip ledger
 * entry to the cent: a tip paid through Stripe is reported once, never missed or paid twice.
 */
export async function checkPayrollTips(blocks: readonly TipCheckBlock[], start: LocalDate, end: LocalDate, tx: DBorTx = db): Promise<TipCheck> {
  const shopIds = blocks.map((b) => b.shopId);
  if (!shopIds.length) return { rows: [], mismatches: [] };
  const split = await payrollTipSplit(shopIds, start, end, tx);
  await recordMissingPayoutPeriods(tx, shopIds);
  const inPeriod = and(inArray(tipLedger.shopId, shopIds), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end));
  const transferCols = {
    id: paymentTransfers.id,
    saleId: paymentTransfers.saleId,
    paymentId: paymentTransfers.paymentId,
    cents: paymentTransfers.amountCents,
    status: paymentTransfers.status,
    stripeTransferId: paymentTransfers.stripeTransferId,
  };
  const [earned, recorded, ledgered, unledgered, otherStripe] = await Promise.all([
    tx
      .select({ shopId: tipLedger.shopId, staffId: tipLedger.staffId, cents: sql<number>`sum(${tipLedger.amountCents})::int` })
      .from(tipLedger)
      .where(inPeriod)
      .groupBy(tipLedger.shopId, tipLedger.staffId),
    tx
      .select({ r: tipPayoutPeriods, p: tipPayouts, periods: sql<number>`(select count(*)::int from ${tipPayoutPeriods} x where x.payout_id = ${tipPayouts.id})` })
      .from(tipPayoutPeriods)
      .innerJoin(tipPayouts, eq(tipPayouts.id, tipPayoutPeriods.payoutId))
      .where(and(inArray(tipPayoutPeriods.shopId, shopIds), eq(tipPayoutPeriods.periodStart, start), ne(tipPayoutPeriods.method, "payroll"))),
    tx
      .select({ ...transferCols, shopId: tipLedger.shopId, staffId: tipLedger.staffId, date: tipLedger.businessDate, ledgerCents: tipLedger.amountCents })
      .from(tipLedger)
      .innerJoin(paymentTransfers, and(eq(paymentTransfers.paymentId, tipLedger.paymentId), eq(paymentTransfers.staffId, tipLedger.staffId), eq(paymentTransfers.kind, "tip")))
      .where(and(inPeriod, eq(tipLedger.kind, "tip"))),
    // A tip sent to a barber with no tip in the ledger would be paid but never reported to iSolved.
    tx
      .select({ ...transferCols, shopId: paymentTransfers.shopId, staffId: paymentTransfers.staffId, date: sales.businessDate, ledgerCents: sql<number | null>`null::int` })
      .from(paymentTransfers)
      .innerJoin(sales, eq(sales.id, paymentTransfers.saleId))
      .where(
        and(
          eq(paymentTransfers.kind, "tip"),
          inArray(paymentTransfers.shopId, shopIds),
          inArray(paymentTransfers.status, ["pending", "sent"]),
          gte(sales.businessDate, start),
          lte(sales.businessDate, end),
          sql`not exists (select 1 from tip_ledger l where l.kind = 'tip' and l.payment_id = ${paymentTransfers.paymentId} and l.staff_id = ${paymentTransfers.staffId})`,
        ),
      ),
    tx
      .select({ shopId: tipLedger.shopId, staffId: tipLedger.staffId, cents: sql<number>`sum(${tipLedger.amountCents})::int` })
      .from(tipLedger)
      .innerJoin(tipPayouts, eq(tipPayouts.id, tipLedger.payoutId))
      .where(
        and(
          inPeriod,
          eq(tipPayouts.method, "stripe"),
          eq(tipPayouts.status, "paid"),
          sql`not exists (select 1 from payment_transfers pt where pt.kind = 'tip' and pt.payment_id = ${tipLedger.paymentId} and pt.staff_id = ${tipLedger.staffId} and pt.status in ('pending', 'sent'))`,
        ),
      )
      .groupBy(tipLedger.shopId, tipLedger.staffId),
  ]);
  const key = (shopId: string, staffId: string) => `${staffId}|${shopId}`;
  const tipTransfers = [...ledgered, ...unledgered].map((t) => ({ ...t, staffId: t.staffId! }));
  const keys = new Set<string>([...earned.map((e) => key(e.shopId, e.staffId)), ...recorded.map((x) => key(x.r.shopId, x.r.staffId)), ...tipTransfers.map((t) => key(t.shopId, t.staffId))]);
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
      const transfers: TipCheckTransfer[] = tipTransfers
        .filter((t) => t.staffId === staffId && t.shopId === b.shopId)
        .map((t) => ({ id: t.id, saleId: t.saleId, paymentId: t.paymentId, date: t.date as LocalDate, cents: t.cents, status: t.status, stripeTransferId: t.stripeTransferId, ledgerCents: t.ledgerCents }))
        .sort((a, c) => a.date.localeCompare(c.date) || a.id.localeCompare(c.id));
      const withBarber = transfers.filter((t) => t.status === "pending" || t.status === "sent");
      const r: TipCheckRow = {
        shopId: b.shopId,
        shop: b.shop,
        staffId,
        name: nameOf.get(staffId) ?? "Unknown",
        earnedCents,
        declaredCents,
        inPayrollCents,
        directCents,
        transferredCents: withBarber.reduce((a, t) => a + t.cents, 0),
        otherStripeCents: otherStripe.find((x) => x.staffId === staffId && x.shopId === b.shopId)?.cents ?? 0,
        tipTransfers: transfers,
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
      for (const t of withBarber)
        if (t.ledgerCents !== t.cents)
          flag(
            TIP_TRANSFERS,
            t.cents,
            t.ledgerCents ?? 0,
            t.ledgerCents === null
              ? `a tip transfer of ${usd(t.cents)} (sale ${t.saleId}) has no tip in the tip ledger, so it isn't in the iSolved file`
              : `the tip transfer of ${usd(t.cents)} (sale ${t.saleId}) doesn't match its ${usd(t.ledgerCents)} in the tip ledger`,
          );
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
        if (r.earnedCents || r.inFlightCents || r.paidCents || r.transferredCents || r.problems.length || exported) rows.push(r);
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
      if (r.earnedCents || r.inFlightCents || r.paidCents || r.transferredCents || r.problems.length || exported) rows.push(r);
    }
  }
  rows.sort((a, b) => a.shop.localeCompare(b.shop) || a.name.localeCompare(b.name));
  return { rows, mismatches };
}

const money = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

/**
 * The payroll-period tip report as a CSV for payroll: one line per employee and shop (tips earned, in
 * payroll, paid direct, transferred to Stripe at the sale, still owed, what the iSolved file carries
 * and whether it matches), then one line per direct payout with its Stripe ids, then one per tip
 * transfer (read from payment_transfers) against its tip ledger entry. Account and card numbers never
 * appear; Stripe ids only.
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
      TIP_TRANSFERS,
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
      money(r.transferredCents),
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
    [],
    ["Shop", "Employee", "Tip transfer", "Sale", "Payment", "Date", "Tip", "Status", "Stripe transfer", "In the tip ledger"],
    ...check.rows.flatMap((r) =>
      r.tipTransfers.map((t) => [r.shop, r.name, t.id, t.saleId, t.paymentId, t.date, money(t.cents), t.status, t.stripeTransferId, money(t.ledgerCents)]),
    ),
  ];
  return toCsv(lines[0] as string[], lines.slice(1));
}
