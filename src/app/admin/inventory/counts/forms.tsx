"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { cancelCountAction, postCountAction, saveCountAction, startCountAction } from "./actions";

const $ = (c: number) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function StartCountForm({ shops, categories, products }: { shops: { id: string; name: string }[]; categories: string[]; products: { id: string; name: string; shopIds: string[] }[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [kind, setKind] = useState<"cycle" | "full">("cycle");
  const [category, setCategory] = useState(categories[0] ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [by, setBy] = useState<"category" | "products">("category");
  const [note, setNote] = useState("");
  const options = products.filter((p) => p.shopIds.includes(shopId) && !picked.includes(p.id));
  return (
    <Card>
      <CardHeader title="Start a count" subtitle="A cycle count checks a few products or one category; a full stocktake counts everything the shop carries. Selling can go on while you count." />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {shops.length > 1 && (
            <Field label="Shop" className="w-48">
              <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Kind" className="w-48">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="cycle">Cycle count</option>
              <option value="full">Full stocktake</option>
            </Select>
          </Field>
          {kind === "cycle" && (
            <Field label="Count" className="w-40">
              <Select value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
                <option value="category">A category</option>
                <option value="products">Chosen products</option>
              </Select>
            </Field>
          )}
          {kind === "cycle" && by === "category" && (
            <Field label="Category" className="w-48">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
          )}
          {kind === "cycle" && by === "products" && (
            <Field label="Add product" className="w-80">
              <Select value="" onChange={(e) => e.target.value && setPicked([...picked, e.target.value])}>
                <option value="">Choose…</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Note" className="w-64">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Monthly back-bar check" />
          </Field>
          <Button
            disabled={pending || !shopId || (kind === "cycle" && by === "products" && !picked.length)}
            onClick={() =>
              run(
                () => startCountAction({ shopId, kind, note, ...(kind === "cycle" ? (by === "category" ? { category } : { productIds: picked }) : {}) }),
                (r) => router.push(`/admin/inventory/counts/${r.id}`),
              )
            }
          >
            Start
          </Button>
        </div>
        {kind === "cycle" && by === "products" && picked.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {picked.map((id) => (
              <button key={id} className="rounded-md bg-zinc-100 px-2 py-1 text-xs hover:bg-zinc-200" onClick={() => setPicked(picked.filter((x) => x !== id))}>
                {products.find((p) => p.id === id)?.name} ×
              </button>
            ))}
          </div>
        )}
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    </Card>
  );
}

interface CountLine {
  productId: string;
  sku: string;
  name: string;
  category: string;
  counted: number | null;
  onHand: number;
  costCents: number;
}

export function CountSheet({ id, kind, lines }: { id: string; kind: "cycle" | "full"; lines: CountLine[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.productId, l.counted === null ? "" : String(l.counted)])));
  const [blind, setBlind] = useState(true);
  const [filter, setFilter] = useState("");
  const [zero, setZero] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const payload = () => lines.map((l) => ({ productId: l.productId, counted: vals[l.productId] === "" || vals[l.productId] === undefined ? null : Math.floor(Number(vals[l.productId])) }));
  const shown = useMemo(() => lines.filter((l) => !filter || `${l.name} ${l.sku}`.toLowerCase().includes(filter.toLowerCase())), [lines, filter]);
  const counted = lines.filter((l) => (vals[l.productId] ?? "") !== "").length;
  const variance = (l: CountLine) => ((vals[l.productId] ?? "") === "" ? null : Math.floor(Number(vals[l.productId])) - l.onHand);
  const varianceCents = lines.reduce((a, l) => a + (variance(l) ?? (zero && kind === "full" ? -l.onHand : 0)) * l.costCents, 0);
  let category = "";

  return (
    <Card>
      <CardHeader
        title={`${counted} of ${lines.length} counted`}
        subtitle="Counts save as you go. Variance is measured against on-hand when you post, so sales made while counting don't show up as missing."
        action={
          <div className="flex items-center gap-3">
            <Input className="w-48" placeholder="Find product" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="flex items-center gap-2 text-sm whitespace-nowrap">
              <input type="checkbox" checked={!blind} onChange={(e) => setBlind(!e.target.checked)} />
              Show expected
            </label>
          </div>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Product</Th>
            {!blind && <Th right>Expected</Th>}
            <Th right>Counted</Th>
            {!blind && <Th right>Variance</Th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => {
            const head = l.category !== category ? (category = l.category) : null;
            const v = variance(l);
            return [
              head && (
                <tr key={`h-${head}`} className="bg-zinc-50">
                  <Td className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{head}</Td>
                  {!blind && <Td />}
                  <Td />
                  {!blind && <Td />}
                </tr>
              ),
              <tr key={l.productId}>
                <Td>
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs text-zinc-500">{l.sku}</div>
                </Td>
                {!blind && <Td right>{l.onHand}</Td>}
                <Td right>
                  <Input
                    aria-label={`Counted ${l.name}`}
                    className="ml-auto w-20 text-right"
                    inputMode="numeric"
                    value={vals[l.productId] ?? ""}
                    onChange={(e) => {
                      setMsg(null);
                      setVals({ ...vals, [l.productId]: e.target.value.replace(/[^0-9]/g, "") });
                    }}
                  />
                </Td>
                {!blind && <Td right className={cx("tabular-nums", v ? (v < 0 ? "text-red-600" : "text-green-700") : "text-zinc-400")}>{v === null ? "—" : v > 0 ? `+${v}` : v}</Td>}
              </tr>,
            ];
          })}
        </tbody>
      </Table>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 p-4">
        <Button variant="secondary" disabled={pending} onClick={() => run(() => saveCountAction(id, payload()), () => setMsg("Saved."))}>
          Save progress
        </Button>
        <Button
          disabled={pending || counted === 0}
          onClick={() =>
            confirm(`Post this count? On-hand changes to what was counted${kind === "full" && zero ? ", and anything not counted goes to zero" : ""}. Estimated variance ${$(varianceCents)} at cost.`) &&
            run(
              () => postCountAction(id, payload(), zero),
              () => router.refresh(),
            )
          }
        >
          Post count
        </Button>
        {kind === "full" && counted < lines.length && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={zero} onChange={(e) => setZero(e.target.checked)} />
            Count the {lines.length - counted} not entered as zero
          </label>
        )}
        {kind === "cycle" && counted < lines.length && <span className="text-xs text-zinc-500">Products left blank are skipped.</span>}
        <span className="flex-1" />
        <Button variant="ghost" disabled={pending} onClick={() => confirm("Cancel this count? Nothing changes in stock.") && run(() => cancelCountAction(id))}>
          Cancel count
        </Button>
        {msg && <span className="text-sm text-green-700">{msg}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </Card>
  );
}
