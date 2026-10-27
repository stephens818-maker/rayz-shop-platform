import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { Cell, Column, ViewCtx, listTable } from "@/domain/report-views";
import { METHOD_LABEL, STATUS_LABEL, receivedCents, shopCostCents } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { localDateOf } from "@/lib/time";
import type { ReportData } from "@/server/report-data";
import { ReportScope, staffSelection } from "@/server/reports";
import { syncTipLedger } from "./ledger";

const text = (label: string): Column => ({ label });
const money = (label: string): Column => ({ label, kind: "money" });
const byName = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0]));
const uuids = (xs: readonly string[]) => sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `);

type Row = {
  shopId: string;
  staffId: string;
  card: number;
  cashGift: number;
  refunded: number;
  adjusted: number;
  paidCash: number;
  paidStripe: number;
  paidPayroll: number;
  paidPrior: number;
  fees: number;
};

/**
 * Tips per shop and employee in the period (by the day of the tip, the refund or the adjustment, as
 * payroll counts them), and how they were paid: cash, Stripe, payroll, or before tip payouts. "Not
 * yet paid" is what's still pending settlement, available or waiting in a batch. Then every payout.
 */
export async function tipPayoutsData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  await syncTipLedger(db, { shopIds: scope.shopIds });
  const sel = staffSelection(scope);
  const staffOnly = sel ? sql` and l.staff_id in (${uuids(sel)})` : sql``;
  const rows = [
    ...(await db.execute<Row>(sql`
      select l.shop_id "shopId", l.staff_id "staffId",
        sum(case when l.kind = 'tip' and l.method = 'card' then l.amount_cents else 0 end)::int card,
        sum(case when l.kind = 'tip' and l.method <> 'card' then l.amount_cents else 0 end)::int "cashGift",
        sum(case when l.kind = 'refund' then l.amount_cents else 0 end)::int refunded,
        sum(case when l.kind = 'adjust' then l.amount_cents else 0 end)::int adjusted,
        sum(case when p.status = 'paid' and p.method = 'cash' then l.amount_cents else 0 end)::int "paidCash",
        sum(case when p.status = 'paid' and p.method = 'stripe' then l.amount_cents else 0 end)::int "paidStripe",
        sum(case when p.status = 'paid' and p.method = 'payroll' then l.amount_cents else 0 end)::int "paidPayroll",
        sum(case when p.status = 'paid' and p.method = 'prior' then l.amount_cents else 0 end)::int "paidPrior",
        sum(case when p.status = 'paid' and p.fee_cents <> 0 and l.kind <> 'adjust' then l.fee_cents else 0 end)::int fees
      from tip_ledger l left join tip_payouts p on p.id = l.payout_id
      where l.shop_id in (${uuids(scope.shopIds)}) and l.business_date between ${scope.from} and ${scope.to} ${staffOnly}
      group by 1, 2`)),
  ];
  const payouts = [
    ...(await db.execute<{
      id: string;
      shopId: string;
      staffId: string;
      method: keyof typeof METHOD_LABEL;
      status: keyof typeof STATUS_LABEL;
      at: Date;
      gross: number;
      fee: number;
      adjust: number;
      net: number;
      instantFee: number;
      feePaidBy: string;
      last4: string | null;
      ref: string | null;
    }>(sql`
      select p.id, p.shop_id "shopId", p.staff_id "staffId", p.method, p.status, coalesce(p.paid_at, p.sent_at, p.created_at) "at",
        p.gross_cents gross, p.fee_cents fee, p.adjust_cents adjust, p.net_cents net, p.instant_fee_cents "instantFee", p.instant_fee_paid_by "feePaidBy",
        p.destination_last4 last4, coalesce(p.stripe_transfer_id, p.ack_method) ref
      from tip_payouts p
      where p.shop_id in (${uuids(scope.shopIds)}) and p.method <> 'prior' and p.status <> 'cancelled'
        and (coalesce(p.paid_at, p.sent_at, p.created_at) at time zone 'America/Chicago')::date between ${scope.from} and ${scope.to}
        ${sel ? sql` and p.staff_id in (${uuids(sel)})` : sql``}`)),
  ];
  const ids = [...new Set([...rows.map((r) => r.staffId), ...payouts.map((p) => p.staffId)])];
  const name = new Map((ids.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)) : []).map((s) => [s.id, s.label]));
  const net = (r: Row) => r.card + r.cashGift + r.refunded + r.adjusted;
  const paid = (r: Row) => r.paidCash + r.paidStripe + r.paidPayroll + r.paidPrior;
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    stats: [
      { label: "Tips earned", value: formatCents(sum(net)), hint: `card ${formatCents(sum((r) => r.card))} · cash and gift card ${formatCents(sum((r) => r.cashGift))} · refunded ${formatCents(-sum((r) => r.refunded))}` },
      { label: "Paid out separately", value: formatCents(sum((r) => r.paidCash + r.paidStripe)), hint: `cash ${formatCents(sum((r) => r.paidCash))} · Stripe ${formatCents(sum((r) => r.paidStripe))}` },
      { label: "Paid through payroll", value: formatCents(sum((r) => r.paidPayroll)) },
      { label: "Not yet paid", value: formatCents(sum((r) => net(r) - paid(r))), hint: "pending settlement, available or in a batch" },
    ],
    tables: [
      listTable(loc, {
        id: "employees",
        title: "By employee",
        columns: [
          text("Employee"),
          money("Card tips"),
          money("Cash and gift card tips"),
          money("Refunded"),
          money("Adjusted"),
          money("Net tips"),
          money("Paid in cash"),
          money("Paid by Stripe"),
          money("Paid in payroll"),
          money("Paid before tip payouts"),
          money("Card fees netted"),
          money("Not yet paid"),
        ],
        rows: rows.map((r) => ({
          shopId: r.shopId,
          staffId: r.staffId,
          key: r.staffId,
          cells: [name.get(r.staffId) ?? "Unknown", r.card, r.cashGift, r.refunded, r.adjusted, net(r), r.paidCash, r.paidStripe, r.paidPayroll, r.paidPrior, r.fees, net(r) - paid(r)],
        })),
        merge: true,
        sort: byName,
      }),
      listTable(loc, {
        id: "payouts",
        title: "Payouts",
        subtitle: "Cash, Stripe and payroll payouts in the period, by the day each was paid or sent.",
        columns: [
          text("Date"),
          text("Employee"),
          text("Method"),
          text("Status"),
          money("Tips"),
          money("Card fee"),
          money("Adjustments"),
          money("Paid"),
          money("Instant fee"),
          text("Instant fee paid by"),
          money("Shop's cost"),
          text("To"),
          text("Reference"),
        ],
        rows: payouts.map((p) => {
          const amounts = { netCents: p.net, instantFeeCents: p.instantFee, instantFeePaidBy: p.feePaidBy };
          return {
            shopId: p.shopId,
            staffId: p.staffId,
            cells: [
              localDateOf(p.at),
              name.get(p.staffId) ?? "Unknown",
              METHOD_LABEL[p.method],
              STATUS_LABEL[p.status],
              p.gross,
              -p.fee,
              p.adjust,
              receivedCents(amounts),
              p.instantFee,
              p.instantFee ? (p.feePaidBy === "shop" ? "Shop" : "Employee") : "",
              shopCostCents(amounts),
              p.last4 ? `••${p.last4}` : "",
              p.ref === "pin" ? "PIN" : p.ref === "name" ? "Signed" : p.ref,
            ],
          };
        }),
        keepShop: loc.shops.length > 1,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[1]).localeCompare(String(b[1])),
      }),
    ],
    notes: [
      "Card tips count once their card money settles (the shop's delay); cash and gift card tips at once. Refunded tips come off the day of the refund.",
      "Card fee netting is a per-shop setting, off unless turned on; whether it's allowed and how it's reported is for the accountant to confirm.",
      "Stripe's instant payout fee comes out of the employee's payout where the brand passes it on; otherwise the shop pays it on top (Shop's cost).",
    ],
  };
}
