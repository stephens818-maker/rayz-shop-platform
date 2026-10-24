"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Table, Td, Textarea, Th, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { cancelTransferAction, createTransferAction, receiveTransferAction, sendTransferAction, updateTransferAction } from "./actions";

type ShopOpt = { id: string; name: string };

export function NewTransferForm({ from, to }: { from: ShopOpt[]; to: ShopOpt[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [fromId, setFromId] = useState(from[0]?.id ?? "");
  const dests = to.filter((s) => s.id !== fromId);
  const [toId, setToId] = useState(dests[0]?.id ?? "");
  const target = dests.some((s) => s.id === toId) ? toId : (dests[0]?.id ?? "");
  return (
    <Card>
      <CardHeader title="New transfer" subtitle="Starts as a draft: pick the products next. While it's a draft the stock is held at the sending shop." />
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="From" className="w-52">
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {from.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To" className="w-52">
          <Select value={target} onChange={(e) => setToId(e.target.value)}>
            {dests.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button disabled={pending || !fromId || !target} onClick={() => run(() => createTransferAction({ fromShopId: fromId, toShopId: target, lines: [] }), (r) => router.push(`/admin/inventory/transfers/${r.id}`))}>
          Start transfer
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </Card>
  );
}

interface SourceItem {
  productId: string;
  sku: string;
  name: string;
  onHand: number;
  available: number;
}

export function TransferEditor({ id, note, lines, source, editable }: { id: string; note: string | null; lines: { productId: string; qty: number }[]; source: SourceItem[]; editable: boolean }) {
  const { pending, error, run } = useAction();
  const [rows, setRows] = useState(() => lines.map((l) => ({ productId: l.productId, qty: String(l.qty) })));
  const [text, setText] = useState(note ?? "");
  const [adding, setAdding] = useState("");
  const [saved, setSaved] = useState(false);
  const item = (pid: string) => source.find((s) => s.productId === pid);
  const dirty = JSON.stringify(rows) !== JSON.stringify(lines.map((l) => ({ productId: l.productId, qty: String(l.qty) }))) || text !== (note ?? "");
  const short = rows.filter((r) => Number(r.qty) > (item(r.productId)?.onHand ?? 0));
  const save = (then?: () => void) =>
    run(
      () => updateTransferAction(id, { note: text, lines: rows.map((r) => ({ productId: r.productId, qty: Math.floor(Number(r.qty) || 0) })) }),
      () => {
        setSaved(true);
        then?.();
      },
    );
  return (
    <Card>
      <CardHeader title="Products" subtitle={editable ? "On hand is at the sending shop; the draft's own quantities are already held there, so they're not taken off \u201cavailable\u201d twice." : undefined} />
      <Table>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th right>On hand there</Th>
            <Th right>Sending</Th>
            {editable && <Th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const s = item(r.productId);
            return (
              <tr key={r.productId}>
                <Td>
                  <div className="font-medium">{s?.name ?? r.productId}</div>
                  <div className="text-xs text-zinc-500">{s?.sku}</div>
                </Td>
                <Td right>{s?.onHand ?? 0}</Td>
                <Td right>
                  {editable ? (
                    <Input
                      className={cx("ml-auto w-20 text-right", Number(r.qty) > (s?.onHand ?? 0) && "ring-amber-400")}
                      inputMode="numeric"
                      value={r.qty}
                      onChange={(e) => {
                        setSaved(false);
                        setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^0-9]/g, "") } : x)));
                      }}
                    />
                  ) : (
                    r.qty
                  )}
                </Td>
                {editable && (
                  <Td right>
                    <button className="text-xs text-zinc-500 hover:text-red-600" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </Td>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <Td className="text-zinc-500">No products yet.</Td>
            </tr>
          )}
        </tbody>
      </Table>
      {editable && (
        <div className="space-y-3 border-t border-zinc-100 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Add a product" className="w-96">
              <Select value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Choose…</option>
                {source
                  .filter((s) => !rows.some((r) => r.productId === s.productId))
                  .map((s) => (
                    <option key={s.productId} value={s.productId} disabled={s.onHand <= 0}>
                      {s.name} · {s.onHand} on hand
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              variant="secondary"
              disabled={!adding}
              onClick={() => {
                setRows([...rows, { productId: adding, qty: "1" }]);
                setAdding("");
                setSaved(false);
              }}
            >
              Add
            </Button>
          </div>
          <Field label="Note">
            <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Covering the Saturday rush" />
          </Field>
          {short.length > 0 && <div className="text-sm text-amber-700">More than is on hand: {short.map((r) => item(r.productId)?.name).join(", ")}. The shop&apos;s negative-stock setting decides whether it can be sent.</div>}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={pending || !dirty} onClick={() => save()}>
              Save draft
            </Button>
            <Button
              disabled={pending || rows.length === 0 || rows.some((r) => !(Number(r.qty) > 0))}
              onClick={() => (dirty ? save(() => run(() => sendTransferAction(id))) : run(() => sendTransferAction(id)))}
            >
              Send: take it off the shelf
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => confirm("Cancel this transfer?") && run(() => cancelTransferAction(id))}>
              Cancel transfer
            </Button>
            {saved && !dirty && <span className="text-sm text-green-700">Saved.</span>}
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

export function TransferReceive({ id, lines }: { id: string; lines: { lineId: string; name: string; sku: string; qty: number }[] }) {
  const { pending, error, run } = useAction();
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.lineId, String(l.qty)])));
  const n = (l: { lineId: string }) => Math.floor(Number(got[l.lineId] || 0));
  const short = lines.reduce((a, l) => a + Math.max(0, l.qty - n(l)), 0);
  const over = lines.some((l) => n(l) > l.qty);
  return (
    <Card>
      <CardHeader title="Check in what arrived" subtitle="Everything sent is filled in. Lower a line for anything missing or broken; the shortfall is recorded as lost in transit at the sending shop." />
      <Table>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th right>Sent</Th>
            <Th right>Arrived</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineId}>
              <Td>
                <div className="font-medium">{l.name}</div>
                <div className="text-xs text-zinc-500">{l.sku}</div>
              </Td>
              <Td right>{l.qty}</Td>
              <Td right>
                <Input className={cx("ml-auto w-20 text-right", n(l) !== l.qty && "ring-amber-400")} inputMode="numeric" value={got[l.lineId] ?? ""} onChange={(e) => setGot({ ...got, [l.lineId]: e.target.value.replace(/[^0-9]/g, "") })} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 p-4">
        <Button disabled={pending || over} onClick={() => run(() => receiveTransferAction(id, { lines: lines.map((l) => ({ lineId: l.lineId, qty: n(l) })) }))}>
          Receive into stock
        </Button>
        {short > 0 && <span className="text-sm text-amber-700">{short} short: lost in transit</span>}
        {over && <span className="text-sm text-red-600">No more than was sent can arrive.</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </Card>
  );
}
