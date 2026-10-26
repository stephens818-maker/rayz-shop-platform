import "server-only";
import { sql } from "drizzle-orm";
import type { Cell, ReportTable } from "@/domain/report-views";
import { ReportScope, ids, rows, staffFilter } from "./report-sql";

/**
 * A QuickBooks Online journal entry per location per day, in QuickBooks' journal entry import
 * layout (Journal No, Journal Date, Account, Debits, Credits, Description, Location). Map the
 * account names to your chart of accounts when importing. Sales post on the day they were paid and
 * refunds on the day they were given. The credit card surcharge has its own income account, apart
 * from service and product revenue, tips and tax.
 */
export const QBO_ACCOUNTS = {
  card: "Undeposited Funds - Card",
  cash: "Undeposited Funds - Cash",
  giftCard: "Gift Card Liability",
  services: "Service Revenue",
  products: "Product Sales",
  tax: "Sales Tax Payable",
  tips: "Tips Payable",
  surcharge: "Credit Card Surcharge Income",
  processing: "Merchant Processing Fees",
  difference: "Ask My Accountant",
} as const;

interface DayRow {
  shop_id: string;
  shop: string;
  slug: string;
  day: string;
  sn: number;
  pn: number;
  gc: number;
  tax: number;
  tips: number;
  fee: number;
  r_sn: number;
  r_pn: number;
  r_gc: number;
  r_tax: number;
  r_tips: number;
  r_fee: number;
  card: number;
  cash: number;
  gift: number;
  r_card: number;
  r_cash: number;
  r_gift: number;
  cost: number;
}

export async function quickbooksDays(s: ReportScope): Promise<DayRow[]> {
  const sf = staffFilter(sql`s.staff_id`, s);
  return rows<DayRow>(sql`
    with sale as (
      select s.shop_id, s.business_date day, sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn, sum(s.gift_card_sales_cents)::int gc,
        sum(s.service_tax_cents + s.product_tax_cents)::int tax, sum(s.tip_cents)::int tips, sum(s.card_fee_cents)::int fee
      from sales s where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ('paid', 'refunded', 'partially_refunded') ${sf}
      group by 1, 2
    ), ref as (
      select r.shop_id, r.business_date day, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.gift_card_sales_cents)::int gc,
        sum(r.tax_cents)::int tax, sum(r.tip_cents)::int tips, sum(r.card_fee_cents)::int fee,
        coalesce(sum(r.amount_cents) filter (where r.method = 'card'), 0)::int card, coalesce(sum(r.amount_cents) filter (where r.method = 'cash'), 0)::int cash,
        coalesce(sum(r.amount_cents) filter (where r.method = 'gift_card'), 0)::int gift
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund' ${sf}
      group by 1, 2
    ), pay as (
      select p.shop_id, p.business_date day,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.status <> 'voided'), 0)::int card,
        coalesce(sum(p.amount_cents) filter (where p.method = 'cash' and p.status <> 'voided'), 0)::int cash,
        coalesce(sum(p.amount_cents) filter (where p.method = 'gift_card' and p.status <> 'voided'), 0)::int gift,
        coalesce(sum(coalesce(nullif(p.processor_fee_cents, 0), p.application_fee_cents, 0)) filter (where p.method = 'card'), 0)::int cost
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and p.status not in ('pending', 'failed') and s.status <> 'voided' ${sf}
      group by 1, 2
    ), days as (select shop_id, day from sale union select shop_id, day from ref union select shop_id, day from pay)
    select d.shop_id, sh.name shop, sh.slug, d.day::text day,
      coalesce(sale.sn, 0) sn, coalesce(sale.pn, 0) pn, coalesce(sale.gc, 0) gc, coalesce(sale.tax, 0) tax, coalesce(sale.tips, 0) tips, coalesce(sale.fee, 0) fee,
      coalesce(ref.sn, 0) r_sn, coalesce(ref.pn, 0) r_pn, coalesce(ref.gc, 0) r_gc, coalesce(ref.tax, 0) r_tax, coalesce(ref.tips, 0) r_tips, coalesce(ref.fee, 0) r_fee,
      coalesce(pay.card, 0) card, coalesce(pay.cash, 0) cash, coalesce(pay.gift, 0) gift,
      coalesce(ref.card, 0) r_card, coalesce(ref.cash, 0) r_cash, coalesce(ref.gift, 0) r_gift, coalesce(pay.cost, 0) cost
    from days d join shops sh on sh.id = d.shop_id
    left join sale on sale.shop_id = d.shop_id and sale.day = d.day
    left join ref on ref.shop_id = d.shop_id and ref.day = d.day
    left join pay on pay.shop_id = d.shop_id and pay.day = d.day
    order by d.day, sh.name`);
}

const usDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

/** The lines of one day's entry: [account, debit, credit, description]. Debits equal credits; any gap goes to the difference account. */
export function journalLines(r: DayRow): [string, number, number, string][] {
  const A = QBO_ACCOUNTS;
  const out: [string, number, number, string][] = [];
  const line = (account: string, net: number, side: "debit" | "credit", what: string) => {
    if (!net) return;
    const debit = side === "debit" ? net > 0 : net < 0;
    out.push([account, debit ? Math.abs(net) : 0, debit ? 0 : Math.abs(net), what]);
  };
  line(A.card, r.card - r.r_card, "debit", "Card takings less card refunds");
  line(A.cash, r.cash - r.r_cash, "debit", "Cash takings less cash refunds");
  line(A.giftCard, r.gift - r.r_gift, "debit", "Gift cards redeemed");
  line(A.services, r.sn - r.r_sn, "credit", "Services, after discounts and refunds");
  line(A.products, r.pn - r.r_pn, "credit", "Retail, after discounts and refunds");
  line(A.giftCard, r.gc - r.r_gc, "credit", "Gift cards sold");
  line(A.tax, r.tax - r.r_tax, "credit", "Sales tax collected");
  line(A.tips, r.tips - r.r_tips, "credit", "Tips owed to staff");
  line(A.surcharge, r.fee - r.r_fee, "credit", "Credit card surcharges, after refunds");
  line(A.processing, r.cost, "debit", "Card processing cost");
  line(A.card, r.cost, "credit", "Card processing cost, kept from payouts");
  const gap = out.reduce((a, l) => a + l[1] - l[2], 0);
  if (gap) out.push([A.difference, gap < 0 ? -gap : 0, gap > 0 ? gap : 0, "Timing difference: paid on another day than rung up, or a refund to another tender"]);
  return out;
}

export async function quickbooksTable(s: ReportScope): Promise<ReportTable> {
  const days = await quickbooksDays(s);
  const out: Cell[][] = [];
  for (const d of days) {
    const no = `RAYZ-${d.slug.toUpperCase()}-${d.day.replaceAll("-", "")}`;
    for (const [account, debit, credit, what] of journalLines(d)) out.push([no, usDate(d.day), account, debit || null, credit || null, what, d.shop]);
  }
  return {
    id: "quickbooks",
    title: "QuickBooks journal",
    subtitle: "One journal entry per location per day for QuickBooks Online's journal entry import. Map the account names to yours when importing.",
    exportOnly: true,
    downloadLabel: "Download QuickBooks journal CSV",
    columns: [{ label: "Journal No" }, { label: "Journal Date" }, { label: "Account" }, { label: "Debits", kind: "money" }, { label: "Credits", kind: "money" }, { label: "Description" }, { label: "Location" }],
    rows: out,
  };
}
