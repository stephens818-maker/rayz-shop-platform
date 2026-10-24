import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Column, Cell } from "@/domain/report-views";
import { type FeeTerms, type RoyaltyDay, type RoyaltyPeriod, bpsLabel, periodOf, royaltyStatement } from "@/domain/franchise";
import { formatCents } from "@/lib/money";
import { addDays, diffDays } from "@/lib/time";
import { type EntityViewer, entitiesWithin, entityReach } from "./hierarchy";
import { PAID, type ReportScope, rows, uuids } from "./report-sql";
import type { ReportData, ReportInput } from "./report-data";

/**
 * Owner-group reports: the royalty statement, the owner group P&L and the brand rollup comparing
 * locations, regions and owner groups. Sales count toward the owner of the day (shop_owner_history),
 * so a resold location's history stays with whoever owned it then.
 */

const money = (label: string): Column => ({ label, kind: "money" });
const int = (label: string): Column => ({ label, kind: "int" });
const text = (label: string): Column => ({ label });
const pctCol = (label: string): Column => ({ label, kind: "pct", sum: false });

function viewerOf(v: ReportInput["viewer"]): EntityViewer {
  return { brandWide: v.brandWide, scope: v.scope ?? v.access?.scope, scopeEntityId: v.scopeEntityId ?? v.access?.scopeEntityId, scopeRegionId: v.scopeRegionId ?? v.access?.scopeRegionId, shopIds: v.shopIds };
}

/**
 * The owner groups a report covers: those that owned a selected location during the range, and
 * that the viewer may see the finances of (the brand: all; others: owner groups whose every
 * location is theirs). A franchisee who bought a location doesn't see the seller's months.
 */
export async function reportEntities(scope: ReportScope, viewer: ReportInput["viewer"]) {
  if (!scope.shopIds.length) return [];
  const owned = await rows<{ id: string; name: string; kind: "brand" | "franchisee" }>(sql`
    select distinct oe.id, oe.name, oe.kind
    from shop_owner_history h join owner_entities oe on oe.id = h.owner_entity_id
    where h.shop_id in ${uuids(scope.shopIds)} and h.valid_from <= ${scope.to} and (h.valid_to is null or h.valid_to > ${scope.from})
    order by oe.kind, oe.name`);
  const v = viewerOf(viewer);
  if (entityReach(v) === null) return owned;
  const ok = new Set(await entitiesWithin(v));
  return owned.filter((o) => ok.has(o.id));
}

export interface OwnerDay extends RoyaltyDay {
  entityId: string;
  tickets: number;
  discountCents: number;
  serviceNetCents: number;
  productNetCents: number;
  taxCents: number;
  tipCents: number;
  refundCents: number;
  processingFeeCents: number;
}

/**
 * Each owner group's days over the scope: paid tickets (imported history left out), refunds, and
 * card charges' fees and collected royalty. Royalty base is services and products after discounts;
 * gift card sales owe when the card is spent, so they're not in it.
 */
