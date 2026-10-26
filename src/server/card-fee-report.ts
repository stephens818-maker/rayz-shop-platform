import "server-only";
import { sql } from "drizzle-orm";
import { NO_BARBER } from "@/domain/barbers";
import { FEE_CHANNEL_LABEL, FeeChannel } from "@/domain/card-fee-policy";
import { Cell, Column, Metric, ReportTable, TOTAL, ViewCtx, listTable, metricTable, segKey, viewOf } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { ReportScope, grainsFor, ids, rows, staffFilter } from "./report-sql";

/**
 * The credit card fee report: surcharges collected and waived, the rate they came to, and what they
 * recovered of the processing cost, by location, barber, day, channel and card type. Charges count
 * on the day they were taken and fee refunds on the day they were given, as in every sales report.
 * Processing cost is what Stripe charged (or, on a shop's own account, the platform's processing fee),
 * on every card charge in the range, voided ones included, since Stripe keeps its fee on those.
 */

interface Fine {
  shop_id: string;
  staff_id: string | null;
  day: string;
  channel: FeeChannel;
  brand: string;
  funding: string;
  charges: number;
  surcharged: number;
  waivers: number;
  amount: number;
  fee: number;
  waived: number;
  basis: number;
  cost: number;
  cost_surcharged: number;
  fee_refunded: number;
}

export interface FeeTotals {
  charges: number;
  surcharged: number;
  waivers: number;
  amountCents: number;
  feeChargedCents: number;
  feeRefundedCents: number;
  /** Charged less refunded. */
  feeCents: number;
  waivedCents: number;
  basisCents: number;
  costCents: number;
  costSurchargedCents: number;
}

const ZERO = (): FeeTotals => ({
  charges: 0,
  surcharged: 0,
  waivers: 0,
  amountCents: 0,
  feeChargedCents: 0,
  feeRefundedCents: 0,
  feeCents: 0,
  waivedCents: 0,
  basisCents: 0,
  costCents: 0,
  costSurchargedCents: 0,
});

function add(t: FeeTotals, r: Fine) {
  t.charges += r.charges;
  t.surcharged += r.surcharged;
  t.waivers += r.waivers;
  t.amountCents += r.amount;
  t.feeChargedCents += r.fee;
  t.feeRefundedCents += r.fee_refunded;
  t.feeCents += r.fee - r.fee_refunded;
  t.waivedCents += r.waived;
  t.basisCents += r.basis;
  t.costCents += r.cost;
  t.costSurchargedCents += r.cost_surcharged;
}

/** Surcharge charged over the amounts it was charged on. */
export const effectiveRate = (t: FeeTotals) => (t.basisCents ? t.feeChargedCents / t.basisCents : null);
/** Surcharges kept over the processing cost of every card charge. */
export const recovery = (t: FeeTotals) => (t.costCents ? t.feeCents / t.costCents : null);

const COST = sql`coalesce(nullif(p.processor_fee_cents, 0), p.application_fee_cents, 0)`;
const DIMS = sql`coalesce(p.fee_channel, 'pos') channel, coalesce(nullif(lower(p.card_brand), ''), 'unknown') brand, coalesce(p.card_funding, 'unknown') funding`;

