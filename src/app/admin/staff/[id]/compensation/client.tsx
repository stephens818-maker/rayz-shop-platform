"use client";

import { useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { GUARANTEE_LABEL, GUARANTEE_PERS, RENT_FREQUENCIES, RENT_LABEL, TIER_MODE_LABEL, type GuaranteePer, type RentFrequency, type TierMode } from "@/domain/compensation";
import type { TipMethod } from "@/domain/tips";
import { addVersionAction, deleteVersionAction, saveCustomValuesAction, type VersionForm } from "./actions";

/** A version as the form edits it: dollars and percents as typed. */
export interface Draft {
  effectiveFrom: string;
  hourly: string;
  shopHourly: Record<string, string>;
  servicePct: string;
  overrides: { kind: "service" | "category"; ref: string; pct: string }[];
  tiers: { from: string; pct: string }[];
  tierMode: TierMode;
  productPct: string;
  rent: string;
  rentFrequency: RentFrequency | "";
  guarantee: string;
  guaranteePer: GuaranteePer | "";
  tipMethod: TipMethod | "";
  note: string;
}

const blank = (s: string) => s.trim() === "";
const amount = (s: string) => Number(s.replace(/[$,\s]/g, ""));

/** The form's text as a version, or what's wrong with it. */
function toVersion(d: Draft): VersionForm | string {
  const bad: string[] = [];
  const cents = (s: string, what: string) => {
    if (blank(s)) return null;
    const n = amount(s);
    if (!Number.isFinite(n)) bad.push(`${what} must be a dollar amount`);
    return Math.round(n * 100);
  };
  const pct = (s: string, what: string) => {
    if (blank(s)) return null;
    const n = Number(s.replace(/[%\s]/g, ""));
    if (!Number.isFinite(n)) bad.push(`${what} must be a percent`);
    return Math.round(n * 10000) / 1000000;
  };
  const v: VersionForm = {
    effectiveFrom: d.effectiveFrom,
    hourlyRateCents: cents(d.hourly, "The hourly rate"),
    shopHourlyRates: Object.entries(d.shopHourly)
      .filter(([, s]) => !blank(s))
      .map(([shopId, s]) => ({ shopId, cents: cents(s, "A location's hourly rate") ?? 0 })),
    servicePct: pct(d.servicePct, "Service commission"),
    serviceOverrides: d.overrides.filter((o) => o.ref).map((o) => ({ kind: o.kind, ref: o.ref, pct: pct(o.pct, "A service or category rate") ?? 0 })),
    serviceTiers: d.tiers.filter((t) => !blank(t.from) || !blank(t.pct)).map((t) => ({ fromCents: cents(t.from, "A tier's monthly sales") ?? 0, pct: pct(t.pct, "A tier's rate") ?? 0 })),
    tierMode: d.tierMode,
    productPct: pct(d.productPct, "Product commission"),
    boothRentCents: cents(d.rent, "Booth rent"),
    boothRentFrequency: d.rentFrequency || null,
    guaranteeCents: cents(d.guarantee, "The guaranteed minimum"),
    guaranteePer: d.guaranteePer || null,
    tipMethod: d.tipMethod || null,
    note: d.note,
  };
  return bad[0] ?? v;
}

export function VersionEditor({
  staffId,
  initial,
  earliest,
  earliestHint,
  shops,
  services,
  categories,
  tipMethods,
  hints,
}: {
  staffId: string;
  initial: Draft;
  earliest: string;
  earliestHint: string;
  shops: { id: string; name: string }[];
  services: { id: string; name: string; category: string }[];
  categories: string[];
  tipMethods: { value: TipMethod; label: string }[];
  hints: { hourly: string; servicePct: string; productPct: string; tipMethod: string };
}) {
  const { pending, error, setError, run } = useAction();
  const [d, setD] = useState(initial);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false);
    setD((x) => ({ ...x, [k]: v }));
  };
  const save = () => {
    const v = toVersion(d);
    if (typeof v === "string") return setError(v);
    run(() => addVersionAction(staffId, v), () => setSaved(true));
  };
  return (
    <div className="space-y-4 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Takes effect" hint={earliestHint}>
          <Input type="date" min={earliest} value={d.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} className="h-9 w-44" />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Hourly</legend>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Hourly rate ($)" hint={`Blank: Payroll setup's (${hints.hourly})`}>
            <Input inputMode="decimal" value={d.hourly} onChange={(e) => set("hourly", e.target.value)} className="h-9 w-28" />
          </Field>
          {shops.length > 1 &&
            shops.map((s) => (
              <Field key={s.id} label={`At ${s.name} ($)`} hint="Blank: the rate above">
                <Input inputMode="decimal" value={d.shopHourly[s.id] ?? ""} onChange={(e) => set("shopHourly", { ...d.shopHourly, [s.id]: e.target.value })} className="h-9 w-28" />
              </Field>
            ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Service commission</legend>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Default %" hint={`Blank: Payroll setup's (${hints.servicePct})`}>
            <Input inputMode="decimal" value={d.servicePct} onChange={(e) => set("servicePct", e.target.value)} className="h-9 w-24" />
          </Field>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-zinc-500">Rates for particular services or categories. A service&apos;s own rate beats its category&apos;s; both beat the tiers and the default.</p>
          {d.overrides.map((o, i) => {
            const put = (x: Partial<typeof o>) => set("overrides", d.overrides.map((y, j) => (j === i ? { ...y, ...x } : y)));
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Service or category" value={o.kind} onChange={(e) => put({ kind: e.target.value as typeof o.kind, ref: "" })} className="h-8 w-32 text-xs">
                  <option value="service">Service</option>
                  <option value="category">Category</option>
                </Select>
                <Select aria-label={o.kind === "service" ? "Service" : "Category"} value={o.ref} onChange={(e) => put({ ref: e.target.value })} className="h-8 w-56 text-xs">
                  <option value="">Pick…</option>
                  {o.kind === "service"
                    ? services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.category})
                        </option>
                      ))
                    : categories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                </Select>
                <Input aria-label="Rate %" inputMode="decimal" placeholder="%" value={o.pct} onChange={(e) => put({ pct: e.target.value })} className="h-8 w-20 text-xs" />
                <Button size="sm" variant="ghost" onClick={() => set("overrides", d.overrides.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            );
          })}
          <Button size="sm" variant="secondary" onClick={() => set("overrides", [...d.overrides, { kind: "service", ref: "", pct: "" }])}>
            Add a service or category rate
          </Button>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-zinc-500">
            Tiers by monthly net service sales (after discounts and refunds), counted from the 1st of each month. Below the first tier, the default % applies.
          </p>
          {d.tiers.map((t, i) => {
            const put = (x: Partial<typeof t>) => set("tiers", d.tiers.map((y, j) => (j === i ? { ...y, ...x } : y)));
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500">From $</span>
                <Input aria-label="Monthly sales from" inputMode="decimal" value={t.from} onChange={(e) => put({ from: e.target.value })} className="h-8 w-28 text-xs" />
                <span className="text-xs text-zinc-500">a month:</span>
                <Input aria-label="Tier rate %" inputMode="decimal" placeholder="%" value={t.pct} onChange={(e) => put({ pct: e.target.value })} className="h-8 w-20 text-xs" />
                <Button size="sm" variant="ghost" onClick={() => set("tiers", d.tiers.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => set("tiers", [...d.tiers, { from: "", pct: "" }])}>
              Add a tier
            </Button>
            {d.tiers.length > 0 && (
              <Select aria-label="How tiers pay" value={d.tierMode} onChange={(e) => set("tierMode", e.target.value as TierMode)} className="h-8 w-80 text-xs">
                {Object.entries(TIER_MODE_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="flex flex-wrap items-end gap-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Products, booth rent and guarantee</legend>
        <Field label="Product commission %" hint={`Blank: Payroll setup's (${hints.productPct})`}>
          <Input inputMode="decimal" value={d.productPct} onChange={(e) => set("productPct", e.target.value)} className="h-9 w-24" />
        </Field>
        <Field label="Booth rent ($)" hint="Blank: none">
          <div className="flex gap-1">
            <Input inputMode="decimal" value={d.rent} onChange={(e) => set("rent", e.target.value)} className="h-9 w-24" />
            <Select aria-label="Booth rent is due" value={d.rentFrequency} onChange={(e) => set("rentFrequency", e.target.value as Draft["rentFrequency"])} className="h-9 w-40">
              <option value="">—</option>
              {RENT_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {RENT_LABEL[f]}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="Guaranteed minimum ($)" hint="Payroll tops their pay up to this when it's short. Blank: none">
          <div className="flex gap-1">
            <Input inputMode="decimal" value={d.guarantee} onChange={(e) => set("guarantee", e.target.value)} className="h-9 w-24" />
            <Select aria-label="Guaranteed minimum per" value={d.guaranteePer} onChange={(e) => set("guaranteePer", e.target.value as Draft["guaranteePer"])} className="h-9 w-36">
              <option value="">—</option>
              {GUARANTEE_PERS.map((p) => (
                <option key={p} value={p}>
                  {GUARANTEE_LABEL[p]}
                </option>
              ))}
            </Select>
          </div>
        </Field>
      </fieldset>

      <fieldset className="flex flex-wrap items-end gap-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Tips</legend>
        <Field label="Tips paid by" hint={hints.tipMethod}>
          <Select value={d.tipMethod} onChange={(e) => set("tipMethod", e.target.value as Draft["tipMethod"])} className="h-9 w-56">
            <option value="">Their choice or the shop&apos;s default</option>
            {tipMethods.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>

      <Field label="Note (optional)" hint="Why it changed. No bank, card, SSN or tax ID numbers: those stay with Stripe and iSolved.">
        <Textarea rows={2} maxLength={500} value={d.note} onChange={(e) => set("note", e.target.value)} />
      </Field>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={save}>
          Save this change
        </Button>
        {saved && !error && <span className="text-xs text-green-700">Saved.</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}

export function DeleteVersion({ staffId, versionId }: { staffId: string; versionId: string }) {
  const { pending, error, run } = useAction();
  return (
    <span>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Withdraw this change? It hasn't started yet.") && run(() => deleteVersionAction(staffId, versionId))}>
        Withdraw
      </Button>
      {error && <span className="block text-xs text-red-700">{error}</span>}
    </span>
  );
}

export interface FieldRow {
  id: string;
  label: string;
  kind: "text" | "number" | "percent" | "date" | "dropdown";
  options: string[];
  value: string;
}

export function FieldValues({ staffId, fields }: { staffId: string; fields: FieldRow[] }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(Object.fromEntries(fields.map((f) => [f.id, f.value])));
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap gap-3">
        {fields.map((f) => {
          const on = (x: string) => {
            setSaved(false);
            setV({ ...v, [f.id]: x });
          };
          return (
            <Field key={f.id} label={f.kind === "percent" ? `${f.label} (%)` : f.label}>
              {f.kind === "dropdown" ? (
                <Select value={v[f.id]} onChange={(e) => on(e.target.value)} className="h-9 w-48">
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={f.kind === "date" ? "date" : "text"}
                  inputMode={f.kind === "number" || f.kind === "percent" ? "decimal" : undefined}
                  maxLength={200}
                  value={v[f.id]}
                  onChange={(e) => on(e.target.value)}
                  className="h-9 w-48"
                />
              )}
            </Field>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => saveCustomValuesAction(staffId, v), () => setSaved(true))}>
          Save fields
        </Button>
        {saved && !error && <span className="text-xs text-green-700">Saved.</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}
