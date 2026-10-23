"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Input, Select, Suggestions, cx } from "@/components/ui";
import { saveMasterServiceAction, saveShopServiceAction } from "./actions";

const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
const toCents = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));

type OvRow = {
  id: string;
  name: string;
  kind: "service" | "addon";
  category: string;
  active: boolean;
  defaultPriceCents: number;
  defaultDurationMin: number;
  enabled: boolean;
  bookableOnline: boolean;
  priceCents: number | null;
  durationMin: number | null;
  nameOverride: string | null;
};

export function ShopOverrides({ shopId, shopName, rows }: { shopId: string; shopName: string; rows: OvRow[] }) {
  const [showOff, setShowOff] = useState(false);
  const list = rows.filter((r) => r.active && (showOff || r.enabled));
  return (
    <Card>
      <CardHeader
        title={`${shopName} menu`}
        subtitle="Leave price or length blank to use the brand default."
        action={
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show services that are off here
          </label>
        }
      />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2">Service</th>
              <th className="px-3 py-2">On</th>
              <th className="px-3 py-2">Online</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Minutes</th>
              <th className="px-3 py-2">Name at this shop</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <OverrideRow key={r.id} shopId={shopId} r={r} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OverrideRow({ shopId, r }: { shopId: string; r: OvRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [s, setS] = useState({ enabled: r.enabled, bookableOnline: r.bookableOnline, price: dollars(r.priceCents), dur: r.durationMin?.toString() ?? "", name: r.nameOverride ?? "" });
  const [msg, setMsg] = useState<string | null>(null);
  const dirty =
    s.enabled !== r.enabled || s.bookableOnline !== r.bookableOnline || s.price !== dollars(r.priceCents) || s.dur !== (r.durationMin?.toString() ?? "") || s.name !== (r.nameOverride ?? "");
  return (
    <tr className={cx("border-b border-zinc-100", !s.enabled && "opacity-60")}>
      <td className="px-3 py-2">
        <div className="font-medium">
          {r.kind === "addon" && <span className="text-zinc-400">+ </span>}
          {r.name}
        </div>
        <div className="text-xs text-zinc-500">
          {r.category} · default ${dollars(r.defaultPriceCents)} / {r.defaultDurationMin}m
        </div>
      </td>
      <td className="px-3 py-2">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
      </td>
      <td className="px-3 py-2">
        <input type="checkbox" checked={s.bookableOnline} disabled={!s.enabled} onChange={(e) => setS({ ...s, bookableOnline: e.target.checked })} />
      </td>
      <td className="px-3 py-2">
        <Input className="w-24 py-1" inputMode="decimal" placeholder={dollars(r.defaultPriceCents)} value={s.price} onChange={(e) => setS({ ...s, price: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        <Input className="w-20 py-1" inputMode="numeric" placeholder={String(r.defaultDurationMin)} value={s.dur} onChange={(e) => setS({ ...s, dur: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        <Input className="w-48 py-1" placeholder={r.name} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        {dirty ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await saveShopServiceAction(shopId, r.id, {
                  enabled: s.enabled,
                  bookableOnline: s.bookableOnline,
                  priceCents: toCents(s.price),
                  durationMin: s.dur ? Number(s.dur) : null,
                  nameOverride: s.name || null,
                });
                setMsg(res.ok ? "Saved" : res.error);
                router.refresh();
              })
            }
          >
            Save
          </Button>
        ) : (
          msg && <span className="text-xs text-emerald-700">{msg}</span>
        )}
      </td>
    </tr>
  );
}

type MRow = { id: string; name: string; kind: "service" | "addon"; category: string; description: string | null; defaultPriceCents: number; defaultDurationMin: number; active: boolean; sortOrder: number };

export function MasterEditor({ rows, categories }: { rows: MRow[]; categories: string[] }) {
  const blank: MRow = { id: "", name: "", kind: "service", category: categories[0] ?? "Haircuts", description: null, defaultPriceCents: 3000, defaultDurationMin: 30, active: true, sortOrder: 100 };
  return (
    <Card>
      <CardHeader title="Brand master catalog" subtitle="Brand admins only. New services start turned off at every shop; enable them per shop above." />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Min</th>
              <th className="px-3 py-2">Sort</th>
              <th className="px-3 py-2">Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...rows, blank].map((r) => (
              <MasterRow key={r.id || "new"} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      <Suggestions id="service-categories" items={categories} />
    </Card>
  );
}

function MasterRow({ r }: { r: MRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [s, setS] = useState({ ...r, price: dollars(r.defaultPriceCents) });
  const [msg, setMsg] = useState<string | null>(null);
  const isNew = !r.id;
  return (
    <tr className={cx("border-b border-zinc-100", isNew && "bg-zinc-50/60")}>
      <td className="px-3 py-1.5">
        <Input className="w-56 py-1" placeholder={isNew ? "New service name" : ""} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
      </td>
      <td className="px-3 py-1.5">
        <Select className="w-28 py-1" value={s.kind} onChange={(e) => setS({ ...s, kind: e.target.value as MRow["kind"] })}>
          <option value="service">Service</option>
          <option value="addon">Add-on</option>
        </Select>
      </td>
      <td className="px-3 py-1.5">
        <Input className="w-32 py-1" list="service-categories" value={s.category} onChange={(e) => setS({ ...s, category: e.target.value })} />
      </td>
      <td className="px-3 py-1.5">
        <Input className="w-24 py-1" inputMode="decimal" value={s.price} onChange={(e) => setS({ ...s, price: e.target.value })} />
      </td>
      <td className="px-3 py-1.5">
        <Input className="w-16 py-1" inputMode="numeric" value={s.defaultDurationMin} onChange={(e) => setS({ ...s, defaultDurationMin: Number(e.target.value) || 0 })} />
      </td>
      <td className="px-3 py-1.5">
        <Input className="w-16 py-1" inputMode="numeric" value={s.sortOrder} onChange={(e) => setS({ ...s, sortOrder: Number(e.target.value) || 0 })} />
      </td>
      <td className="px-3 py-1.5">
        <input type="checkbox" checked={s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} />
      </td>
      <td className="px-3 py-1.5">
        <Button
          size="sm"
          variant={isNew ? "primary" : "secondary"}
          disabled={pending || !s.name}
          onClick={() =>
            start(async () => {
              const res = await saveMasterServiceAction({
                id: r.id || null,
                name: s.name,
                kind: s.kind,
                category: s.category,
                description: s.description,
                defaultPriceCents: Math.round(Number(s.price) * 100),
                defaultDurationMin: s.defaultDurationMin,
                active: s.active,
                sortOrder: s.sortOrder,
              });
              setMsg(res.ok ? "Saved" : res.error);
              if (res.ok && isNew) setS({ ...r, price: dollars(r.defaultPriceCents) });
              router.refresh();
            })
          }
        >
          {isNew ? "Add" : "Save"}
        </Button>
        {msg && <Badge className="ml-2">{msg}</Badge>}
      </td>
    </tr>
  );
}