/** At the finest grain: shop, barber, day, channel, card brand and funding. */
export async function cardFeeRows(s: ReportScope): Promise<Fine[]> {
  const [pay, ref] = await Promise.all([
    rows<Omit<Fine, "fee_refunded">>(sql`
      select p.shop_id, s.staff_id, p.business_date::text as day, ${DIMS},
        count(*) filter (where p.status <> 'voided' and s.status <> 'voided')::int charges,
        count(*) filter (where p.card_fee_cents > 0 and p.status <> 'voided' and s.status <> 'voided')::int surcharged,
        count(*) filter (where p.fee_waived and p.status <> 'voided' and s.status <> 'voided')::int waivers,
        coalesce(sum(p.amount_cents) filter (where p.status <> 'voided' and s.status <> 'voided'), 0)::int amount,
        coalesce(sum(p.card_fee_cents) filter (where p.status <> 'voided' and s.status <> 'voided'), 0)::int fee,
        coalesce(sum(p.fee_waived_cents) filter (where p.status <> 'voided' and s.status <> 'voided'), 0)::int waived,
        coalesce(sum(p.fee_basis_cents) filter (where p.card_fee_cents > 0 and p.status <> 'voided' and s.status <> 'voided'), 0)::int basis,
        coalesce(sum(${COST}), 0)::int cost,
        coalesce(sum(${COST}) filter (where p.card_fee_cents > 0), 0)::int cost_surcharged
      from payments p join sales s on s.id = p.sale_id
      where p.method = 'card' and p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and p.status not in ('pending', 'failed')
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3, 4, 5, 6`),
    rows<Pick<Fine, "shop_id" | "staff_id" | "day" | "channel" | "brand" | "funding" | "fee_refunded">>(sql`
      select r.shop_id, s.staff_id, r.business_date::text as day, ${DIMS}, coalesce(sum(r.card_fee_cents), 0)::int fee_refunded
      from refunds r join sales s on s.id = r.sale_id join payments p on p.id = r.payment_id
      where r.method = 'card' and r.kind = 'refund' and r.card_fee_cents <> 0 and r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to}
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3, 4, 5, 6`),
  ]);
  const k = (r: Pick<Fine, "shop_id" | "staff_id" | "day" | "channel" | "brand" | "funding">) => [r.shop_id, r.staff_id, r.day, r.channel, r.brand, r.funding].join("|");
  const out = new Map<string, Fine>(pay.map((r) => [k(r), { ...r, fee_refunded: 0 }]));
  for (const r of ref) {
    const cur = out.get(k(r));
    if (cur) cur.fee_refunded += r.fee_refunded;
    else out.set(k(r), { ...r, charges: 0, surcharged: 0, waivers: 0, amount: 0, fee: 0, waived: 0, basis: 0, cost: 0, cost_surcharged: 0 });
  }
  return [...out.values()];
}

/** Totals keyed by report segment (per shop, per barber, both, and the total) for the view. */
export function feeTotalsAt(fine: Fine[], loc: ViewCtx): Record<string, FeeTotals> {
  const out: Record<string, FeeTotals> = {};
  for (const g of grainsFor(loc)) {
    for (const r of fine) {
      const key = segKey(g.byShop ? r.shop_id : null, g.byStaff ? (r.staff_id ?? NO_BARBER) : null);
      add((out[key] ??= ZERO()), r);
    }
  }
  out[TOTAL] ??= ZERO();
  return out;
}

const BRAND_LABEL: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  jcb: "JCB",
  diners: "Diners Club",
  unionpay: "UnionPay",
  unknown: "Unknown",
};
export const cardTypeLabel = (brand: string, funding: string) => `${BRAND_LABEL[brand] ?? brand} ${funding === "unknown" ? "(funding unknown)" : funding}`;

const money = (label: string): Column => ({ label, kind: "money" });
const int = (label: string): Column => ({ label, kind: "int" });
const text = (label: string): Column => ({ label });
const rate = (label: string): Column => ({ label, kind: "pct" });

const COLUMNS: Column[] = [
  int("Card charges"),
  int("Surcharged"),
  money("Amount surcharged"),
  money("Surcharges charged"),
  money("Surcharges refunded"),
  money("Surcharges collected"),
  int("Waivers"),
  money("Surcharges waived"),
  rate("Effective rate"),
  money("Processing cost"),
  money("Net cost recovery"),
  rate("Cost recovered"),
];
const cells = (t: FeeTotals): Cell[] => [
  t.charges,
  t.surcharged,
  t.basisCents,
  t.feeChargedCents,
  t.feeRefundedCents,
  t.feeCents,
  t.waivers,
  t.waivedCents,
  effectiveRate(t),
  t.costCents,
  t.feeCents - t.costCents,
  recovery(t),
];
/** Rates in merged, subtotal and total rows come from the summed amounts, never by adding rates. */
function derive(offset: number) {
  return (c: Cell[]) => {
    const n = (i: number) => (typeof c[offset + i] === "number" ? (c[offset + i] as number) : 0);
    const out = [...c];
    out[offset + 8] = n(2) ? n(3) / n(2) : null;
    out[offset + 11] = n(9) ? n(5) / n(9) : null;
    return out;
  };
}

