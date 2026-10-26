"use client";

import { useState } from "react";
import { useSyncSave } from "@/components/brand-sync";
import { Card, CardHeader, Field, Input } from "@/components/ui";
import { SaveBar } from "../settings/editors";

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
