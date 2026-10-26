"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Select, Table, Td, Th, cx } from "@/components/ui";
import { useSettingSync } from "@/components/brand-sync";
import { useAction } from "@/components/use-action";
import { DURATION_STEPS, INTERVAL_PRESETS, INTERVAL_SOURCE_LABEL, IntervalSource, durationProblem, intervalProblem } from "@/domain/timing";
import type { BarberRow } from "@/server/timing";
import { saveBarberDurationAction, saveBarberIntervalAction, saveServiceTimingAction, saveShopDurationAction, saveShopIntervalAction } from "./actions";

function Status({ pending, error, saved }: { pending: boolean; error: string | null; saved: boolean }) {
  if (pending) return <span className="text-xs text-zinc-400">Saving…</span>;
  if (error)
    return (
      <span role="alert" className="text-xs text-red-600">
        {error}
      </span>
    );
  if (saved) return <span className="text-xs text-emerald-700">Saved</span>;
  return null;
}

/**
 * 15 / 20 / 30, a custom multiple of 5, or (when there's a level above) follow it. Saves on pick and
 * shows the new value at once; the server's answer replaces it if it refuses.
 */
export function IntervalPicker({
  label,
  value,
  inherited,
  disabled,
  onSave,
}: {
  label: string;
  value: number | null;
  /** What following the level above gives, and its name; omit when there's nothing to follow. */
  inherited?: { minutes?: number; label: string };
  disabled?: boolean;
  onSave: (minutes: number | null) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
}) {
  const { pending, error, setError, run } = useAction();
  const [shown, setShown] = useState(value);
  const [saved, setSaved] = useState(false);
  const isPreset = shown !== null && (INTERVAL_PRESETS as readonly number[]).includes(shown);
  const [custom, setCustom] = useState(shown !== null && !isPreset ? String(shown) : "");
  const save = (n: number | null) => {
    const problem = n === null ? null : intervalProblem(n);
    if (problem) return setError(problem);
    const prev = shown;
    setShown(n);
    setSaved(false);
    run(
      async () => {
        const r = await onSave(n);
        if (!r.ok) setShown(prev);
        return r;
      },
      () => setSaved(true),
    );
  };
  const seg = (active: boolean) =>
    cx(
      "h-8 min-w-11 px-2.5 text-sm font-medium transition first:rounded-l-lg last:rounded-r-lg focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-brand-600",
      active ? "bg-ink-900 text-white" : "bg-white text-zinc-700 hover:bg-zinc-50",
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label={label} className={cx("inline-flex divide-x divide-zinc-200 rounded-lg ring-1 ring-zinc-300", disabled && "opacity-60")}>
        {inherited && (
          <button type="button" role="radio" aria-checked={shown === null} disabled={disabled || pending} className={seg(shown === null)} onClick={() => save(null)} title={`Follow the ${inherited.label}`}>
            {inherited.label}
            {inherited.minutes !== undefined && <span className="tabular"> · {inherited.minutes}</span>}
          </button>
        )}
        {INTERVAL_PRESETS.map((n) => (
          <button key={n} type="button" role="radio" aria-checked={shown === n} disabled={disabled || pending} className={seg(shown === n)} onClick={() => save(n)}>
            {n}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          save(Number(custom));
        }}
      >
        <Input
          aria-label={`${label}: custom minutes`}
          className={cx("h-8 w-20 py-1", shown !== null && !isPreset && "ring-2 ring-ink-900")}
          inputMode="numeric"
          placeholder="Custom"
          disabled={disabled || pending}
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
        />
        <span className="text-xs text-zinc-500">min</span>
        {custom && Number(custom) !== shown && (
          <Button size="sm" variant="secondary" disabled={disabled || pending}>
            Set
          </Button>
        )}
      </form>
      <Status pending={pending} error={error} saved={saved} />
    </div>
  );
}

export function BrandIntervalCard({ minutes, canEdit }: { minutes: number; canEdit: boolean }) {
  const { saveAsync, dialog } = useSettingSync("slot_interval");
  return (
    <Card>
      <CardHeader title="Brand default" subtitle={canEdit ? "Every shop and barber without their own interval uses this. Pick the shops it goes to when you change it." : "Set by someone with access to all shops."} />
      <div className="p-4">
        <IntervalPicker label="Brand default interval" value={minutes} disabled={!canEdit} onSave={(n) => saveAsync(n ?? minutes)} />
      </div>
      {dialog}
    </Card>
  );
}

const sourceTone: Record<IntervalSource, "violet" | "blue" | "gray" | "amber"> = { barber_at_shop: "violet", barber: "blue", shop: "amber", brand: "gray" };
export function SourceBadge({ source, minutes }: { source: IntervalSource; minutes: number }) {
  return (
    <Badge tone={sourceTone[source]} className="tabular">
      {minutes} min · {INTERVAL_SOURCE_LABEL[source]}
    </Badge>
  );
}

export function ShopIntervalsCard({ shops }: { shops: { id: string; name: string; minutes: number | null; brand: number }[] }) {
  return (
    <Card>
      <CardHeader title="Shops" subtitle="A shop's interval applies to its barbers unless they have their own." />
      <ul className="divide-y divide-zinc-100">
        {shops.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-medium text-zinc-900">{s.name}</span>
            <IntervalPicker label={`${s.name} interval`} value={s.minutes} inherited={{ minutes: s.brand, label: "Brand" }} onSave={(n) => saveShopIntervalAction(s.id, n)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function BarberIntervalsCard({ barbers }: { barbers: BarberRow[] }) {
  if (!barbers.length) return null;
  return (
    <Card>
      <CardHeader title="Barbers" subtitle="A barber's own interval beats the shop's; one set for a single shop beats both. Barbers who work at several shops can have a different one at each." />
      <ul className="divide-y divide-zinc-100">
        {barbers.map((b) => (
          <li key={b.id} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: b.color }} />
                {b.label}
                <span className="font-normal text-zinc-500">· all shops</span>
              </span>
              <IntervalPicker label={`${b.label} at all shops`} value={b.minutes} disabled={!b.canSetEverywhere} inherited={{ label: "Each shop's" }} onSave={(n) => saveBarberIntervalAction(b.id, null, n)} />
            </div>
            {b.shops.map((s) => (
              <div key={s.shopId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2">
                <span className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
                  at {s.shopName}
                  <SourceBadge {...s.effective} />
                </span>
                <IntervalPicker
                  label={`${b.label} at ${s.shopName}`}
                  value={s.minutes}
                  inherited={{ minutes: b.minutes ?? s.shopMinutes, label: b.minutes !== null ? "Barber" : s.shopSource === "brand" ? "Brand" : "Shop" }}
                  onSave={(n) => saveBarberIntervalAction(b.id, s.shopId, n)}
                />
              </div>
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export interface ServiceRow {
  id: string;
  name: string;
  kind: "service" | "addon";
  defaultDurationMin: number;
  durationStepMin: number;
  bookingIncrementMin: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** At the shop being edited: null follows the brand; undefined when it isn't on the shop's menu. */
  shopDurationMin?: number | null;
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

function ServiceTimingRow({ r, canEditBrand, shopId, shopName }: { r: ServiceRow; canEditBrand: boolean; shopId: string | null; shopName: string | null }) {
  const brand = useAction();
  const shop = useAction();
  const [saved, setSaved] = useState<"brand" | "shop" | null>(null);
  const [v, setV] = useState({ dur: String(r.defaultDurationMin), step: r.durationStepMin, inc: r.bookingIncrementMin === null ? "" : String(r.bookingIncrementMin), before: String(r.bufferBeforeMin), after: String(r.bufferAfterMin) });
  const [shopDur, setShopDur] = useState(r.shopDurationMin == null ? "" : String(r.shopDurationMin));
  const dirty = v.dur !== String(r.defaultDurationMin) || v.step !== r.durationStepMin || v.inc !== (r.bookingIncrementMin === null ? "" : String(r.bookingIncrementMin)) || v.before !== String(r.bufferBeforeMin) || v.after !== String(r.bufferAfterMin);
  const durHint = durationProblem(Number(v.dur), v.step);
  const shopHint = shopDur ? durationProblem(Number(shopDur), r.durationStepMin) : null;
  const shopDirty = shopDur !== (r.shopDurationMin == null ? "" : String(r.shopDurationMin));
  const cell = "h-8 w-16 py-1 tabular";
  return (
    <tr className="align-top">
      <Td className="whitespace-normal">
        <div className="font-medium text-zinc-900">{r.name}</div>
        <div className="text-xs text-zinc-500">{r.kind === "addon" ? "Add-on: adds to the main service" : "Service"}</div>
      </Td>
      <Td>
        <Input aria-label={`${r.name} duration`} className={cx(cell, durHint && "ring-red-400")} inputMode="numeric" disabled={!canEditBrand} value={v.dur} onChange={(e) => setV({ ...v, dur: e.target.value })} />
      </Td>
      <Td>
        <Select aria-label={`${r.name} duration step`} className="h-8 w-20 py-1" disabled={!canEditBrand} value={v.step} onChange={(e) => setV({ ...v, step: Number(e.target.value) })}>
          {DURATION_STEPS.map((n) => (
            <option key={n} value={n}>
              {n} min
            </option>
          ))}
        </Select>
      </Td>
      <Td>
        <Input aria-label={`${r.name} booking increment`} className={cell} inputMode="numeric" placeholder="Barber" disabled={!canEditBrand || r.kind === "addon"} value={v.inc} onChange={(e) => setV({ ...v, inc: e.target.value })} />
      </Td>
      <Td>
        <Input aria-label={`${r.name} buffer before`} className={cell} inputMode="numeric" disabled={!canEditBrand} value={v.before} onChange={(e) => setV({ ...v, before: e.target.value })} />
      </Td>
      <Td>
        <Input aria-label={`${r.name} buffer after`} className={cell} inputMode="numeric" disabled={!canEditBrand} value={v.after} onChange={(e) => setV({ ...v, after: e.target.value })} />
      </Td>
      <Td>
        {canEditBrand && (
          <div className="flex flex-col items-start gap-1">
            <Button
              size="sm"
              variant={dirty ? "primary" : "secondary"}
              disabled={!dirty || !!durHint || brand.pending}
              onClick={() =>
                brand.run(
                  () =>
                    saveServiceTimingAction(r.id, {
                      defaultDurationMin: Number(v.dur),
                      durationStepMin: v.step,
                      bookingIncrementMin: num(v.inc),
                      bufferBeforeMin: Number(v.before) || 0,
                      bufferAfterMin: Number(v.after) || 0,
                    }),
                  () => setSaved("brand"),
                )
              }
            >
              Save
            </Button>
            {durHint && dirty ? <span className="max-w-48 whitespace-normal text-xs text-red-600">{durHint}</span> : <Status pending={brand.pending} error={brand.error} saved={saved === "brand" && !dirty} />}
          </div>
        )}
      </Td>
      {shopId && (
        <Td className="border-l border-zinc-200">
          {r.shopDurationMin === undefined ? (
            <span className="text-xs text-zinc-400">Not on {shopName}&apos;s menu</span>
          ) : (
            <div className="flex flex-col items-start gap-1">
              <div className="flex items-center gap-1">
                <Input aria-label={`${r.name} duration at ${shopName}`} className={cx(cell, shopHint && "ring-red-400")} inputMode="numeric" placeholder={String(r.defaultDurationMin)} value={shopDur} onChange={(e) => setShopDur(e.target.value)} />
                {shopDirty && (
                  <Button size="sm" variant="secondary" disabled={!!shopHint || shop.pending} onClick={() => shop.run(() => saveShopDurationAction(shopId, r.id, num(shopDur)), () => setSaved("shop"))}>
                    Set
                  </Button>
                )}
              </div>
              {shopHint ? <span className="max-w-48 whitespace-normal text-xs text-red-600">{shopHint}</span> : <Status pending={shop.pending} error={shop.error} saved={saved === "shop" && !shopDirty} />}
            </div>
          )}
        </Td>
      )}
    </tr>
  );
}

export function ServiceTimingCard({ rows, canEditBrand, shop }: { rows: ServiceRow[]; canEditBrand: boolean; shop: { id: string; name: string } | null }) {
  return (
    <Card>
      <CardHeader
        title="Service timing"
        subtitle={
          <>
            Durations snap to the step. A booking increment makes the service start only on its own grid (a long color on the half hour); empty follows the barber. Buffers hold prep and cleanup time on the barber&apos;s calendar and add up with add-ons.
            {!canEditBrand && " Brand timing is set by someone with access to all shops; you can set this shop's durations."}
          </>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Service</Th>
            <Th>Minutes</Th>
            <Th>Step</Th>
            <Th>Increment</Th>
            <Th>Prep before</Th>
            <Th>Cleanup after</Th>
            <Th />
            {shop && <Th className="border-l border-zinc-200">At {shop.name}</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ServiceTimingRow key={r.id} r={r} canEditBrand={canEditBrand} shopId={shop?.id ?? null} shopName={shop?.name ?? null} />
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export interface BarberDurationRow {
  staffId: string;
  barber: string;
  serviceId: string;
  service: string;
  shopId: string | null;
  shop: string;
  minutes: number;
  /** What they'd take without it. */
  usual: number;
}

export function BarberDurationsCard({
  rows,
  barbers,
  services,
}: {
  rows: BarberDurationRow[];
  barbers: { id: string; label: string; canSetEverywhere: boolean; shops: { id: string; name: string }[] }[];
  services: { id: string; name: string; step: number; minutes: number }[];
}) {
  const { pending, error, setError, run } = useAction();
  const [form, setForm] = useState({ staffId: barbers[0]?.id ?? "", serviceId: services[0]?.id ?? "", shopId: "", minutes: "" });
  const barber = barbers.find((b) => b.id === form.staffId);
  const shopId = form.shopId || (barber?.canSetEverywhere ? "" : (barber?.shops[0]?.id ?? ""));
  const service = services.find((s) => s.id === form.serviceId);
  const hint = form.minutes && service ? durationProblem(Number(form.minutes), service.step) : null;
  return (
    <Card>
      <CardHeader title="Barber service times" subtitle="When one barber takes longer or shorter than the menu, for example Casey's fade takes 40 minutes. Set it for every shop they work at, or just one." />
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Barber</Th>
              <Th>Service</Th>
              <Th>Where</Th>
              <Th right>Minutes</Th>
              <Th right>Menu</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.staffId}:${r.serviceId}:${r.shopId}`}>
                <Td className="font-medium text-zinc-900">{r.barber}</Td>
                <Td>{r.service}</Td>
                <Td>{r.shop}</Td>
                <Td right>{r.minutes}</Td>
                <Td right className="text-zinc-500">
                  {r.usual}
                </Td>
                <Td right>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => saveBarberDurationAction(r.staffId, r.serviceId, r.shopId, null))}>
                    Remove
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        className="flex flex-wrap items-end gap-2 border-t border-zinc-100 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!form.minutes) return setError("Enter the minutes");
          run(
            () => saveBarberDurationAction(form.staffId, form.serviceId, shopId || null, Number(form.minutes)),
            () => setForm({ ...form, minutes: "" }),
          );
        }}
      >
        <label className="text-xs font-medium text-zinc-700">
          Barber
          <Select className="mt-1 w-40" value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value, shopId: "" })}>
            {barbers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs font-medium text-zinc-700">
          Service
          <Select className="mt-1 w-56" value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })}>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.minutes} min)
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs font-medium text-zinc-700">
          Where
          <Select className="mt-1 w-44" value={shopId} onChange={(e) => setForm({ ...form, shopId: e.target.value })}>
            {barber?.canSetEverywhere && <option value="">Every shop</option>}
            {barber?.shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} only
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs font-medium text-zinc-700">
          Minutes
          <Input className={cx("mt-1 w-24 tabular", hint && "ring-red-400")} inputMode="numeric" placeholder={service ? String(service.minutes) : ""} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value.replace(/\D/g, "") })} />
        </label>
        <Button disabled={pending || !!hint || !form.staffId || !form.serviceId || (!shopId && !barber?.canSetEverywhere)}>Save time</Button>
        {(hint || error) && (
          <span role="alert" className="basis-full text-xs text-red-600">
            {hint ?? error}
          </span>
        )}
      </form>
    </Card>
  );
}

/** On the shop settings page: this shop's interval, with the rest one click away. */
export function ShopTimingCard({ shopId, shopName, minutes, brand }: { shopId: string; shopName: string; minutes: number | null; brand: number }) {
  return (
    <Card>
      <CardHeader
        title="Booking slot interval"
        subtitle="Start times offered online and at the front desk, and the rows on the calendar. Barbers can have their own."
        action={
          <Link className="text-xs font-medium text-brand-700 underline" href={`/admin/booking-times?shop=${shopId}`}>
            Barbers and service timing
          </Link>
        }
      />
      <div className="p-4">
        <IntervalPicker label={`${shopName} interval`} value={minutes} inherited={{ minutes: brand, label: "Brand" }} onSave={(n) => saveShopIntervalAction(shopId, n)} />
      </div>
    </Card>
  );
}

/** On a barber's profile: their interval everywhere and at each shop they work at. */
export function StaffTimingCard({ barber }: { barber: BarberRow }) {
  return (
    <Card>
      <CardHeader
        title="Booking slot interval"
        subtitle="Their start times and the rows of their calendar column. Set it for every shop, or differently at each shop they work at."
        action={
          <Link className="text-xs font-medium text-brand-700 underline" href="/admin/booking-times">
            Service times
          </Link>
        }
      />
      <div className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium text-zinc-900">All shops</span>
          <IntervalPicker label={`${barber.label} at all shops`} value={barber.minutes} disabled={!barber.canSetEverywhere} inherited={{ label: "Each shop's" }} onSave={(n) => saveBarberIntervalAction(barber.id, null, n)} />
        </div>
        {barber.shops.map((s) => (
          <div key={s.shopId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2">
            <span className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
              {s.shopName}
              <SourceBadge {...s.effective} />
            </span>
            <IntervalPicker
              label={`${barber.label} at ${s.shopName}`}
              value={s.minutes}
              inherited={{ minutes: barber.minutes ?? s.shopMinutes, label: barber.minutes !== null ? "Barber" : s.shopSource === "brand" ? "Brand" : "Shop" }}
              onSave={(n) => saveBarberIntervalAction(barber.id, s.shopId, n)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