export async function ownerDays(scope: ReportScope, entityIds: readonly string[]): Promise<OwnerDay[]> {
  if (!entityIds.length || !scope.shopIds.length) return [];
  const raw = await rows<Record<string, string | number>>(sql`
    with own as (
      select h.shop_id, h.owner_entity_id e, h.valid_from f, coalesce(h.valid_to, 'infinity'::date) t
      from shop_owner_history h
      where h.owner_entity_id in ${uuids([...entityIds])} and h.shop_id in ${uuids(scope.shopIds)}
        and h.valid_from <= ${scope.to} and (h.valid_to is null or h.valid_to > ${scope.from})
    ), x as (
      select o.e, s.business_date d, count(*)::bigint tickets, sum(s.service_gross_cents + s.product_gross_cents)::bigint gross,
        sum(s.discount_cents)::bigint disc, sum(s.service_net_cents)::bigint sn, sum(s.product_net_cents)::bigint pn,
        sum(s.service_tax_cents + s.product_tax_cents)::bigint tax, sum(s.tip_cents)::bigint tips,
        0::bigint rbase, 0::bigint refund, 0::bigint fees, 0::bigint roy, 0::bigint ad
      from sales s join own o on o.shop_id = s.shop_id and s.business_date >= o.f and s.business_date < o.t
      where s.shop_id in ${uuids(scope.shopIds)} and s.business_date between ${scope.from} and ${scope.to} and s.status in ${PAID} and not s.is_imported
      group by 1, 2
      union all
      select o.e, r.business_date, 0, 0, 0, 0, 0, 0, 0, sum(r.service_net_cents + r.product_net_cents), sum(r.amount_cents), 0, 0, 0
      from refunds r join sales s on s.id = r.sale_id join own o on o.shop_id = r.shop_id and r.business_date >= o.f and r.business_date < o.t
      where r.shop_id in ${uuids(scope.shopIds)} and r.business_date between ${scope.from} and ${scope.to} and r.kind = 'refund' and not s.is_imported
      group by 1, 2
      union all
      select o.e, p.business_date, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        sum(case when p.settlement = 'platform' then coalesce(p.processor_fee_cents, 0) else p.application_fee_cents - p.royalty_cents - p.ad_fund_cents end),
        sum(p.royalty_cents), sum(p.ad_fund_cents)
      from payments p join own o on o.shop_id = p.shop_id and p.business_date >= o.f and p.business_date < o.t
      where p.shop_id in ${uuids(scope.shopIds)} and p.business_date between ${scope.from} and ${scope.to} and p.method = 'card' and p.status not in ('pending', 'failed')
      group by 1, 2
    )
    select e::text "entityId", d::text "day", sum(tickets)::int tickets, sum(gross)::bigint gross, sum(disc)::bigint disc, sum(sn)::bigint sn, sum(pn)::bigint pn,
      sum(tax)::bigint tax, sum(tips)::bigint tips, sum(rbase)::bigint rbase, sum(refund)::bigint refund, sum(fees)::bigint fees, sum(roy)::bigint roy, sum(ad)::bigint ad
    from x group by 1, 2 order by 1, 2`);
  const n = (v: string | number) => Number(v ?? 0);
  return raw.map((r) => ({
    entityId: String(r.entityId),
    day: String(r.day),
    tickets: n(r.tickets),
    grossSalesCents: n(r.gross),
    discountCents: n(r.disc),
    serviceNetCents: n(r.sn),
    productNetCents: n(r.pn),
    baseCents: n(r.sn) + n(r.pn),
    taxCents: n(r.tax),
    tipCents: n(r.tips),
    refundBaseCents: n(r.rbase),
    refundCents: n(r.refund),
    processingFeeCents: n(r.fees),
    collectedRoyaltyCents: n(r.roy),
    collectedAdFundCents: n(r.ad),
  }));
}

async function termsFor(entityIds: readonly string[]): Promise<Map<string, FeeTerms[]>> {
  const out = new Map<string, FeeTerms[]>();
  if (!entityIds.length) return out;
  const r = await rows<{ entityId: string; effectiveFrom: string; royaltyBps: number; adFundBps: number; collect: FeeTerms["collect"] }>(sql`
    select owner_entity_id::text "entityId", effective_from::text "effectiveFrom", royalty_bps "royaltyBps", ad_fund_bps "adFundBps", collect
    from entity_fee_terms where owner_entity_id in ${uuids([...entityIds])} order by effective_from`);
  for (const t of r) out.set(t.entityId, [...(out.get(t.entityId) ?? []), t]);
  return out;
}

const ratesLabel = (rates: { royaltyBps: number; adFundBps: number }[]) => (rates.length ? rates.map((r) => `${bpsLabel(r.royaltyBps)} + ${bpsLabel(r.adFundBps)}`).join(" → ") : "No rates");

const PERIOD_CHOICES = [
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
];

