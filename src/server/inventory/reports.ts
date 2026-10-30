import { sql, SQL } from "drizzle-orm";
import { db } from "@/db";
import { LocalDate, endOfLocalDay, startOfLocalDay, todayLocal } from "@/lib/time";

/**
 * Inventory and purchasing reports, all read from the ledger and purchase orders. Every query
 * returns rows per shop (and product or vendor); the report builders combine shops.
 */
export interface InvScope {
  shopIds: string[];
  from: LocalDate;
  to: LocalDate;
}

const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const range = (s: InvScope) => ({ start: startOfLocalDay(s.from).toISOString(), end: endOfLocalDay(s.to).toISOString() });

async function rows<T>(q: SQL): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

export interface ValuationRow {
  shopId: string;
  productId: string;
  sku: string;
  product: string;
  category: string;
  onHand: number;
  costCents: number;
  priceCents: number;
  valueCents: number;
  retailCents: number;
  onOrder: number;
  onOrderCents: number;
}

/**
 * Stock at the end of the range (today's stock less anything posted after it), valued at the shelf
 * cost today and at the shop's price. Negative stock counts as zero.
 */
export async function valuation(s: InvScope) {
  const { end } = range(s);
  return rows<ValuationRow>(sql`
    with later as (
      select shop_id, product_id, sum(delta)::int n from inventory_ledger
      where shop_id in ${uuids(s.shopIds)} and created_at >= ${end}
      group by 1, 2
    ), ordered as (
      select po.shop_id, l.product_id, sum(greatest(l.qty_ordered - l.qty_received, 0))::int n, sum(greatest(l.qty_ordered - l.qty_received, 0) * l.unit_cost_cents)::int cents
      from purchase_order_lines l join purchase_orders po on po.id = l.purchase_order_id
      where po.status in ('approved', 'sent', 'partially_received') and po.shop_id in ${uuids(s.shopIds)}
      group by 1, 2
    ), at_end as (
      select sp.shop_id, sp.product_id, sp.stock - coalesce(later.n, 0) on_hand, sp.cost_cents, sp.price_cents, sp.active
      from shop_products sp left join later on later.shop_id = sp.shop_id and later.product_id = sp.product_id
      where sp.shop_id in ${uuids(s.shopIds)}
    )
    select e.shop_id "shopId", p.id "productId", p.sku, (p.brand || ' ' || p.name) product, p.category, e.on_hand "onHand", e.cost_cents "costCents", e.price_cents "priceCents",
      (greatest(e.on_hand, 0) * e.cost_cents)::int "valueCents", (greatest(e.on_hand, 0) * e.price_cents)::int "retailCents",
      coalesce(o.n, 0) "onOrder", coalesce(o.cents, 0) "onOrderCents"
    from at_end e join products p on p.id = e.product_id
      left join ordered o on o.shop_id = e.shop_id and o.product_id = e.product_id
    where e.active or e.on_hand <> 0 or o.n > 0
    order by p.category, p.brand, p.name`);
}

export interface MovementRow {
  shopId: string;
  productId: string;
  sku: string;
  product: string;
  opening: number;
  received: number;
  sold: number;
  returned: number;
  transferIn: number;
  transferOut: number;
  damaged: number;
  theft: number;
  backBar: number;
  found: number;
  countVariance: number;
  other: number;
  closing: number;
  lostInTransit: number;
  /** At the cost on each ledger entry. */
  shrinkCents: number;
  backBarCents: number;
  costCents: number;
}

/**
 * Opening + received + returned + transfers in − sold − transfers out − damaged − theft − back bar
 * + found + count variance + other = closing, for every product at every shop, straight from the
 * ledger. Shrink is what went missing or was ruined: damage, theft, net count losses (a count that
 * finds extra reduces it) and transfers that didn't fully arrive.
 */
