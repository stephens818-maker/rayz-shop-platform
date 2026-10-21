import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { countNumber } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { loadCount } from "@/server/inventory/counts";
import { inTenant } from "@/server/tenant";
import { CountSheet } from "../forms";

export const metadata: Metadata = { title: "Count" };

export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/inventory/counts/[id]");
  const { id } = await params;
  if (!(await inTenant(ctx, "stock_count", id))) notFound();
  const d = await loadCount(id);
  if (!d) notFound();
  const { count } = d;
  const kind = count.kind === "full" ? "Full stocktake" : "Cycle count";
  const posted = count.status === "posted";
  const off = d.lines.filter((l) => posted && l.variance);
  const cents = (l: (typeof d.lines)[number]) => (l.variance ?? 0) * (l.unitCostCents ?? l.costCents);
  const lost = off.filter((l) => l.variance! < 0);
  const found = off.filter((l) => l.variance! > 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {countNumber(count.number)} <Badge tone={posted ? "green" : count.status === "open" ? "blue" : "gray"}>{count.status}</Badge>
          </span>
        }
        subtitle={
          <>
            {kind} at {d.shop} · started {formatDateTime(count.createdAt)}
            {d.people.createdBy && ` by ${d.people.createdBy}`}
            {count.postedAt && ` · posted ${formatDateTime(count.postedAt)}${d.people.postedBy ? ` by ${d.people.postedBy}` : ""}`} ·{" "}
            <Link href="/admin/inventory/counts" className="underline">
              all counts
            </Link>
            {count.note && <div className="mt-1">{count.note}</div>}
          </>
        }
      />
      {count.status === "open" && (
        <CountSheet
          id={id}
          kind={count.kind}
          lines={d.lines.map((l) => ({ productId: l.productId, sku: l.sku, name: `${l.brand} ${l.name}`, category: l.category, counted: l.counted, onHand: l.stock, costCents: l.costCents }))}
        />
      )}
      {posted && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Products counted" value={d.lines.length} hint={`${off.length} differed`} />
            <Stat label="Net variance" value={formatCents(off.reduce((a, l) => a + cents(l), 0))} hint={`${off.reduce((a, l) => a + (l.variance ?? 0), 0)} units`} tone={off.reduce((a, l) => a + cents(l), 0) < 0 ? "down" : undefined} />
            <Stat label="Missing" value={formatCents(lost.reduce((a, l) => a + cents(l), 0))} hint={`${lost.reduce((a, l) => a - (l.variance ?? 0), 0)} units short`} />
            <Stat label="Found" value={formatCents(found.reduce((a, l) => a + cents(l), 0))} hint={`${found.reduce((a, l) => a + (l.variance ?? 0), 0)} units over`} />
          </div>
          <Card>
            <CardHeader title="Variance report" subtitle="Against on-hand when the count was posted. “At start” shows what the shelf should have held when counting began; the gap is sales and receipts made while counting." />
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th right>At start</Th>
                  <Th right>On hand at post</Th>
                  <Th right>Counted</Th>
                  <Th right>Variance</Th>
                  <Th right>Unit cost</Th>
                  <Th right>Value</Th>
                </tr>
              </thead>
              <tbody>
                {[...d.lines]
                  .sort((a, b) => cents(a) - cents(b))
                  .map((l) => (
                    <tr key={l.id} className={cx(!l.variance && "text-zinc-400")}>
                      <Td>
                        <div className={cx("font-medium", l.variance ? "text-zinc-900" : undefined)}>
                          {l.brand} {l.name}
                        </div>
                        <div className="text-xs">{l.sku}</div>
                      </Td>
                      <Td right>{l.expectedAtStart}</Td>
                      <Td right>{l.onHandAtPost ?? "—"}</Td>
                      <Td right>{l.counted ?? "—"}</Td>
                      <Td right className={cx("font-medium tabular-nums", (l.variance ?? 0) < 0 ? "text-red-600" : (l.variance ?? 0) > 0 ? "text-green-700" : undefined)}>
                        {l.variance ? (l.variance > 0 ? `+${l.variance}` : l.variance) : 0}
                      </Td>
                      <Td right>{formatCents(l.unitCostCents ?? l.costCents)}</Td>
                      <Td right className={cents(l) < 0 ? "text-red-600" : undefined}>
                        {l.variance ? formatCents(cents(l)) : "—"}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
      {count.status === "cancelled" && (
        <Card>
          <CardHeader title="Cancelled" subtitle="Nothing changed in stock." />
        </Card>
      )}
    </div>
  );
}
