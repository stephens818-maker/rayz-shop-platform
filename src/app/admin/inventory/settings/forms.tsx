"use client";

import { useState } from "react";
import { Button, Field, Input, Select, Table, Td, Th } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { SyncMsg, useSettingSync, useSyncSave } from "@/components/brand-sync";
import { saveInventorySettingsAction } from "../actions";

export function ShopSettingsRow({ shop }: { shop: { id: string; name: string; email: string | null; negativeStock: "block" | "warn"; inventoryAlertEmail: string | null } }) {
  const { pending, error, run } = useAction();
  const [negativeStock, setNegative] = useState(shop.negativeStock);
  const [email, setEmail] = useState(shop.inventoryAlertEmail ?? "");
  const [saved, setSaved] = useState(false);
  const dirty = negativeStock !== shop.negativeStock || email !== (shop.inventoryAlertEmail ?? "");
  return (
    <tr className="align-top">
      <Td className="font-medium">{shop.name}</Td>
      <Td>
        <Select
          value={negativeStock}
          onChange={(e) => {
            setSaved(false);
            setNegative(e.target.value as typeof negativeStock);
          }}
        >
          <option value="block">Block: can&apos;t sell or send what isn&apos;t on hand</option>
          <option value="warn">Warn: allow it, flag it, fix it with a count</option>
        </Select>
      </Td>
      <Td>
        <Input
          type="email"
          value={email}
          placeholder={shop.email ? `${shop.email} (shop email)` : "manager@…"}
          onChange={(e) => {
            setSaved(false);
            setEmail(e.target.value);
          }}
        />
      </Td>
      <Td right className="whitespace-nowrap">
        <Button size="sm" disabled={pending || !dirty} onClick={() => run(() => saveInventorySettingsAction({ shopId: shop.id, negativeStock, inventoryAlertEmail: email }), () => setSaved(true))}>
          Save
        </Button>
        {saved && !dirty && <div className="mt-1 text-xs text-green-700">Saved</div>}
        {error && <div className="mt-1 max-w-48 text-xs text-red-600">{error}</div>}
      </Td>
    </tr>
  );
}

export function ApprovalLimit({ cents }: { cents: number | null }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("po_approval");
  const [val, setVal] = useState(cents === null ? "" : (cents / 100).toFixed(2));
  return (
    <div className="flex flex-wrap items-end gap-3 p-4">
      <Field label="Approve orders over" hint="Blank: no approval step. Orders at or under the limit are approved as they're sent." className="w-72">
        <Input
          inputMode="decimal"
          value={val}
          placeholder="No approval step"
          onChange={(e) => setVal(e.target.value)}
        />
      </Field>
      <Button disabled={pending} onClick={() => saveSetting(val.trim() === "" ? null : Math.round((Number(val.replace(/[^0-9.]/g, "")) || 0) * 100))}>
        Save limit
      </Button>
      <SyncMsg msg={msg} className="text-sm" />
      {dialog}
    </div>
  );
}

interface BrandRow {
  productId: string;
  sku: string;
  name: string;
  category: string;
  reorderPoint: number;
  par: number;
  overrides: number;
}

export function BrandLevels({ rows }: { rows: BrandRow[] }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [edit, setEdit] = useState<Record<string, { r: string; p: string }>>({});
  const [filter, setFilter] = useState("");
  const val = (row: BrandRow) => edit[row.productId] ?? { r: String(row.reorderPoint), p: String(row.par) };
  const dirty = rows.filter((row) => edit[row.productId] && (val(row).r !== String(row.reorderPoint) || val(row).p !== String(row.par)));
  const shown = rows.filter((r) => !filter || `${r.name} ${r.sku} ${r.category}`.toLowerCase().includes(filter.toLowerCase()));
  const saveAll = () =>
    save({
      label:
        dirty.length === 1
          ? `${dirty[0].name} stock levels`
          : `Stock levels for ${dirty.length} products`,
      changes: dirty.map((row) => ({
        type: "product",
        item: row.productId,
        value: {
          lowStockThreshold: Math.floor(Number(val(row).r) || 0),
          parLevel: Math.floor(Number(val(row).p) || 0),
        },
      })),
      onDone: () => setEdit({}),
    });
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3">
        <Input className="w-64" placeholder="Find product" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="flex-1" />
        <SyncMsg msg={msg} className="text-sm" />
        {dialog}
        <Button disabled={pending || !dirty.length} onClick={saveAll}>
          {dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}` : "No changes"}
        </Button>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th>Category</Th>
            <Th right>Reorder point</Th>
            <Th right>Par</Th>
            <Th right>Shop overrides</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const v = val(row);
            const set = (patch: Partial<typeof v>) => setEdit({ ...edit, [row.productId]: { ...v, ...patch } });
            return (
              <tr key={row.productId}>
                <Td>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-zinc-500">{row.sku}</div>
                </Td>
                <Td className="text-zinc-600">{row.category}</Td>
                <Td right>
                  <Input aria-label={`Reorder point ${row.name}`} className="ml-auto w-20 text-right" inputMode="numeric" value={v.r} onChange={(e) => set({ r: e.target.value.replace(/[^0-9]/g, "") })} />
                </Td>
                <Td right>
                  <Input aria-label={`Par ${row.name}`} className="ml-auto w-20 text-right" inputMode="numeric" value={v.p} onChange={(e) => set({ p: e.target.value.replace(/[^0-9]/g, "") })} />
                </Td>
                <Td right className="text-zinc-500">
                  {row.overrides || "—"}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
