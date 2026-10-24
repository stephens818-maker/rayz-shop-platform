"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Notice, Stat, Table, Td, Th, cx } from "@/components/ui";
import type { ClientPlan } from "@/server/catalog-import";
import { uploadCatalogAction } from "./actions";

type Filter = "all" | "error" | "create" | "update" | "unchanged";
const ACTION: Record<string, { label: string; tone: "green" | "blue" | "gray" | "red" }> = {
  create: { label: "New", tone: "green" },
  update: { label: "Update", tone: "blue" },
  unchanged: { label: "No change", tone: "gray" },
  error: { label: "Error", tone: "red" },
};
const show = (v: string | number | boolean | null) => (v === null || v === "" ? "—" : v === true ? "yes" : v === false ? "no" : String(v));

export function CatalogUploader({ mode, shops, canPushAll }: { mode: "catalog" | "stock"; shops: { id: string; name: string }[]; canPushAll: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [all, setAll] = useState(canPushAll && shops.length > 1);
  const [picked, setPicked] = useState<string[]>(shops.length === 1 ? [shops[0].id] : []);
  const [plan, setPlan] = useState<ClientPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [pending, start] = useTransition();

  const send = (dryRun: boolean) => {
    if (!file) return;
    const f = new FormData();
    f.set("file", file);
    f.set("dryRun", dryRun ? "1" : "0");
    if (all) f.set("allShops", "1");
    else for (const s of picked) f.append("shops", s);
    setError(null);
    start(async () => {
      const r = await uploadCatalogAction(f);
      if (!r.ok) return setError(r.error);
      setPlan(r.data);
      setFilter(r.data.summary.error && !r.data.saved ? "error" : "all");
      if (!dryRun) router.refresh();
    });
  };
  const reset = () => {
    setPlan(null);
    setError(null);
  };

  const rows = plan?.rows.filter((r) => filter === "all" || r.action === filter) ?? [];
  const willSave = plan ? plan.summary.create + plan.summary.update : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="1. Choose a file and shops"
          subtitle={
            mode === "catalog"
              ? "Columns: type, sku, name, category, maker, brand_cost, price, duration_min, tax_category, barcode, active, low_stock_threshold, then price_<shop> and stock_<shop> per shop. Blank cells leave existing values alone."
              : "Only stock_<shop> and low_stock_threshold are used. Other columns are ignored."
          }
        />
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-zinc-600">CSV or XLSX</label>
            <input
              ref={input}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="mt-1 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-ink-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                reset();
              }}
            />
            {file && <p className="mt-1 text-xs text-zinc-500">{(file.size / 1024).toFixed(0)} KB</p>}
          </div>
          <div>
            <div className="text-xs font-medium text-zinc-600">{mode === "catalog" ? "Push items to" : "Update stock at"}</div>
            {shops.length > 1 && canPushAll && (
              <label className="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => {
                    setAll(e.target.checked);
                    reset();
                  }}
                />
                {mode === "catalog" ? "All shops" : "All my shops"}
              </label>
            )}
            {!all && (
              <div className="mt-1 grid grid-cols-2 gap-1">
                {shops.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.includes(s.id)}
                      onChange={() => {
                        setPicked(picked.includes(s.id) ? picked.filter((x) => x !== s.id) : [...picked, s.id]);
                        reset();
                      }}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
            {mode === "catalog" && <p className="mt-1 text-xs text-zinc-500">Shops with a price_ or stock_ value in a row also get that item.</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-3">
          <Button type="button" variant="dark" disabled={!file || pending} onClick={() => send(true)}>
            {pending && !plan ? "Checking…" : "2. Preview (dry run)"}
          </Button>
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </Card>

      {plan && (
        <Card>
          <CardHeader
            title={plan.saved ? "Saved" : "Preview: nothing is saved yet"}
            subtitle={plan.saved ? "Rows with errors were skipped. Download them from Recent uploads, fix and upload again." : "Check the changes below, then save. Rows with errors are skipped."}
            action={
              !plan.saved && (
                <Button type="button" disabled={pending || plan.fileErrors.length > 0 || willSave === 0} onClick={() => send(false)}>
                  {pending ? "Saving…" : `3. Save ${willSave} ${willSave === 1 ? "item" : "items"}`}
                </Button>
              )
            }
          />
          <div className="space-y-3 p-4">
            {plan.fileErrors.map((e) => (
              <Notice key={e} tone="red">
                {e}
              </Notice>
            ))}
            {plan.warnings.map((w) => (
              <Notice key={w}>{w}</Notice>
            ))}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Rows" value={plan.summary.rows} />
              <Stat label="New" value={plan.summary.create} />
              <Stat label="Updated" value={plan.summary.update} hint={plan.summary.stockChanges ? `${plan.summary.stockChanges} stock changes` : undefined} />
              <Stat label="No change" value={plan.summary.unchanged} />
              <Stat label="Errors" value={plan.summary.error} tone={plan.summary.error ? "down" : undefined} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(["all", "error", "create", "update", "unchanged"] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cx("rounded-full px-3 py-1 text-xs ring-1", filter === f ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
                >
                  {f === "all" ? "All rows" : ACTION[f].label}
                </button>
              ))}
            </div>
          </div>
          <Table className="max-h-[560px] overflow-y-auto">
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>SKU</Th>
                <Th>Item</Th>
                <Th>Type</Th>
                <Th>Result</Th>
                <Th>Changes or problems</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.line} className={cx(r.action === "error" && "bg-red-50/50")}>
                  <Td className="tabular text-zinc-500">{r.line}</Td>
                  <Td className="font-mono text-xs">{r.sku || "—"}</Td>
                  <Td>{r.name || "—"}</Td>
                  <Td>{r.kind ?? "—"}</Td>
                  <Td>
                    <Badge tone={ACTION[r.action].tone}>{ACTION[r.action].label}</Badge>
                  </Td>
                  <Td className="text-xs">
                    {r.errors.map((e) => (
                      <div key={e} className="text-red-700">
                        {e}
                      </div>
                    ))}
                    {r.action === "create" && <div className="text-zinc-600">New item{r.changes.length ? `, ${r.changes.length} shop details` : ""}</div>}
                    {r.action !== "create" &&
                      r.changes.slice(0, 6).map((c, i) => (
                        <div key={i}>
                          <span className="text-zinc-500">
                            {c.field.replace(/_/g, " ")}
                            {c.shop ? ` @ ${c.shop}` : ""}:
                          </span>{" "}
                          <span className="line-through decoration-zinc-400">{show(c.from)}</span> → <span className="font-medium">{show(c.to)}</span>
                        </div>
                      ))}
                    {r.changes.length > 6 && r.action !== "create" && <div className="text-zinc-500">+{r.changes.length - 6} more</div>}
                    {r.warnings.map((w) => (
                      <div key={w} className="text-amber-700">
                        {w}
                      </div>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {rows.length > 500 && <p className="p-3 text-xs text-zinc-500">Showing the first 500 of {rows.length} rows.</p>}
        </Card>
      )}
    </div>
  );
}