function grouped(fine: Fine[], keyOf: (r: Fine) => string): Map<string, FeeTotals> {
  const out = new Map<string, FeeTotals>();
  for (const r of fine) add(out.get(keyOf(r)) ?? out.set(keyOf(r), ZERO()).get(keyOf(r))!, r);
  return out;
}

function plainTable(id: string, title: string, subtitle: string, label: string, groups: Map<string, FeeTotals>, name: (k: string) => string): ReportTable {
  const all = ZERO();
  const entries = [...groups.entries()].sort((a, b) => b[1].feeCents - a[1].feeCents || name(a[0]).localeCompare(name(b[0])));
  for (const [, t] of entries) for (const k of Object.keys(all) as (keyof FeeTotals)[]) all[k] += t[k];
  return {
    id,
    title,
    subtitle,
    columns: [text(label), ...COLUMNS],
    rows: [...entries.map(([k, t]) => [name(k), ...cells(t)]), ["Total", ...cells(all)]],
    rowStyles: [...entries.map(() => undefined), "total" as const],
  };
}

export async function cardFeeReportData(scope: ReportScope, loc: ViewCtx) {
  const fine = await cardFeeRows(scope);
  const at = feeTotalsAt(fine, loc);
  const t = at[TOTAL];
  const m = (label: string, kind: Metric["kind"], f: (x: FeeTotals) => number | null, additive?: boolean): Metric => ({
    label,
    kind,
    at: Object.fromEntries(Object.entries(at).map(([k, v]) => [k, f(v)])),
    additive,
  });
  const summary = metricTable(loc, {
    id: "summary",
    title: `Card surcharges${{ combined: "", shops: " by location", barbers: " by barber", shops_barbers: " by location and barber" }[viewOf(loc)]}`,
    subtitle:
      "Collected is after surcharge refunds. The effective rate is what was charged over the amounts it was charged on. Net cost recovery is collected less the processing cost of every card charge.",
    metrics: [
      m("Card charges", "int", (x) => x.charges),
      m("Card takings", "money", (x) => x.amountCents),
      m("Surcharged charges", "int", (x) => x.surcharged),
      m("Surcharges charged", "money", (x) => x.feeChargedCents),
      m("Surcharges refunded", "money", (x) => x.feeRefundedCents),
      m("Surcharges collected", "money", (x) => x.feeCents),
      m("Waivers", "int", (x) => x.waivers),
      m("Surcharges waived", "money", (x) => x.waivedCents),
      m("Amount surcharged", "money", (x) => x.basisCents),
      m("Effective rate", "pct", effectiveRate, false),
      m("Processing cost (all card charges)", "money", (x) => x.costCents),
      m("Processing cost (surcharged charges)", "money", (x) => x.costSurchargedCents),
      m("Net cost recovery", "money", (x) => x.feeCents - x.costCents),
      m("Cost recovered", "pct", recovery, false),
    ],
  });
  const byDay = new Map<string, Fine[]>();
  for (const r of fine) byDay.set(`${r.shop_id}|${r.staff_id ?? NO_BARBER}|${r.day}`, [...(byDay.get(`${r.shop_id}|${r.staff_id ?? NO_BARBER}|${r.day}`) ?? []), r]);
  const daily = listTable(loc, {
    id: "daily",
    title: "By day",
    columns: [text("Date"), ...COLUMNS],
    rows: [...byDay.values()].map((rs) => {
      const tt = ZERO();
      rs.forEach((r) => add(tt, r));
      return { shopId: rs[0].shop_id, staffId: rs[0].staff_id, key: rs[0].day, cells: [rs[0].day, ...cells(tt)] };
    }),
    merge: true,
    derive: derive(1),
    sort: (a, b) => String(a[0]).localeCompare(String(b[0])),
  });
  const channels = plainTable(
    "channels",
    "By channel",
    "Where the charge was taken. Charges from before channels were recorded count as POS.",
    "Channel",
    grouped(fine, (r) => r.channel),
    (k) => FEE_CHANNEL_LABEL[k as FeeChannel] ?? k,
  );
  const cardTypes = plainTable(
    "card_types",
    "By card type",
    "Only credit cards carry the surcharge; debit and prepaid show their processing cost with none recovered.",
    "Card type",
    grouped(fine, (r) => `${r.brand}|${r.funding}`),
    (k) => cardTypeLabel(k.split("|")[0], k.split("|")[1]),
  );
  return {
    stats: [
      {
        label: "Surcharges collected",
        value: formatCents(t.feeCents),
        hint: `${t.surcharged} of ${t.charges} card charges${t.feeRefundedCents ? `, after ${formatCents(t.feeRefundedCents)} refunded` : ""}`,
      },
      { label: "Waived", value: formatCents(t.waivedCents), hint: `${t.waivers} waiver${t.waivers === 1 ? "" : "s"}` },
      { label: "Effective rate", value: effectiveRate(t) === null ? "—" : `${((effectiveRate(t) ?? 0) * 100).toFixed(2)}%`, hint: `on ${formatCents(t.basisCents)} surcharged` },
      {
        label: "Net cost recovery",
        value: formatCents(t.feeCents - t.costCents),
        hint: t.costCents ? `${Math.round((recovery(t) ?? 0) * 100)}% of ${formatCents(t.costCents)} processing cost` : "no processing cost recorded",
        tone: t.feeCents - t.costCents >= 0 ? ("up" as const) : ("down" as const),
      },
    ],
    tables: [summary, daily, channels, cardTypes],
    fine,
  };
}

