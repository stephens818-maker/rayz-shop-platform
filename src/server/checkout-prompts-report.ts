import "server-only";
import { sql } from "drizzle-orm";
import { type ColumnKind, type ListRow, type Metric, TOTAL, type ViewCtx, listTable, metricTable, viewOf } from "@/domain/report-views";
import { rate } from "@/domain/checkout-prompts";
import { formatCents } from "@/lib/money";
import type { ReportData } from "./report-data";
import { type Grain, PAID, type ReportScope, atGrains, grainsFor, grp, ids, keyOf, rows, sgrp, staffFilter } from "./report-sql";

/**
 * The checkout prompts on paid tickets, by the day the ticket was paid, its location and its
 * barber: how often the rebook prompt booked the next visit, and how often the product prompt put
 * a product on the ticket that was paid for.
 */

export interface PromptCounts {
  rebookShown: number;
  rebookAccepted: number;
  rebookDeclined: number;
  rebookSkipped: number;
  reminders: number;
  productShown: number;
  productAccepted: number;
  productPaid: number;
  productsPaid: number;
  productCents: number;
}

const ZERO: PromptCounts = { rebookShown: 0, rebookAccepted: 0, rebookDeclined: 0, rebookSkipped: 0, reminders: 0, productShown: 0, productAccepted: 0, productPaid: 0, productsPaid: 0, productCents: 0 };

async function countsBy(s: ReportScope, o: Grain): Promise<Map<string, PromptCounts>> {
  const r = await rows<{ shop_id: string | null; staff_id: string | null } & Record<string, number>>(sql`
    select ${grp(o, sql`p.shop_id`)} shop_id, ${sgrp(o, sql`p.staff_id`)} staff_id,
      count(*) filter (where p.prompt = 'rebook')::int rebook_shown,
      count(*) filter (where p.prompt = 'rebook' and p.outcome = 'accepted')::int rebook_accepted,
      count(*) filter (where p.prompt = 'rebook' and p.outcome = 'declined' and not p.skipped)::int rebook_declined,
      count(*) filter (where p.prompt = 'rebook' and p.skipped)::int rebook_skipped,
      count(*) filter (where p.prompt = 'rebook' and p.reminder_id is not null)::int reminders,
      count(*) filter (where p.prompt = 'product')::int product_shown,
      count(*) filter (where p.prompt = 'product' and p.outcome = 'accepted')::int product_accepted,
      count(*) filter (where p.prompt = 'product' and cardinality(p.paid_product_ids) > 0)::int product_paid,
      coalesce(sum(cardinality(p.paid_product_ids)) filter (where p.prompt = 'product'), 0)::int products_paid,
      coalesce(sum(p.paid_product_cents) filter (where p.prompt = 'product'), 0)::int product_cents
    from checkout_prompts p join sales x on x.id = p.sale_id
    where p.shop_id in ${ids(s)} and x.status in ${PAID} and x.business_date between ${s.from} and ${s.to} ${staffFilter(sql`p.staff_id`, s)}
    group by 1, 2`);
  return new Map(
    r.map((x) => [
      keyOf(x),
      {
        rebookShown: x.rebook_shown,
        rebookAccepted: x.rebook_accepted,
        rebookDeclined: x.rebook_declined,
        rebookSkipped: x.rebook_skipped,
        reminders: x.reminders,
        productShown: x.product_shown,
        productAccepted: x.product_accepted,
        productPaid: x.product_paid,
        productsPaid: x.products_paid,
        productCents: x.product_cents,
      },
    ]),
  );
}

export const promptCountsAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => countsBy(s, g));

export async function declineReasons(s: ReportScope, o: Grain) {
  return rows<{ shop_id: string | null; staff_id: string | null; reason: string; n: number }>(sql`
    select ${grp(o, sql`p.shop_id`)} shop_id, ${sgrp(o, sql`p.staff_id`)} staff_id, coalesce(p.decline_reason, case when p.skipped then 'Paid without answering' else 'No reason given' end) reason, count(*)::int n
    from checkout_prompts p join sales x on x.id = p.sale_id
    where p.prompt = 'rebook' and p.outcome = 'declined' and p.shop_id in ${ids(s)} and x.status in ${PAID} and x.business_date between ${s.from} and ${s.to} ${staffFilter(sql`p.staff_id`, s)}
    group by 1, 2, 3 order by 4 desc`);
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export async function checkoutPromptsData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const [counts, reasons] = await Promise.all([promptCountsAt(scope, grainsFor(loc)), declineReasons(scope, { byShop: loc.view === "shops", byStaff: loc.byBarber })]);
  const m = (label: string, kind: ColumnKind, f: (x: PromptCounts) => number | null, additive?: boolean): Metric => ({
    label,
    kind,
    at: Object.fromEntries(Object.entries(counts).map(([k, x]) => [k, f(x)])),
    additive,
  });
  const t = counts[TOTAL] ?? ZERO;
  const named = viewOf(loc);
  const by = named === "combined" ? "" : named === "shops" ? " by location" : named === "barbers" ? " by barber" : " by location and barber";
  return {
    stats: [
      { label: "Rebook rate at checkout", value: pct(rate(t.rebookAccepted, t.rebookShown)), hint: `${t.rebookAccepted} of ${t.rebookShown} rebook prompts booked` },
      { label: "Product attach rate", value: pct(rate(t.productPaid, t.productShown)), hint: `${t.productPaid} of ${t.productShown} tickets paid with a suggested product` },
      { label: "Prompted product sales", value: formatCents(t.productCents), hint: `${t.productsPaid} products` },
      { label: "Rebook reminders set", value: String(t.reminders) },
    ],
    tables: [
      metricTable(loc, {
        id: "rebook",
        title: `Rebook prompt${by}`,
        subtitle: "Prompts on tickets paid in the range. Booked: the next visit was booked from the prompt, or some other way while it was up. Skipped: the ticket was paid without an answer (counted as declined).",
        metrics: [
          m("Rebook rate", "pct", (x) => rate(x.rebookAccepted, x.rebookShown)),
          m("Prompts shown", "int", (x) => x.rebookShown),
          m("Booked", "int", (x) => x.rebookAccepted),
          m("Declined", "int", (x) => x.rebookDeclined),
          m("Skipped", "int", (x) => x.rebookSkipped),
          m("Reminders set", "int", (x) => x.reminders),
        ],
      }),
      metricTable(loc, {
        id: "product",
        title: `Product prompt${by}`,
        subtitle: "Attach rate: tickets where a product added from the prompt was paid for, over the tickets it was shown on. Sales are those products' net, after discounts.",
        metrics: [
          m("Attach rate", "pct", (x) => rate(x.productPaid, x.productShown)),
          m("Prompts shown", "int", (x) => x.productShown),
          m("Product added", "int", (x) => x.productAccepted),
          m("Paid with a suggested product", "int", (x) => x.productPaid),
          m("Products paid", "int", (x) => x.productsPaid),
          m("Prompted product sales", "money", (x) => x.productCents),
        ],
      }),
      listTable(loc, {
        id: "reasons",
        title: `Why clients didn't rebook${by}`,
        columns: [{ label: "Reason" }, { label: "Times", kind: "int" }],
        rows: reasons.map((r): ListRow => ({ shopId: r.shop_id ?? loc.shops[0]?.id ?? "", staffId: loc.byBarber ? r.staff_id : undefined, key: r.reason, cells: [r.reason, r.n] })),
        merge: true,
      }),
    ],
    notes: ["Each prompt shown, taken and declined is also in the event log (Insights > Event log) as prompt.shown, prompt.accepted and prompt.declined."],
  };
}
