"use client";

import { type ReactNode, useState } from "react";
import { SyncMsg, useSettingSync, useSyncSave } from "@/components/brand-sync";
import { Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import type { SyncFormField } from "@/domain/brand-sync";
import { SaveBar } from "../settings/editors";

/** The name a shop prints for the brand on purchase orders and brand emails. */
export function BrandNameEditor({ initial }: { initial: string }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("brand_name");
  const [v, setV] = useState(initial);
  return (
    <Card>
      <CardHeader title="Brand name" subtitle="Printed on purchase orders and brand emails." />
      <div className="p-4">
        <Field label="Name">
          <Input maxLength={60} value={v} onChange={(e) => setV(e.target.value)} data-testid="brand-name" />
        </Field>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => saveSetting(v)} />
      {dialog}
    </Card>
  );
}

const pctText = (r: number) => (r * 100).toFixed(3).replace(/\.?0+$/, "");

/** The tax rates new shops start with and a sync can push. */
export function BrandTaxEditor({ initial, canEdit }: { initial: { serviceRate: number; productRate: number }; canEdit: boolean }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [svc, setSvc] = useState(pctText(initial.serviceRate));
  const [prd, setPrd] = useState(pctText(initial.productRate));
  return (
    <Card>
      <CardHeader title="Tax rates" subtitle="What new shops start with. Sales tax depends on where each shop is, so check local rates before you push them." />
      <fieldset disabled={!canEdit} className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Service tax %">
          <Input inputMode="decimal" value={svc} onChange={(e) => setSvc(e.target.value)} />
        </Field>
        <Field label="Product tax %">
          <Input inputMode="decimal" value={prd} onChange={(e) => setPrd(e.target.value)} />
        </Field>
      </fieldset>
      {canEdit && (
        <SaveBar
          pending={pending}
          msg={msg}
          onClick={() => save({ label: "Tax rates", changes: [{ type: "taxes", item: "rates", value: { serviceRate: (Number(svc) || 0) / 100, productRate: (Number(prd) || 0) / 100 } }] })}
        />
      )}
      {dialog}
    </Card>
  );
}

type Receipt = { headline: string | null; footer: string | null; showLogo: boolean; showAddress: boolean; showPhone: boolean; allowPrint: boolean };

