import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Column, Cell } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { addDays, diffDays } from "@/lib/time";
import { rows, uuids } from "./report-sql";
import type { ReportData, ReportInput } from "./report-data";

/**
 * The brand's location comparison: locations or regions side by side over a range, ranked on net
 * sales, read from location_daily_stats (the nightly rollups in src/server/jobs.ts) so it stays
 * quick at 50+ locations however many tickets they have.
 */

const money = (label: string): Column => ({ label, kind: "money" });
const int = (label: string): Column => ({ label, kind: "int" });
const text = (label: string): Column => ({ label });
const pctCol = (label: string): Column => ({ label, kind: "pct", sum: false });

export const ROLLUP_BY = [
  { value: "location", label: "Locations" },
  { value: "region", label: "Regions" },
] as const;
export type RollupBy = (typeof ROLLUP_BY)[number]["value"];

type RollupRow = { key: string | null; name: string | null; locations: number; tickets: number; gross: number; net: number; refunds: number; clients: number; newClients: number; appts: number; noShows: number };

async function rollupRows(shopIds: string[], from: string, to: string, by: RollupBy): Promise<RollupRow[]> {
  if (!shopIds.length) return [];
  const key = by === "location" ? sql`d.shop_id` : sql`d.region_id`;
  const name = by === "location" ? sql`max(sh.name)` : sql`max(rg.name)`;
  return (
    await rows<Record<string, string | number | null>>(sql`
    select ${key}::text "key", ${name} "name", count(distinct d.shop_id)::int locations, sum(d.tickets)::bigint tickets, sum(d.gross_cents)::bigint gross,
      sum(d.service_net_cents + d.product_net_cents - d.refund_cents)::bigint net, sum(d.refund_cents)::bigint refunds,
      sum(d.clients)::bigint clients, sum(d.new_clients)::bigint "newClients", sum(d.appointments)::bigint appts, sum(d.no_shows)::bigint "noShows"
    from location_daily_stats d
    join shops sh on sh.id = d.shop_id
    left join regions rg on rg.id = d.region_id
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
  }));
}

export async function rollupData({ scope, params }: ReportInput): Promise<ReportData> {
  const by: RollupBy = ROLLUP_BY.find((b) => b.value === params.by)?.value ?? "location";
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
  const label = by === "location" ? "Location" : "Region";
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
      r.name ?? "No region",
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
      { label: `${label}s`, value: String(cur.length) },
    ],
    tables: [
      {
        id: "rollup",
        title: `${label}s compared`,
        subtitle: "Ranked on net sales. Each location counts toward its current region, history included.",
        columns: cols,
        rows: out,
      },
    ],
    options: [{ param: "by", label: "Compare", value: by, choices: [...ROLLUP_BY] }],
    notes: [
      `Built from the nightly location rollups${f?.at ? `, last run ${new Date(f.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.`,
      ...(f && f.n < expected ? [`${expected - f.n} location-days in this range aren't rolled up yet (today's numbers come in with the next run).`] : []),
    ],
  };
}