export async function royaltyData({ scope, viewer, params }: ReportInput): Promise<ReportData> {
  const period: RoyaltyPeriod = params.period === "quarter" ? "quarter" : "month";
  const entities = await reportEntities(scope, viewer);
  const ids = entities.map((e) => e.id);
  const [days, terms] = await Promise.all([ownerDays(scope, ids), termsFor(ids)]);
  const cols = [
    text("Owner group"),
    text("Period"),
    money("Gross sales"),
    money("Royalty base"),
    money("Refunds on base"),
    money("Net base"),
    text("Rates (royalty + ad fund)"),
    money("Royalty due"),
    money("Ad fund due"),
    money("Royalty collected"),
    money("Ad fund collected"),
    money("Royalty balance"),
    money("Ad fund balance"),
  ];
  const out: Cell[][] = [];
  const styles: ("subtotal" | "total" | undefined)[] = [];
  const totals = royaltyStatement([], []);
  const add = (s: ReturnType<typeof royaltyStatement>) => {
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) if (typeof totals[k] === "number") (totals[k] as number) += s[k] as number;
  };
  const line = (s: ReturnType<typeof royaltyStatement>): Cell[] => [
    s.grossSalesCents,
    s.baseCents,
    s.refundBaseCents,
    s.netBaseCents,
    ratesLabel(s.rates),
    s.royaltyDueCents,
    s.adFundDueCents,
    s.collectedRoyaltyCents,
    s.collectedAdFundCents,
    s.royaltyBalanceCents,
    s.adFundBalanceCents,
  ];
  for (const e of entities) {
    const mine = days.filter((d) => d.entityId === e.id);
    const t = terms.get(e.id) ?? [];
    const periods = [...new Set(mine.map((d) => periodOf(d.day, period)))].sort();
    for (const p of periods) {
      out.push([e.name, p, ...line(royaltyStatement(mine.filter((d) => periodOf(d.day, period) === p), t))]);
      styles.push(undefined);
    }
    const all = royaltyStatement(mine, t);
    add(all);
    if (periods.length > 1) {
      out.push([`${e.name} total`, `${periods.length} periods`, ...line(all)]);
      styles.push("subtotal");
    }
  }
  if (entities.length > 1) {
    out.push(["All owner groups", null, ...line(totals)]);
    styles.push("total");
  }
  return {
    stats: [
      { label: "Royalty-eligible sales", value: formatCents(totals.netBaseCents), hint: `of ${formatCents(totals.grossSalesCents)} gross sales` },
      { label: "Royalty due", value: formatCents(totals.royaltyDueCents), hint: `${formatCents(totals.collectedRoyaltyCents)} collected through Stripe` },
      { label: "Ad fund due", value: formatCents(totals.adFundDueCents), hint: `${formatCents(totals.collectedAdFundCents)} collected through Stripe` },
      { label: "Balance to invoice", value: formatCents(totals.royaltyBalanceCents + totals.adFundBalanceCents), hint: "negative is a credit" },
    ],
    tables: [
      {
        id: "statement",
        title: `Royalty statement by owner group and ${period}`,
        subtitle:
          "Net base is services and products after discounts and refunds, before tax, tips, card fees and gift card sales, at each day's owner and rates. Collected is what Stripe application fees took on card charges; the balance is what's left to invoice.",
        columns: cols,
        rows: out,
        rowStyles: styles,
      },
    ],
    options: [{ param: "period", label: "Periods", value: period, choices: PERIOD_CHOICES }],
    notes: [
      ...(entities.length ? [] : ["No owner group whose finances you can see owned these locations in this range."]),
      "Refunds lower what's due on the day they're given. Stripe keeps application fees on refunded charges, so a refund after collection shows as a credit.",
      "Squire history imported before go-live isn't included.",
    ],
  };
}