/** The receipt headline, footer and what it shows, for new shops and to push. Each shop's review link stays its own. */
export function BrandReceiptEditor({ initial, canEdit }: { initial: Receipt; canEdit: boolean }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [v, setV] = useState({ ...initial, headline: initial.headline ?? "", footer: initial.footer ?? "" });
  return (
    <Card>
      <CardHeader title="Receipt branding" subtitle="The headline, footer and parts every shop's digital receipt shows. Each shop keeps its own Google review link." />
      <fieldset disabled={!canEdit} className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Headline" hint={`Blank prints "Ray'z Barber Shop · " and the shop's name.`}>
          <Input maxLength={60} value={v.headline} onChange={(e) => setV({ ...v, headline: e.target.value })} />
        </Field>
        <Field label="Footer" hint="Blank prints the brand's thank-you line.">
          <Input maxLength={200} value={v.footer} onChange={(e) => setV({ ...v, footer: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-4 text-sm text-zinc-700 sm:col-span-2">
          {(
            [
              ["showLogo", "Logo"],
              ["showAddress", "Address"],
              ["showPhone", "Phone"],
              ["allowPrint", "Print button for staff"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      {canEdit && (
        <SaveBar
          pending={pending}
          msg={msg}
          onClick={() => save({ label: "Receipt branding", changes: [{ type: "receipt", item: "branding", value: { ...v, headline: v.headline.trim() || null, footer: v.footer.trim() || null } }] })}
        />
      )}
      {dialog}
    </Card>
  );
}

type Closure = { date: string; reason: string | null };

/** Holiday closures the brand sets: each date goes to the shops picked, and can open them again the same way. */
export interface BrandShopSetting {
  key: string;
  label: string;
  hint: string | null;
  note: string | null;
  fields: readonly SyncFormField[];
  value: Record<string, unknown>;
  canEdit: boolean;
}

/** Settings each shop keeps in its own record (online booking, phone operator, customer screen): set once here and sent to the shops you pick. */
export function BrandShopSettingsEditor({
  settings,
  title = "Shop settings",
  subtitle = "Each shop has its own of these. Set one here, then pick the shops it goes to. A shop that changed its own shows as overridden.",
  children,
}: {
  settings: BrandShopSetting[];
  title?: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      {children}
      <div className="divide-y divide-zinc-100" data-testid="brand-shop-settings">
        {settings.map((s) => (
          <ShopSettingForm key={s.key} setting={s} />
        ))}
      </div>
    </Card>
  );
}

function ShopSettingForm({ setting }: { setting: BrandShopSetting }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [v, setV] = useState(setting.value);
  const set = (k: string, x: unknown) => setV((p) => ({ ...p, [k]: x }));
  return (
    <div className="space-y-3 p-4" data-testid={`shop-setting-${setting.key}`}>
      <div>
        <div className="text-sm font-medium">{setting.label}</div>
        {(setting.note || setting.hint) && <div className="text-xs text-zinc-500">{setting.note ?? setting.hint}</div>}
      </div>
      <fieldset disabled={!setting.canEdit || pending} className="grid gap-3 sm:grid-cols-2">
        {setting.fields.map((f) =>
          f.kind === "bool" ? (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} />
              {f.label}
            </label>
          ) : (
            <Field key={f.key} label={f.label}>
              {f.kind === "choice" ? (
                <Select value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : f.kind === "number" ? (
                <Input type="number" min={f.min} max={f.max} value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value === "" ? null : Number(e.target.value))} />
              ) : (
                <Input maxLength={f.max} value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value || null)} />
              )}
            </Field>
          ),
        )}
      </fieldset>
      {setting.canEdit && (
        <div className="flex items-center gap-3">
          <Button disabled={pending} onClick={() => save({ label: setting.label, changes: [{ type: "shop_setting", item: setting.key, value: v }] })}>
            Save at…
          </Button>
          <SyncMsg msg={msg} />
        </div>
      )}
      {dialog}
    </div>
  );
}

export function BrandClosuresEditor({ closures }: { closures: Closure[] }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const send = (d: string, closed: boolean, why: string | null) => save({ label: `Closed ${d}`, changes: [{ type: "closure", item: d, value: { closed, reason: why } }], onDone: () => (setDate(""), setReason("")) });
  return (
    <Card>
      <CardHeader title="Holiday closures" subtitle="Close the shops you pick on a date: booking stops for the day. Shops' own closed days stay theirs." />
      <ul className="divide-y divide-zinc-100 text-sm" data-testid="brand-closures">
        {closures.length === 0 && <li className="px-4 py-2 text-zinc-500">No upcoming brand closures.</li>}
        {closures.map((c) => (
          <li key={c.date} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span>
              <span className="font-medium">{c.date}</span> · {c.reason || "Closed"}
            </span>
            <span className="flex gap-3">
              <button className="text-xs underline" disabled={pending} onClick={() => send(c.date, true, c.reason)}>
                Close at…
              </button>
              <button className="text-xs text-red-600 underline" disabled={pending} onClick={() => send(c.date, false, c.reason)}>
                Open again at…
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-zinc-100 p-4">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Reason" className="min-w-48 flex-1">
          <Input value={reason} maxLength={60} onChange={(e) => setReason(e.target.value)} placeholder="Christmas Day" />
        </Field>
        <Button disabled={pending || !date} onClick={() => send(date, true, reason.trim() || null)}>
          Close shops…
        </Button>
        <SyncMsg msg={msg} />
      </div>
      {dialog}
    </Card>
  );
}
