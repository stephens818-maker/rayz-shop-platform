import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { countNumber } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { listCounts } from "@/server/inventory/counts";
import { stockLevels } from "@/server/inventory/stock";
import { StartCountForm } from "./forms";

export const metadata: Metadata = { title: "Counts" };

const TONE = { open: "blue", posted: "green", cancelled: "gray" } as const;

export default async function CountsPage() {
  const ctx = await guardPage("/admin/inventory/counts");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const [rows, stock] = await Promise.all([listCounts(shopIds), stockLevels(shopIds)]);
  const products = new Map<string, { id: string; name: string; shopIds: string[] }>();
  for (const s of stock) {
    if (!s.active && s.onHand === 0) continue;
    const p = products.get(s.productId) ?? { id: s.productId, name: `${s.brand} ${s.name}`, shopIds: [] };
    p.shopIds.push(s.shopId);
    products.set(s.productId, p);
  }
  const categories = [...new Set(stock.map((s) => s.category))].sort();

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Counts" subtitle="Cycle counts and full stocktakes. Posting a count sets on-hand to what was counted and records each difference in the stock ledger." />
      <StartCountForm shops={ctx.shops.filter((s) => shopIds.includes(s.id))} categories={categories} products={[...products.values()].sort((a, b) => a.name.localeCompare(b.name))} />
      <Card>
        {rows.length === 0 ? (
          <div className="p-4">
            <Empty title="No counts yet" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Count</Th>
                <Th>Kind</Th>
                <Th>Status</Th>
                {shopIds.length > 1 && <Th>Shop</Th>}
                <Th right>Products</Th>
                <Th right>Units off</Th>
                <Th right>Variance at cost</Th>
                <Th>Started</Th>
                <Th>Posted</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50">
                  <Td>
                    <Link href={`/admin/inventory/counts/${r.id}`} className="font-medium text-brand-700 hover:underline">
                      {countNumber(r.number)}
                    </Link>
                    {r.note && <div className="max-w-56 truncate text-xs text-zinc-500">{r.note}</div>}
                  </Td>
                  <Td>{r.kind === "full" ? "Full stocktake" : "Cycle count"}</Td>
                  <Td>
                    <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  </Td>
                  {shopIds.length > 1 && <Td>{r.shop}</Td>}
                  <Td right>{r.status === "open" ? `${r.counted} / ${r.lines}` : r.lines}</Td>
                  <Td right>{r.status === "posted" ? r.absVariance : "—"}</Td>
                  <Td right className={r.varianceCents < 0 ? "text-red-600" : undefined}>
                    {r.status === "posted" ? formatCents(r.varianceCents) : "—"}
                  </Td>
                  <Td className="text-zinc-600">
                    {formatDateTime(r.createdAt)}
                    {r.createdBy && <div className="text-xs text-zinc-400">{r.createdBy}</div>}
                  </Td>
                  <Td className="text-zinc-600">{r.postedAt ? formatDateTime(r.postedAt) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