export async function movement(s: InvScope) {
  const { start, end } = range(s);
  return rows<MovementRow>(sql`
    with l as (
      select shop_id, product_id,
        sum(delta) filter (where created_at < ${start})::int opening,
        sum(delta) filter (where created_at < ${end})::int closing,
        sum(delta) filter (where kind = 'receive' and created_at >= ${start} and created_at < ${end})::int received,
        sum(-delta) filter (where kind = 'sale' and created_at >= ${start} and created_at < ${end})::int sold,
        sum(delta) filter (where kind in ('refund', 'void') and created_at >= ${start} and created_at < ${end})::int returned,
        sum(delta) filter (where kind = 'transfer_in' and created_at >= ${start} and created_at < ${end})::int transfer_in,
        sum(-delta) filter (where kind = 'transfer_out' and created_at >= ${start} and created_at < ${end})::int transfer_out,
        sum(-delta) filter (where kind = 'adjust' and reason = 'damage' and created_at >= ${start} and created_at < ${end})::int damaged,
        sum(-delta) filter (where kind = 'adjust' and reason = 'theft' and created_at >= ${start} and created_at < ${end})::int theft,
        sum(-delta) filter (where kind = 'adjust' and reason = 'back_bar' and created_at >= ${start} and created_at < ${end})::int back_bar,
        sum(delta) filter (where kind = 'adjust' and reason = 'found' and created_at >= ${start} and created_at < ${end})::int found,
        sum(delta) filter (where (kind = 'stocktake' or (kind = 'adjust' and reason = 'count_correction')) and created_at >= ${start} and created_at < ${end})::int count_variance,
        sum(delta) filter (where (kind in ('opening', 'upload') or (kind = 'adjust' and reason = 'other')) and created_at >= ${start} and created_at < ${end})::int other,
        sum(-delta * coalesce(unit_cost_cents, 0)) filter (where (kind = 'stocktake' or (kind = 'adjust' and reason in ('damage', 'theft', 'count_correction', 'found'))) and created_at >= ${start} and created_at < ${end})::int shrink_cents,
        sum(-delta * coalesce(unit_cost_cents, 0)) filter (where kind = 'adjust' and reason = 'back_bar' and created_at >= ${start} and created_at < ${end})::int back_bar_cents
      from inventory_ledger
      where shop_id in ${uuids(s.shopIds)} and created_at < ${end}
      group by 1, 2
    ), lost as (
      select t.from_shop_id shop_id, tl.product_id, sum(tl.qty - tl.qty_received)::int n, sum((tl.qty - tl.qty_received) * coalesce(tl.unit_cost_cents, 0))::int cents
      from stock_transfer_lines tl join stock_transfers t on t.id = tl.transfer_id
      where t.status = 'received' and t.from_shop_id in ${uuids(s.shopIds)} and t.received_at >= ${start} and t.received_at < ${end} and tl.qty_received < tl.qty
      group by 1, 2
    )
    select sp.shop_id "shopId", p.id "productId", p.sku, (p.brand || ' ' || p.name) product,
      coalesce(l.opening, 0) opening, coalesce(l.received, 0) received, coalesce(l.sold, 0) sold, coalesce(l.returned, 0) returned,
      coalesce(l.transfer_in, 0) "transferIn", coalesce(l.transfer_out, 0) "transferOut", coalesce(l.damaged, 0) damaged, coalesce(l.theft, 0) theft,
      coalesce(l.back_bar, 0) "backBar", coalesce(l.found, 0) found, coalesce(l.count_variance, 0) "countVariance", coalesce(l.other, 0) other,
      coalesce(l.closing, 0) closing, coalesce(lost.n, 0) "lostInTransit",
      (coalesce(l.shrink_cents, 0) + coalesce(lost.cents, 0))::int "shrinkCents", coalesce(l.back_bar_cents, 0) "backBarCents", sp.cost_cents "costCents"
    from shop_products sp
      join products p on p.id = sp.product_id
      left join l on l.shop_id = sp.shop_id and l.product_id = sp.product_id
      left join lost on lost.shop_id = sp.shop_id and lost.product_id = sp.product_id
    where sp.shop_id in ${uuids(s.shopIds)} and (sp.active or l.opening <> 0 or l.closing <> 0 or l.closing is distinct from l.opening)
    order by p.brand, p.name`);
}

export interface LedgerEntry {
  shopId: string;
  at: string;
  sku: string;
  product: string;
  kind: string;
  reason: string | null;
  delta: number;
  balanceAfter: number;
  unitCostCents: number | null;
  ref: string | null;
  note: string | null;
  by: string | null;
}

/** Ledger entries in the range, newest first, with what they came from. */
export async function ledgerEntries(s: InvScope, o: { productId?: string; limit?: number } = {}) {
  const { start, end } = range(s);
  return rows<LedgerEntry>(sql`
    select l.shop_id "shopId", l.created_at at, p.sku, (p.brand || ' ' || p.name) product, l.kind, l.reason, l.delta, l.balance_after "balanceAfter", l.unit_cost_cents "unitCostCents",
      coalesce('PO-' || po.number, 'TR-' || tr.number, 'C-' || c.number, '#' || sa.number) ref, l.note, st.display_label by
    from inventory_ledger l
      join products p on p.id = l.product_id
      left join purchase_orders po on po.id = l.purchase_order_id
      left join stock_transfers tr on tr.id = l.transfer_id
      left join stock_counts c on c.id = l.count_id
      left join sales sa on sa.id = l.sale_id
      left join staff st on st.id = l.staff_id
    where l.shop_id in ${uuids(s.shopIds)} and l.created_at >= ${start} and l.created_at < ${end}
      ${o.productId ? sql`and l.product_id = ${o.productId}` : sql``}
    order by l.seq desc
    limit ${o.limit ?? 2000}`);
}

