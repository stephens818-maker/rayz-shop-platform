"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { Channel, TRIGGERS, TriggerKey, Templates } from "@/domain/marketing";
import { saveAutomationAction, setLocationAutomationAction } from "../../actions";
import { ChannelOrder, TemplateFields } from "../../template-fields";
import { TestSend } from "../../test-send";

interface Automation {
  id: string;
  trigger: TriggerKey;
  name: string;
  channels: Channel[];
  templates: Templates;
  settings: Record<string, number>;
  promoId: string | null;
}
interface Location {
  shopId: string;
  shopName: string;
  enabled: boolean;
  templates: Partial<Templates> | null;
  settings: Record<string, number> | null;
}
type Coupon = { id: string; code: string; summary: string; unique: boolean };

export function AutomationEditor({
  automation,
  locations,
  coupons,
  address,
  mayBrand,
  mayWrite,
  maySwitch,
}: {
  automation: Automation;
  locations: Location[];
  coupons: Coupon[];
  address: string;
  /** Campaign Center: create, with access to every shop. */
  mayBrand: boolean;
  /** Campaign Center: create. */
  mayWrite: boolean;
  /** Campaign Center: send. */
  maySwitch: boolean;
}) {
  const def = TRIGGERS[automation.trigger];
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [v, setV] = useState(automation);
  const edit = (x: Partial<Automation>) => (setSaved(false), setV({ ...v, ...x }));
  const shops = locations.map((l) => ({ id: l.shopId, name: l.shopName }));
  return (
    <>
      <Card>
        <CardHeader
          title="The brand's campaign"
          subtitle={mayBrand ? "Every location uses this unless it has its own wording or settings." : "Written by the brand. Your locations can switch it on and reword it below."}
        />
        <div className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name">
              <Input value={v.name} disabled={!mayBrand} onChange={(e) => edit({ name: e.target.value })} />
            </Field>
            <Field label="Coupon" hint={coupons.find((c) => c.id === v.promoId)?.unique ? "Each client gets their own single-use code." : "Add one in Promos to offer a discount."}>
              <Select value={v.promoId ?? ""} disabled={!mayBrand} onChange={(e) => edit({ promoId: e.target.value || null })}>
                <option value="">No coupon</option>
                {coupons.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}: {c.summary}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {def.settings.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-3">
              {def.settings.map((s) => (
                <Field key={s.key} label={s.label} hint={`${s.min} to ${s.max} ${s.unit}`}>
                  <Input type="number" min={s.min} max={s.max} value={v.settings[s.key] ?? s.default} disabled={!mayBrand} onChange={(e) => edit({ settings: { ...v.settings, [s.key]: Number(e.target.value) } })} />
                </Field>
              ))}
            </div>
          )}
          <Field label="Channels, in the order they're tried">
            <ChannelOrder value={v.channels} disabled={!mayBrand} onChange={(channels) => edit({ channels })} />
          </Field>
          <TemplateFields value={v.templates} channels={v.channels} disabled={!mayBrand} address={address} extraFields={def.fields} onChange={(templates) => edit({ templates })} />
          {error && <Notice tone="red">{error}</Notice>}
          {saved && <Notice tone="green">Saved. Locations that use the brand&apos;s wording send this from now on.</Notice>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-3">
            {mayWrite || maySwitch ? <TestSend campaignId={v.id} channels={v.channels} shops={shops} templates={v.templates} /> : <span />}
            {mayBrand && (
              <Button
                disabled={pending}
                onClick={() =>
                  run(
                    () => saveAutomationAction(v.id, { name: v.name, channels: v.channels, templates: v.templates, settings: v.settings, promoId: v.promoId }),
                    () => setSaved(true),
                  )
                }
              >
                Save campaign
              </Button>
            )}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="At each location" subtitle="Switched on per location. A location can use its own wording or settings; blank fields follow the brand." />
        <div className="divide-y divide-zinc-100">
          {locations.map((l) => (
            <LocationRow key={l.shopId} automation={v} location={l} address={address} mayWrite={mayWrite} maySwitch={maySwitch} />
          ))}
          {!locations.length && <p className="p-4 text-sm text-zinc-500">No locations.</p>}
        </div>
      </Card>
    </>
  );
}

function LocationRow({ automation, location, address, mayWrite, maySwitch }: { automation: Automation; location: Location; address: string; mayWrite: boolean; maySwitch: boolean }) {
  const disabled = !mayWrite;
  const def = TRIGGERS[automation.trigger];
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(location.enabled);
  const [ownWording, setOwnWording] = useState(!!location.templates && Object.keys(location.templates).length > 0);
  const [ownSettings, setOwnSettings] = useState(!!location.settings);
  const [templates, setTemplates] = useState<Templates>({ ...automation.templates, ...(location.templates ?? {}) });
  const [settings, setSettings] = useState<Record<string, number>>(location.settings ?? automation.settings);
  const changed = () => setSaved(false);
  const overrides = () => Object.fromEntries(Object.entries(templates).filter(([k, x]) => x.trim() && x !== automation.templates[k as keyof Templates]));
  return (
    <div className="space-y-3 p-4" data-testid={`location-${location.shopName}`}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-40 font-semibold">{location.shopName}</div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} disabled={!maySwitch} onChange={(e) => (changed(), setEnabled(e.target.checked))} />
          On
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ownWording} disabled={disabled} onChange={(e) => (changed(), setOwnWording(e.target.checked))} />
          Own wording
        </label>
        {def.settings.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ownSettings} disabled={disabled} onChange={(e) => (changed(), setOwnSettings(e.target.checked))} />
            Own settings
          </label>
        )}
        {(mayWrite || maySwitch) && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={pending}
            onClick={() =>
              run(
                () => setLocationAutomationAction({ campaignId: automation.id, shopId: location.shopId, enabled, templates: ownWording ? overrides() : null, settings: ownSettings ? settings : null }),
                () => setSaved(true),
              )
            }
          >
            Save {location.shopName}
          </Button>
        )}
      </div>
      {ownSettings && (
        <div className="grid gap-3 sm:grid-cols-3">
          {def.settings.map((s) => (
            <Field key={s.key} label={s.label} hint={`Brand: ${automation.settings[s.key]} ${s.unit}`}>
              <Input type="number" min={s.min} max={s.max} value={settings[s.key] ?? s.default} disabled={disabled} onChange={(e) => (changed(), setSettings({ ...settings, [s.key]: Number(e.target.value) }))} />
            </Field>
          ))}
        </div>
      )}
      {ownWording && (
        <>
          <TemplateFields value={templates} channels={automation.channels} disabled={disabled} address={address} extraFields={def.fields} onChange={(t) => (changed(), setTemplates(t))} />
          {!disabled && <TestSend campaignId={automation.id} channels={automation.channels} shops={[{ id: location.shopId, name: location.shopName }]} templates={templates} />}
        </>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      {saved && <Notice tone="green">Saved for {location.shopName}.</Notice>}
    </div>
  );
}
