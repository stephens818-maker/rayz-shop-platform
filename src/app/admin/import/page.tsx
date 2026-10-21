import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { importRuns, staff } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { splitRunStats, statLines } from "@/lib/import-stats";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";
import { Importer } from "./importer";

export const metadata: Metadata = { title: "Import from Squire" };

const KIND_LABEL: Record<string, string> = {
  clients: "Clients",
  appointments: "Appointments",
  transactions: "Transactions",
  loyalty: "Loyalty balances",
  gift_cards: "Gift cards",
};

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Totals {
  clients: number;
  squire_clients: number;
  squire_ids: number;
  past_visits: number;
  no_shows: number;
  cancellations: number;
  upcoming: number;
  tickets: number;
  voided_tickets: number;
  ticket_cents: number;
  tip_cents: number;
  gift_cards: number;
  gift_card_cents: number;
  former_barbers: number;
}

async function liveTotals(): Promise<Totals> {
  const [r] = (await db.execute(sql`
    select
      (select count(*) from customers)::int as clients,
      (select count(distinct customer_id) from customer_squire_ids)::int as squire_clients,
      (select count(*) from customer_squire_ids)::int as squire_ids,
      (select count(*) from appointments where source = 'import' and status = 'completed')::int as past_visits,
      (select count(*) from appointments where source = 'import' and status = 'no_show')::int as no_shows,
      (select count(*) from appointments where source = 'import' and status = 'cancelled')::int as cancellations,
      (select count(*) from appointments where source = 'import' and status in ('booked', 'confirmed') and starts_at > now())::int as upcoming,
      (select count(*) from sales where is_imported and status <> 'voided')::int as tickets,
      (select count(*) from sales where is_imported and status = 'voided')::int as voided_tickets,
      (select coalesce(sum(total_cents), 0) from sales where is_imported and status <> 'voided')::int as ticket_cents,
      (select coalesce(sum(tip_cents), 0) from sales where is_imported and status <> 'voided')::int as tip_cents,
      (select count(*) from gift_cards where source = 'import')::int as gift_cards,
      (select coalesce(sum(balance_cents), 0) from gift_cards where source = 'import' and status = 'active')::int as gift_card_cents,
      (select count(*) from staff where squire_name is not null and not active)::int as former_barbers
  `)) as unknown as Totals[];
  return r;
}

export default async function ImportPage() {
  await requireStaff(["brand_admin"]);
  const [runs, totals] = await Promise.all([
    db
      .select({ r: importRuns, by: staff.displayLabel })
      .from(importRuns)
      .leftJoin(staff, eq(staff.id, importRuns.staffId))
      .orderBy(desc(importRuns.createdAt))
      .limit(30),
    liveTotals(),
  ]);

  const anyImported = totals.squire_ids + totals.past_visits + totals.tickets + totals.voided_tickets + totals.gift_cards > 0;
  const live: [string, string][] = [
    ["Clients in the system", String(totals.clients)],
    ["Clients carried over from Squire", `${totals.squire_clients}${totals.squire_ids > totals.squire_clients ? ` (from ${totals.squire_ids} Squire records)` : ""}`],
    ["Past visits from Squire", String(totals.past_visits)],
    ["No-shows / cancellations", `${totals.no_shows} / ${totals.cancellations}`],
    ["Upcoming bookings from Squire", String(totals.upcoming)],
    ["Tickets from Squire", `${totals.tickets} · ${$(totals.ticket_cents)} incl. ${$(totals.tip_cents)} tips${totals.voided_tickets ? ` (+${totals.voided_tickets} voided)` : ""}`],
    ["Gift cards from Squire", `${totals.gift_cards} · ${$(totals.gift_card_cents)} outstanding`],
    ["Former barbers (inactive, history only)", String(totals.former_barbers)],
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Import from Squire"
        subtitle="Upload Squire CSV exports. Every file is checked with a dry run first; nothing is saved until you commit. Re-running a file is safe: clients match on Squire ID, then email or phone with a matching first name, so one person seen at two shops becomes one client."
      />
      <Importer />
      {anyImported && (
        <Card className="mt-4">
          <CardHeader title="What's been carried over" subtitle="Live totals across all shops. Compare against Squire's own counts before cutover." />
          <dl className="grid divide-y divide-zinc-50 text-sm sm:grid-cols-2 sm:divide-y-0">
            {live.map(([l, v]) => (
              <div key={l} className="flex justify-between gap-3 border-zinc-50 px-4 py-2 sm:border-b">
                <dt className="text-zinc-600">{l}</dt>
                <dd className="tabular text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
      <Card className="mt-4">
        <CardHeader title="Import history" subtitle="Committed imports only. Dry runs aren't recorded." />
        {runs.length === 0 ? (
          <Empty title="No imports yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Type</Th>
                <Th>File</Th>
                <Th right>Rows</Th>
                <Th>Result</Th>
                <Th right>Skipped</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map(({ r, by }) => {
                const { stats, skipped } = splitRunStats(r.stats);
                const lines = statLines(r.kind, stats).filter(([, v]) => v !== "0" && v !== "$0.00");
                const reasons = Object.entries(skipped).filter(([k]) => k !== "Already imported");
                return (
                  <tr key={r.id} className="align-top">
                    <Td>{formatDateTime(r.createdAt)}</Td>
                    <Td>{KIND_LABEL[r.kind] ?? r.kind}</Td>
                    <Td className="max-w-40 truncate">{r.filename ?? "—"}</Td>
                    <Td right>{r.totalRows}</Td>
                    <Td className="text-xs text-zinc-600">
                      {lines.length ? lines.map(([l, v]) => <div key={l}>{l}: {v}</div>) : `${r.inserted} added, ${r.updated} updated`}
                    </Td>
                    <Td right>
                      {r.skipped ? (
                        <div className="space-y-1">
                          <Badge tone={r.errors.length ? "amber" : "gray"}>{r.skipped}</Badge>
                          {reasons.map(([k, v]) => (
                            <div key={k} className="text-xs text-zinc-500">
                              {k}: {v}
                            </div>
                          ))}
                          {r.errors.length > 0 && (
                            <Link href={`/admin/import/${r.id}/errors`} className="block text-xs underline" prefetch={false}>
                              Error file
                            </Link>
                          )}
                        </div>
                      ) : (
                        0
                      )}
                    </Td>
                    <Td>{by ?? "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