export interface SellThroughRow {
  shopId: string;
  productId: string;
  sku: string;
  product: string;
  category: string;
  opening: number;
  receivedIn: number;
  soldNet: number;
  closing: number;
  onHandNow: number;
  netSalesCents: number;
  cogsCents: number;
}

/** Units sold (less returns) against what was available to sell: opening stock plus what came in. */
export async function sellThrough(s: InvScope) {
  const { start, end } = range(s);
  return rows<SellThroughRow>(sql`
    with l as (
      select shop_id, product_id,
        sum(delta) filter (where created_at < ${start})::int opening,
        sum(delta) filter (where created_at < ${end})::int closing,
        sum(delta) filter (where kind in ('receive', 'transfer_in') and created_at >= ${start} and created_at < ${end})::int received_in,
        sum(-delta) filter (where kind in ('sale', 'refund', 'void') and created_at >= ${start} and created_at < ${end})::int sold_net,
        sum(-delta * coalesce(unit_cost_cents, 0)) filter (where kind in ('sale', 'refund', 'void') and created_at >= ${start} and created_at < ${end})::int cogs
      from inventory_ledger
      where shop_id in ${uuids(s.shopIds)} and created_at < ${end}
      group by 1, 2
    ), money as (
      select s.shop_id, si.ref_id product_id, sum(si.net_cents - round(si.net_cents::numeric * si.refunded_qty / greatest(si.qty, 1)))::int cents
      from sale_items si join sales s on s.id = si.sale_id
      where si.kind = 'product' and s.status in ('paid', 'refunded', 'partially_refunded') and s.shop_id in ${uuids(s.shopIds)}
        and s.business_date between ${s.from} and ${s.to}
      group by 1, 2
    )
    select sp.shop_id "shopId", p.id "productId", p.sku, (p.brand || ' ' || p.name) product, p.category,
      coalesce(l.opening, 0) opening, coalesce(l.received_in, 0) "receivedIn", coalesce(l.sold_net, 0) "soldNet", coalesce(l.closing, 0) closing, sp.stock "onHandNow",
      coalesce(m.cents, 0) "netSalesCents", coalesce(l.cogs, 0) "cogsCents"
    from shop_products sp
      join products p on p.id = sp.product_id
      left join l on l.shop_id = sp.shop_id and l.product_id = sp.product_id
      left join money m on m.shop_id = sp.shop_id and m.product_id = sp.product_id
    where sp.shop_id in ${uuids(s.shopIds)} and (sp.active or l.sold_net <> 0 or l.received_in <> 0)
    order by p.brand, p.name`);
}

export interface VendorSpendRow {
  shopId: string;
  vendorId: string;
  vendor: string;
  ordersSent: number;
  orderedCents: number;
  receipts: number;
  unitsReceived: number;
  receivedCents: number;
  /** What receipts cost against the order price: positive is the vendor charging more. */
  costVarianceCents: number;
  onOrderCents: number;
  /** Days from sending to the first delivery, averaged over orders first received in the range. */
  leadDaysTotal: number;
  leadOrders: number;
  unitsOrderedClosed: number;
  unitsReceivedClosed: number;
}

