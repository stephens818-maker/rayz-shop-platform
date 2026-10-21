"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Table, Td, Textarea, Th, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { receivePoAction } from "../../actions";

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toCents = (s: string) => Math.round((Number(s.replace(/[^0-9.]/g, "")) || 0) * 100);

interface Line {
  lineId: string;
  sku: string;
  vendorSku: string | null;
  name: string;
  casePack: number;
  ordered: number;
  received: number;
  unitCostCents: number;
  onHand: number;
}

export function ReceiveForm({ po, lines }: { po: { id: string; number: number }; lines: Line[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.lineId, (l.unitCostCents / 100).toFixed(2)])));
  const [note, setNote] = useState("");
  const [updateVendorCost, setUpdateVendorCost] = useState(false);
  const due = (l: Line) => Math.max(0, l.ordered - l.received);
  const n = (l: Line) => Math.max(0, Math.floor(Number(qty[l.lineId] || 0)));
  const changed = (l: Line) => toCents(cost[l.lineId] ?? "") !== l.unitCostCents;
  const now = lines.filter((l) => n(l) > 0);
  const units = now.reduce((a, l) => a + n(l), 0);
  const value = now.reduce((a, l) => a + n(l) * toCents(cost[l.lineId] ?? ""), 0);
  const over = lines.filter((l) => n(l) > due(l));
  const complete = lines.every((l) => n(l) === due(l));
  const anyCostChange = now.some(changed);

  return (
    <Card>
      <CardHeader
        title="What arrived"
        subtitle="Enter what's in the box. Anything left stays on order for the next delivery. If the invoice price differs, change the unit cost; the shelf cost moves to the weighted average."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" className="whitespace-nowrap" onClick={() => setQty(Object.fromEntries(lines.map((l) => [l.lineId, String(due(l))])))}>
              Everything due
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setQty({})}>
              Clear
            </Button>
          </div>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th right>Ordered</Th>
            <Th right>Already in</Th>
            <Th right>Due</Th>
            <Th right>Receiving now</Th>
            <Th right>Unit cost</Th>
            <Th right>On hand after</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineId} className={cx(due(l) === 0 && "text-zinc-400")}>
              <Td>
                <div className="font-medium">{l.name}</div>
                <div className="text-xs text-zinc-500">
                  {l.sku}
                  {l.vendorSku && ` · vendor ${l.vendorSku}`}
                  {l.casePack > 1 && ` · case of ${l.casePack}`}
                </div>
              </Td>
              <Td right>{l.ordered}</Td>
              <Td right>{l.received}</Td>
              <Td right className="font-medium">
                {due(l)}
              </Td>
              <Td right>
                <div className="flex items-center justify-end gap-1">
                  <Input
                    aria-label={`Receiving ${l.name}`}
                    className={cx("w-20 text-right", n(l) > due(l) && "ring-red-400")}
                    inputMode="numeric"
                    disabled={due(l) === 0}
                    value={qty[l.lineId] ?? ""}
                    placeholder="0"
                    onChange={(e) => setQty({ ...qty, [l.lineId]: e.target.value.replace(/[^0-9]/g, "") })}
                  />
                  {due(l) > 0 && (
                    <button className="text-xs text-brand-700 underline" onClick={() => setQty({ ...qty, [l.lineId]: String(due(l)) })}>
                      all
                    </button>
                  )}
                </div>
              </Td>
              <Td right>
                <Input
                  aria-label={`Unit cost ${l.name}`}
                  className={cx("w-24 text-right", changed(l) && "ring-amber-400")}
                  inputMode="decimal"
                  disabled={due(l) === 0}
                  value={cost[l.lineId] ?? ""}
                  onChange={(e) => setCost({ ...cost, [l.lineId]: e.target.value })}
                />
                {changed(l) && <div className="mt-0.5 text-xs text-amber-700">ordered at {$(l.unitCostCents)}</div>}
              </Td>
              <Td right className="tabular-nums">
                {n(l) > 0 ? (
                  <>
                    {l.onHand} → <span className="font-medium text-zinc-900">{l.onHand + n(l)}</span>
                  </>
                ) : (
                  l.onHand
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="grid gap-4 border-t border-zinc-100 p-4 md:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <Field label="Note (packing slip, damage, backorders)">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Fiber backordered two weeks" />
          </Field>
          {anyCostChange && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={updateVendorCost} onChange={(e) => setUpdateVendorCost(e.target.checked)} />
              Also save the new prices as this vendor&apos;s cost for next time
            </label>
          )}
        </div>
        <div className="flex flex-col items-end justify-end gap-2 text-sm">
          <div className="text-zinc-600">
            {units} units · {$(value)} at cost
            {units > 0 && <span className="ml-1 text-zinc-500">({complete ? "completes the order" : "partial delivery"})</span>}
          </div>
          {over.length > 0 && <div className="text-red-600">More than is due on {over.map((l) => l.name).join(", ")}.</div>}
          {error && <div className="text-red-600">{error}</div>}
          <Button
            disabled={pending || units === 0 || over.length > 0}
            onClick={() =>
              run(
                () => receivePoAction(po.id, { lines: now.map((l) => ({ lineId: l.lineId, qty: n(l), unitCostCents: toCents(cost[l.lineId] ?? "") })), note, updateVendorCost }),
                () => router.push(`/admin/purchase-orders/${po.id}`),
              )
            }
          >
            {pending ? "Receiving…" : `Receive ${units} unit${units === 1 ? "" : "s"} into stock`}
          </Button>
        </div>
      </div>
    </Card>
  );
}