export async function ownerPnlData({ scope, viewer }: ReportInput): Promise<ReportData> {
  const entities = await reportEntities(scope, viewer);
  const ids = entities.map((e) => e.id);
  const [days, terms, payouts] = await Promise.all([
    ownerDays(scope, ids),
    termsFor(ids),
    ids.length
      ? rows<{ entityId: string; paid: number; pending: number }>(sql`
          select coalesce(p.owner_entity_id, h.owner_entity_id)::text "entityId",
            coalesce(sum(p.amount_cents) filter (where p.status = 'paid'), 0)::bigint paid,
            coalesce(sum(p.amount_cents) filter (where p.status in ('pending', 'in_transit')), 0)::bigint pending
          from shop_payouts p
          left join shop_owner_history h on h.shop_id = p.shop_id and p.arrival_date >= h.valid_from and (h.valid_to is null or p.arrival_date < h.valid_to)
          where p.arrival_date between ${scope.from} and ${scope.to}
            and (p.owner_entity_id in ${uuids(ids)} or (p.shop_id in ${uuids(scope.shopIds)} and h.owner_entity_id in ${uuids(ids)}))
          group by 1`)
      : Promise.resolve([]),
  ]);
  const cols = [
    text("Owner group"),
    int("Tickets"),
    money("Gross sales"),
    money("Discounts"),
    money("Refunds"),
    money("Net services"),
    money("Net products"),
    money("Net sales"),
    money("Tax collected"),
    money("Tips (staff's)"),
    money("Processing fees"),
    money("Royalty due"),
    money("Ad fund due"),
    money("Owner's share"),
    money("Paid out"),
    money("In transit"),
  ];
  const rowsOut: Cell[][] = [];
  const sumCols = new Array(cols.length - 1).fill(0) as number[];
  let owner = 0;
  for (const e of entities) {
    const mine = days.filter((d) => d.entityId === e.id);
    const st = royaltyStatement(mine, terms.get(e.id) ?? []);
    const s = (f: (d: OwnerDay) => number) => mine.reduce((a, d) => a + f(d), 0);
    const net = s((d) => d.baseCents) - s((d) => d.refundBaseCents);
    const fees = s((d) => d.processingFeeCents);
    const share = net - fees - st.royaltyDueCents - st.adFundDueCents;
    owner += share;
    const po = payouts.find((p) => p.entityId === e.id);
    const nums = [
      s((d) => d.tickets),
      s((d) => d.grossSalesCents),
      s((d) => d.discountCents),
      s((d) => d.refundCents),
      s((d) => d.serviceNetCents),
      s((d) => d.productNetCents),
      net,
      s((d) => d.taxCents),
      s((d) => d.tipCents),
      fees,
      st.royaltyDueCents,
      st.adFundDueCents,
      share,
      Number(po?.paid ?? 0),
      Number(po?.pending ?? 0),
    ];
    nums.forEach((v, i) => (sumCols[i] += v));
    rowsOut.push([e.name, ...nums]);
  }
  const styles: ("total" | undefined)[] = rowsOut.map(() => undefined);
  if (entities.length > 1) {
    rowsOut.push(["All owner groups", ...sumCols]);
    styles.push("total");
  }
  return {
    stats: [
      { label: "Net sales", value: formatCents(sumCols[6]), hint: `${sumCols[0]} tickets` },
      { label: "Processing fees", value: formatCents(sumCols[9]) },
      { label: "Royalty and ad fund due", value: formatCents(sumCols[10] + sumCols[11]) },
      { label: "Owner's share", value: formatCents(owner), hint: "net sales less fees, royalty and ad fund" },
    ],
    tables: [
      {
        id: "pnl",
        title: "P&L by owner group",
        subtitle:
          "Sales at each owner's locations while they owned them. Tax is owed to the state and tips to staff, so neither is in the owner's share. Payroll, rent and product costs are outside the system and not taken off.",
        columns: cols,
        rows: rowsOut,
        rowStyles: styles,
      },
    ],
    notes: entities.length ? [] : ["No owner group whose finances you can see owned these locations in this range."],
  };
}

const ROLLUP_BY = [
  { value: "location", label: "Locations" },
  { value: "region", label: "Regions" },
  { value: "entity", label: "Owner groups" },
];

type RollupRow = { key: string | null; name: string | null; locations: number; tickets: number; gross: number; net: number; refunds: number; clients: number; newClients: number; appts: number; noShows: number; days: number };

async function rollupRows(shopIds: string[], from: string, to: string, by: "location" | "region" | "entity"): Promise<RollupRow[]> {
  if (!shopIds.length) return [];
  const key = by === "location" ? sql`d.shop_id` : by === "region" ? sql`d.region_id` : sql`d.owner_entity_id`;
  const name = by === "location" ? sql`max(sh.name)` : by === "region" ? sql`max(rg.name)` : sql`max(oe.name)`;
  return (
    await rows<Record<string, string | number | null>>(sql`
    select ${key}::text "key", ${name} "name", count(distinct d.shop_id)::int locations, sum(d.tickets)::bigint tickets, sum(d.gross_cents)::bigint gross,
      sum(d.service_net_cents + d.product_net_cents - d.refund_cents)::bigint net, sum(d.refund_cents)::bigint refunds,
      sum(d.clients)::bigint clients, sum(d.new_clients)::bigint "newClients", sum(d.appointments)::bigint appts, sum(d.no_shows)::bigint "noShows", count(distinct d.day)::int days
    from location_daily_stats d
    join shops sh on sh.id = d.shop_id
    left join regions rg on rg.id = d.region_id
    left join owner_entities oe on oe.id = d.owner_entity_id
    where d.shop_id in ${uuids(shopIds)} and d.day between ${from} and ${to}
    group by 1`)
  ).map((r) => ({
    key: r.key == null ? null : String(r.key),
    name: r.name == null ? null : String(r.name),
    locations: Number(r.locations),
    tickets: Number(r.tickets),
    gross: Number(r.gross),
    net: Number(r.net),
    refunds: Number(r.refunds),
    clients: Number(r.clients),
    newClients: Number(r.newClients),
    appts: Number(r.appts),
    noShows: Number(r.noShows),
    days: Number(r.days),
  }));
}