/** Per vendor per shop: what was ordered (sent in the range), what arrived and at what cost, and what's still coming. */
export async function vendorSpend(s: InvScope) {
  const { start, end } = range(s);
  return rows<VendorSpendRow>(sql`
    with sent as (
      select po.shop_id, po.vendor_id, count(distinct po.id)::int n, coalesce(sum(l.qty_ordered * l.unit_cost_cents), 0)::int cents
      from purchase_orders po left join purchase_order_lines l on l.purchase_order_id = po.id
      where po.shop_id in ${uuids(s.shopIds)} and po.sent_at >= ${start} and po.sent_at < ${end}
      group by 1, 2
    ), got as (
      select po.shop_id, po.vendor_id, count(distinct r.id)::int n, sum(rl.qty)::int units, sum(rl.qty * rl.unit_cost_cents)::int cents,
        sum(rl.qty * (rl.unit_cost_cents - pl.unit_cost_cents))::int variance
      from po_receipts r join po_receipt_lines rl on rl.receipt_id = r.id join purchase_order_lines pl on pl.id = rl.line_id join purchase_orders po on po.id = r.purchase_order_id
      where po.shop_id in ${uuids(s.shopIds)} and r.received_at >= ${start} and r.received_at < ${end}
      group by 1, 2
    ), open as (
      select po.shop_id, po.vendor_id, sum(greatest(l.qty_ordered - l.qty_received, 0) * l.unit_cost_cents)::int cents
      from purchase_orders po join purchase_order_lines l on l.purchase_order_id = po.id
      where po.shop_id in ${uuids(s.shopIds)} and po.status in ('approved', 'sent', 'partially_received')
      group by 1, 2
    ), lead as (
      select po.shop_id, po.vendor_id, sum(extract(epoch from (f.first_at - po.sent_at)) / 86400)::float days, count(*)::int n
      from purchase_orders po join (select purchase_order_id, min(received_at) first_at from po_receipts group by 1) f on f.purchase_order_id = po.id
      where po.shop_id in ${uuids(s.shopIds)} and po.sent_at is not null and f.first_at >= ${start} and f.first_at < ${end}
      group by 1, 2
    ), fill as (
      select po.shop_id, po.vendor_id, sum(l.qty_ordered)::int ordered, sum(least(l.qty_received, l.qty_ordered))::int received
      from purchase_orders po join purchase_order_lines l on l.purchase_order_id = po.id
      where po.shop_id in ${uuids(s.shopIds)} and po.status = 'received' and po.received_at >= ${start} and po.received_at < ${end}
      group by 1, 2
    ), keys as (
      select shop_id, vendor_id from sent union select shop_id, vendor_id from got union select shop_id, vendor_id from open union select shop_id, vendor_id from fill
    )
    select k.shop_id "shopId", v.id "vendorId", v.name vendor,
      coalesce(sent.n, 0) "ordersSent", coalesce(sent.cents, 0) "orderedCents", coalesce(got.n, 0) receipts, coalesce(got.units, 0) "unitsReceived",
      coalesce(got.cents, 0) "receivedCents", coalesce(got.variance, 0) "costVarianceCents", coalesce(open.cents, 0) "onOrderCents",
      coalesce(lead.days, 0) "leadDaysTotal", coalesce(lead.n, 0) "leadOrders", coalesce(fill.ordered, 0) "unitsOrderedClosed", coalesce(fill.received, 0) "unitsReceivedClosed"
    from keys k join vendors v on v.id = k.vendor_id
      left join sent on sent.shop_id = k.shop_id and sent.vendor_id = k.vendor_id
      left join got on got.shop_id = k.shop_id and got.vendor_id = k.vendor_id
      left join open on open.shop_id = k.shop_id and open.vendor_id = k.vendor_id
      left join lead on lead.shop_id = k.shop_id and lead.vendor_id = k.vendor_id
      left join fill on fill.shop_id = k.shop_id and fill.vendor_id = k.vendor_id
    order by v.name`);
}

export interface PoHistoryRow {
  shopId: string;
  number: number;
  status: string;
  vendor: string;
  createdOn: string;
  sentOn: string | null;
  expectedOn: string | null;
  receivedOn: string | null;
  lines: number;
  units: number;
  unitsReceived: number;
  orderedCents: number;
  receivedCents: number;
  closedShort: boolean;
}

/** Orders created, sent or received in the range. */
export async function poHistory(s: InvScope) {
  const { start, end } = range(s);
  return rows<PoHistoryRow>(sql`
    select po.shop_id "shopId", po.number, po.status, v.name vendor,
      to_char(po.created_at at time zone 'America/Chicago', 'YYYY-MM-DD') "createdOn",
      to_char(po.sent_at at time zone 'America/Chicago', 'YYYY-MM-DD') "sentOn",
      po.expected_on::text "expectedOn",
      to_char(po.received_at at time zone 'America/Chicago', 'YYYY-MM-DD') "receivedOn",
      count(l.id)::int lines, coalesce(sum(l.qty_ordered), 0)::int units, coalesce(sum(l.qty_received), 0)::int "unitsReceived",
      coalesce(sum(l.qty_ordered * l.unit_cost_cents), 0)::int "orderedCents",
      coalesce((select sum(rl.qty * rl.unit_cost_cents) from po_receipts r join po_receipt_lines rl on rl.receipt_id = r.id where r.purchase_order_id = po.id), 0)::int "receivedCents",
      po.closed_short "closedShort"
    from purchase_orders po join vendors v on v.id = po.vendor_id left join purchase_order_lines l on l.purchase_order_id = po.id
    where po.shop_id in ${uuids(s.shopIds)}
      and ((po.created_at >= ${start} and po.created_at < ${end}) or (po.sent_at >= ${start} and po.sent_at < ${end}) or (po.received_at >= ${start} and po.received_at < ${end})
        or exists (select 1 from po_receipts r where r.purchase_order_id = po.id and r.received_at >= ${start} and r.received_at < ${end}))
    group by po.id, v.name
    order by po.number desc
    limit 2000`);
}

export const isCurrent = (s: InvScope) => s.to >= todayLocal();
