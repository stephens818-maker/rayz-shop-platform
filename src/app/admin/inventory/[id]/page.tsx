import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { ADJUST_REASON_LABEL, LEDGER_KIND_LABEL } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { ledgerEntries } from "@/server/inventory/reports";
import { stockLevels } from "@/server/inventory/stock";
import { ProductStandardForm } from "./standard-form";

export const metadata: Metadata = { title: "Stock history" };

export default async function ProductStockPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/inventory/[id]");
  const { id } = await params;
  const sp = await searchParams;
  const [p] = await db.select().from(products).where(eq(products.id, id));
  if (!p) notFound();
  const shopIds = sp.shop && ctx.shopIds.includes(sp.shop) ? [sp.shop] : ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const [levels, entries] = await Promise.all([stockLevels(ctx.shopIds, { productIds: [id] }), ledgerEntries({ shopIds, from: "2000-01-01", to: todayLocal() }, { productId: id, limit: 500 })]);
  const shopName = (sid: string) => ctx.shops.find((s) => s.id === sid)?.name ?? "";
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={`${p.brand} ${p.name}`}
        subtitle={
          <>
            {p.sku} · {p.category} · <Link href="/admin/inventory" className="underline">Stock</Link>
          </>
        }
      />
      {can(ctx, "catalog.manage") && (
        <Card>
          <CardHeader title="Brand price standard" subtitle={`Brand price ${formatCents(p.priceCents)}. What locations may charge; people with every shop aren't held to it.`} />
          <ProductStandardForm productId={p.id} localPrice={p.localPrice} floor={p.priceFloorCents} ceiling={p.priceCeilingCents} />
        </Card>
      )}
      <Card>
        <CardHeader title="Where it is" subtitle="On hand is the sum of the ledger below, at every shop." />
        <Table>
          <thead>
            <tr>
              <Th>Shop</Th>
              <Th right>On hand</Th>
              <Th right>Committed</Th>
              <Th right>Available</Th>
              <Th right>On order</Th>
              <Th right>In transit</Th>
              <Th right>Reorder / par</Th>
              <Th right>Cost</Th>
              <Th right>Value</Th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.shopId} className={cx(shopIds.length === 1 && shopIds[0] === l.shopId && "bg-brand-50/40")}>
                <Td>
                  <Link href={`/admin/inventory/${id}?shop=${l.shopId}`} className="hover:underline">
                    {l.shop}
                  </Link>
                </Td>
                <Td right>{l.onHand}</Td>
                <Td right>{l.committed}</Td>
                <Td right className={cx("font-semibold", l.low && "text-red-600")}>
                  {l.available} {l.low && <Badge tone="red">Low</Badge>}
                </Td>
                <Td right>{l.onOrder}</Td>
                <Td right>{l.inTransit}</Td>
                <Td right>
                  {l.levels.reorderPoint} / {l.levels.par}
                </Td>
                <Td right>{formatCents(l.costCents)}</Td>
                <Td right>{formatCents(l.valueCents)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title={`Ledger${shopIds.length === 1 ? `: ${shopName(shopIds[0])}` : ""}`} subtitle={`Every change, newest first${entries.length >= 500 ? " (latest 500)" : ""}. Entries can't be edited or deleted; mistakes are fixed with a new entry.`} />
        {entries.length === 0 ? (
          <div className="p-4">
            <Empty title="No stock changes yet" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                {shopIds.length > 1 && <Th>Shop</Th>}
                <Th>What</Th>
                <Th right>Change</Th>
                <Th right>On hand after</Th>
                <Th right>Unit cost</Th>
                <Th>Reference</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <Td className="text-zinc-600">{formatDateTime(e.at)}</Td>
                  {shopIds.length > 1 && <Td>{shopName(e.shopId)}</Td>}
                  <Td>
                    {LEDGER_KIND_LABEL[e.kind] ?? e.kind}
                    {e.reason && <span className="text-zinc-500"> · {ADJUST_REASON_LABEL[e.reason as keyof typeof ADJUST_REASON_LABEL] ?? e.reason}</span>}
                    {e.note && <div className="max-w-xs truncate text-xs text-zinc-500">{e.note}</div>}
                  </Td>
                  <Td right className={cx("font-medium", e.delta > 0 ? "text-emerald-700" : "text-red-700")}>
                    {e.delta > 0 ? `+${e.delta}` : e.delta}
                  </Td>
                  <Td right>{e.balanceAfter}</Td>
                  <Td right className="text-zinc-500">
                    {e.unitCostCents !== null ? formatCents(e.unitCostCents) : ""}
                  </Td>
                  <Td className="text-zinc-600">{e.ref}</Td>
                  <Td className="text-zinc-600">{e.by ?? (e.kind === "sale" ? "POS" : "")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
