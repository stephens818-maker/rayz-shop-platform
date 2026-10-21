import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { transferNumber } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { stockLevels } from "@/server/inventory/stock";
import { loadTransfer } from "@/server/inventory/transfers";
import { TransferEditor, TransferReceive } from "../forms";
import { TRANSFER_TONE } from "../tone";

export const metadata: Metadata = { title: "Transfer" };

const ACTION_LABEL: Record<string, string> = { "transfer.create": "Created", "transfer.update": "Edited", "transfer.send": "Sent", "transfer.receive": "Received", "transfer.cancel": "Cancelled" };

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/inventory/transfers/[id]");
  const { id } = await params;
  const d = await loadTransfer(id);
  if (!d) notFound();
  const { t } = d;
  const atFrom = ctx.shopIds.includes(t.fromShopId);
  const atTo = ctx.shopIds.includes(t.toShopId);
  if (!atFrom && !atTo) notFound();
  const editable = t.status === "draft" && atFrom && can(ctx, "inventory.transfer");
  const canReceive = t.status === "sent" && atTo && (can(ctx, "inventory.transfer") || can(ctx, "po.receive"));
  const source = editable ? (await stockLevels([t.fromShopId])).filter((s) => s.active) : [];
  const units = d.lines.reduce((a, l) => a + l.qty, 0);
  const value = d.lines.reduce((a, l) => a + l.qty * (l.unitCostCents ?? l.atSource?.costCents ?? 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {transferNumber(t.number)} <Badge tone={TRANSFER_TONE[t.status]}>{t.status === "sent" ? "in transit" : t.status}</Badge>
          </span>
        }
        subtitle={
          <>
            {d.from.name} → {d.to.name} · {units} units · {formatCents(value)} at cost ·{" "}
            <Link href="/admin/inventory/transfers" className="underline">
              all transfers
            </Link>
          </>
        }
      />
      {t.status === "sent" && !atTo && <Notice tone="blue">On its way. {d.to.name} checks it in when it arrives.</Notice>}
      {editable ? (
        <TransferEditor
          id={id}
          note={t.note}
          lines={d.lines.map((l) => ({ productId: l.productId, qty: l.qty }))}
          source={[...new Map([...d.lines.map((l) => ({ productId: l.productId, sku: l.sku, name: `${l.brand} ${l.name}`, onHand: l.atSource?.onHand ?? 0, available: l.atSource?.available ?? 0 })), ...source.map((s) => ({ productId: s.productId, sku: s.sku, name: `${s.brand} ${s.name}`, onHand: s.onHand, available: s.available }))].map((x) => [x.productId, x])).values()]}
          editable
        />
      ) : canReceive ? (
        <TransferReceive id={id} lines={d.lines.map((l) => ({ lineId: l.id, name: `${l.brand} ${l.name}`, sku: l.sku, qty: l.qty }))} />
      ) : (
        <Card>
          <CardHeader title="Products" subtitle={t.note ?? undefined} />
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th right>Sent</Th>
                <Th right>Arrived</Th>
                <Th right>Unit cost</Th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <div className="font-medium">
                      {l.brand} {l.name}
                    </div>
                    <div className="text-xs text-zinc-500">{l.sku}</div>
                  </Td>
                  <Td right>{l.qty}</Td>
                  <Td right className={t.status === "received" && l.qtyReceived !== l.qty ? "text-red-600" : undefined}>
                    {t.status === "received" ? l.qtyReceived : "—"}
                  </Td>
                  <Td right>{l.unitCostCents !== null ? formatCents(l.unitCostCents) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card>
        <CardHeader title="History" />
        <ol className="space-y-2 px-4 py-3 text-sm">
          {d.history.map((h, i) => {
            const det = (h.details ?? {}) as { lostInTransit?: { productId: string; qty: number }[] };
            return (
              <li key={i}>
                <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span> <span className="text-zinc-500">· {h.who?.split(":").pop()}</span>
                <div className="text-xs text-zinc-500">{formatDateTime(h.at)}</div>
                {det.lostInTransit?.length ? (
                  <div className="text-xs text-red-600">
                    Lost in transit:{" "}
                    {det.lostInTransit
                      .map((x) => {
                        const l = d.lines.find((y) => y.productId === x.productId);
                        return `${x.qty} × ${l ? `${l.brand} ${l.name}` : "product"}`;
                      })
                      .join(", ")}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