export interface FeePaymentRow {
  id: string;
  shopId: string;
  staffId: string | null;
  day: string;
  ticket: number;
  channel: string;
  brand: string | null;
  last4: string | null;
  funding: string | null;
  wallet: string | null;
  status: string;
  amountCents: number;
  tipCents: number;
  feeCents: number;
  feeRate: number | null;
  feeFlatCents: number | null;
  feeBasis: string | null;
  feeBasisCents: number | null;
  feeReason: string | null;
  waived: boolean;
  waivedCents: number;
  waivedBy: string | null;
  waivedReason: string | null;
  feeRefundedCents: number;
  costCents: number;
  settlement: string | null;
  stripeAccountId: string | null;
}

/** Every card payment in the range with how its surcharge was worked out: the payments export. */
export async function feePayments(s: ReportScope, limit = 20000): Promise<FeePaymentRow[]> {
  return rows<FeePaymentRow>(sql`
    select p.id, p.shop_id "shopId", s.staff_id "staffId", p.business_date::text as day, s.number ticket, coalesce(p.fee_channel, 'pos') channel,
      p.card_brand brand, p.card_last4 last4, p.card_funding funding, s.pricing->>'cardWallet' wallet, p.status::text status,
      p.amount_cents "amountCents", p.tip_cents "tipCents", p.card_fee_cents "feeCents", p.fee_rate::float8 "feeRate", p.fee_flat_cents "feeFlatCents",
      p.fee_basis "feeBasis", p.fee_basis_cents "feeBasisCents", p.fee_reason "feeReason", p.fee_waived waived, p.fee_waived_cents "waivedCents",
      st.display_label "waivedBy", p.fee_waived_reason "waivedReason",
      coalesce((select sum(r.card_fee_cents) from refunds r where r.payment_id = p.id and r.kind = 'refund'), 0)::int "feeRefundedCents",
      ${COST}::int "costCents", p.settlement, p.stripe_account_id "stripeAccountId"
    from payments p join sales s on s.id = p.sale_id left join staff st on st.id = p.fee_waived_by
    where p.method = 'card' and p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and p.status not in ('pending', 'failed')
    ${staffFilter(sql`s.staff_id`, s)}
    order by p.business_date, s.number, p.created_at
    limit ${limit}`);
}

export const FEE_REASON_LABEL: Record<string, string> = {
  applies: "Charged",
  waived: "Waived",
  not_credit: "Not a credit card",
  wallet_fee_off: "Wallet (off)",
  channel_off: "Channel off",
  state_not_allowed: "State not allowed",
  disabled: "Fee off",
  zero_amount: "Nothing to charge",
};