export async function rollupData({ scope, params }: ReportInput): Promise<ReportData> {
  const by = (["location", "region", "entity"] as const).find((b) => b === params.by) ?? "location";
  const span = diffDays(scope.to, scope.from) + 1;
  const prevTo = addDays(scope.from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const [cur, prev, fresh] = await Promise.all([
    rollupRows(scope.shopIds, scope.from, scope.to, by),
    rollupRows(scope.shopIds, prevFrom, prevTo, by),
    scope.shopIds.length
      ? db.execute(sql`select max(computed_at) at, count(*)::int n from location_daily_stats where shop_id in ${uuids(scope.shopIds)} and day between ${scope.from} and ${scope.to}`)
      : Promise.resolve([]),
  ]);
  const ranked = [...cur].sort((a, b) => b.net - a.net);
  const label = by === "location" ? "Location" : by === "region" ? "Region" : "Owner group";
  const empty = by === "region" ? "No region" : "No owner";
  const cols = [
    { label: "Rank", kind: "int", sum: false } as Column,
    text(label),
    int("Locations"),
    int("Tickets"),
    money("Gross sales"),
    money("Net sales"),
    money("Net per location"),
    money("Avg ticket"),
    pctCol("Growth on prior period"),
    int("Client visits"),
    int("New clients"),
    int("Appointments"),
    pctCol("No-show rate"),
  ];
  const out: Cell[][] = ranked.map((r, i) => {
    const p = prev.find((x) => x.key === r.key);
    return [
      i + 1,
      r.name ?? empty,
      r.locations,
      r.tickets,
      r.gross,
      r.net,
      r.locations ? Math.round(r.net / r.locations) : 0,
      r.tickets ? Math.round((r.net + r.refunds) / r.tickets) : 0,
      p && p.net ? (r.net - p.net) / Math.abs(p.net) : null,
      r.clients,
      r.newClients,
      r.appts,
      r.appts ? r.noShows / r.appts : null,
    ];
  });
  const total = cur.reduce((a, r) => ({ net: a.net + r.net, tickets: a.tickets + r.tickets, newClients: a.newClients + r.newClients }), { net: 0, tickets: 0, newClients: 0 });
  const prevNet = prev.reduce((a, r) => a + r.net, 0);
  const f = (fresh as unknown as { at: string | null; n: number }[])[0];
  const expected = span * scope.shopIds.length;
  return {
    stats: [
      { label: "Net sales", value: formatCents(total.net), hint: prevNet ? `${total.net >= prevNet ? "+" : ""}${Math.round(((total.net - prevNet) / Math.abs(prevNet)) * 100)}% on the prior ${span} days` : undefined },
      { label: "Tickets", value: String(total.tickets) },
      { label: "New clients", value: String(total.newClients) },
      { label: label === "Location" ? "Locations" : `${label}s`, value: String(cur.length) },
    ],
    tables: [
      {
        id: "rollup",
        title: `${label}s compared`,
        subtitle: "Ranked on net sales. Owner and region are as of each day, so a location that changed hands counts toward each owner for their own days.",
        columns: cols,
        rows: out,
      },
    ],
    options: [{ param: "by", label: "Compare", value: by, choices: ROLLUP_BY }],
    notes: [
      `Built from the nightly location rollups${f?.at ? `, last run ${new Date(f.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.`,
      ...(f && f.n < expected ? [`${expected - f.n} location-days in this range aren't rolled up yet (today's numbers come in with the next run).`] : []),
    ],
  };
}
