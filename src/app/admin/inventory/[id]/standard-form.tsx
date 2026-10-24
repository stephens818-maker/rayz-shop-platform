"use client";

import { useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { LOCAL_PRICES, LOCAL_PRICE_LABEL, type LocalPrice } from "@/domain/brand-standards";
import { saveProductStandardAction } from "../actions";

const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
const toCents = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));

export function ProductStandardForm({ productId, localPrice, floor, ceiling }: { productId: string; localPrice: LocalPrice; floor: number | null; ceiling: number | null }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState({ localPrice, floor: dollars(floor), ceiling: dollars(ceiling) });
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-3 p-4">
      <Field label="Locations">
        <Select value={v.localPrice} onChange={(e) => setV({ ...v, localPrice: e.target.value as LocalPrice })}>
          {LOCAL_PRICES.map((k) => (
            <option key={k} value={k}>
              {LOCAL_PRICE_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Floor">
        <Input className="w-24" inputMode="decimal" disabled={v.localPrice !== "range"} value={v.floor} onChange={(e) => setV({ ...v, floor: e.target.value })} />
      </Field>
      <Field label="Ceiling">
        <Input className="w-24" inputMode="decimal" disabled={v.localPrice !== "range"} value={v.ceiling} onChange={(e) => setV({ ...v, ceiling: e.target.value })} />
      </Field>
      <Button
        disabled={pending}
        onClick={() => run(() => saveProductStandardAction(productId, { localPrice: v.localPrice, priceFloorCents: toCents(v.floor), priceCeilingCents: toCents(v.ceiling) }), () => setSaved(true))}
      >
        {pending ? "Saving…" : "Save"}
      </Button>
      {saved && !pending && <span className="text-xs text-emerald-700">Saved</span>}
      {error && (
        <p role="alert" className="w-full text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
