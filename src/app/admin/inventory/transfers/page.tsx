import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Badge, Card, Empty, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { transferNumber } from "@/domain/inventory";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { listTransfers } from "@/server/inventory/transfers";
import { NewTransferForm } from "./forms";
import { TRANSFER_TONE } from "./tone";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage() {
  const ctx = await guardPage("/admin/inventory/transfers");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const [rows, allShops] = await Promise.all([listTransfers(shopIds), db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.active, true)).orderBy(asc(shops.name))]);
  const incoming = rows.filter((r) => r.status === "sent" && shopIds.includes(r.toShopId));
  const outgoing = rows.filter((r) => r.status === "sent" && shopIds.includes(r.fromShopId));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Transfers" subtitle="Move stock between shops. Sending takes it off the sending shop's shelf; the receiving shop checks it in." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Drafts" value={rows.filter((r) => r.status === "draft").length} />
        <Stat label="Incoming, to check in" value={incoming.length} hint={`${incoming.reduce((a, r) => a + r.units, 0)} units`} tone={incoming.length ? "down" : undefined} />
        <Stat label="Outgoing, in transit" value={outgoing.length} hint={`${outgoing.reduce((a, r) => a + r.units, 0)} units`} />
        <Stat label="Received" value={rows.filter((r) => r.status === "received").length} hint="last 200 transfers" />
      </div>
      {can(ctx, "inventory.transfer") && <NewTransferForm from={ctx.shops.filter((s) => shopIds.includes(s.id))} to={allShops} />}
      <Card>
        {rows.length === 0 ? (
          <div className="p-4">
            <Empty title="No transfers yet" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Transfer</Th>
                <Th>Status</Th>
                <Th>From</Th>
                <Th>To</Th>
                <Th right>Units</Th>
                <Th>Created</Th>
                <Th>Sent</Th>
                <Th>Received</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50">
                  <Td>
                    <Link href={`/admin/inventory/transfers/${r.id}`} className="font-medium text-brand-700 hover:underline">
                      {transferNumber(r.number)}
                    </Link>
                    {r.note && <div className="max-w-56 truncate text-xs text-zinc-500">{r.note}</div>}
                  </Td>
                  <Td>
                    <Badge tone={TRANSFER_TONE[r.status]}>{r.status === "sent" ? "in transit" : r.status}</Badge>
                  </Td>
                  <Td>{r.from}</Td>
                  <Td>{r.to}</Td>
                  <Td right>{r.status === "received" && r.received !== r.units ? `${r.received} / ${r.units}` : r.units}</Td>
                  <Td className="text-zinc-600">{formatDateTime(r.createdAt)}</Td>
                  <Td className="text-zinc-600">{r.sentAt ? formatDateTime(r.sentAt) : "—"}</Td>
                  <Td className="text-zinc-600">{r.receivedAt ? formatDateTime(r.receivedAt) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
