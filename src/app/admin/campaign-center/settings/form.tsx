"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select, Textarea, buttonClass } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { MarketingSettings } from "@/domain/marketing";
import { saveMarketingSettingsAction } from "../actions";

export function MarketingSettingsForm({ initial, mayEdit, mayExport, campaigns }: { initial: MarketingSettings; mayEdit: boolean; mayExport: boolean; campaigns: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [v, setV] = useState(initial);
  const [campaign, setCampaign] = useState("");
  const set = <K extends keyof MarketingSettings>(k: K, x: MarketingSettings[K]) => (setSaved(false), setV({ ...v, [k]: x }));
  const n = (s: string) => (s === "" ? 0 : Number(s));
  return (
    <>
      {!mayEdit && <Notice tone="blue">The brand sets these for every location. Someone with Campaign Center: create and access to all shops can change them.</Notice>}
      <fieldset disabled={!mayEdit} className="space-y-5">
        <Card>
          <CardHeader title="Quiet hours and limits" subtitle="Nothing marketing goes out in quiet hours, in each location's own time zone; messages due then wait until they end." />
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <Field label="Quiet from">
              <Input type="time" value={v.quietStart} onChange={(e) => set("quietStart", e.target.value)} />
            </Field>
            <Field label="Quiet until">
              <Input type="time" value={v.quietEnd} onChange={(e) => set("quietEnd", e.target.value)} />
            </Field>
            <Field label="Most per client a week" hint="All campaigns and blasts together">
              <Input type="number" min={1} max={14} value={v.capPerWeek} onChange={(e) => set("capPerWeek", n(e.target.value))} />
            </Field>
            <Field label="Most per client in 30 days">
              <Input type="number" min={1} max={60} value={v.capPerMonth} onChange={(e) => set("capPerMonth", n(e.target.value))} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Email and texts" subtitle="Marketing email needs a postal address (CAN-SPAM); every email also carries an unsubscribe link. Texts always say Reply STOP to opt out." />
          <div className="grid gap-3 p-4 md:grid-cols-2">
            <Field label="Brand postal address" hint="Printed at the bottom of every marketing email. Without it, campaigns go by text and push only.">
              <Textarea rows={3} value={v.address} onChange={(e) => set("address", e.target.value)} placeholder="Ray'z Barber Shop, 123 Main St, Coralville, IA 52241" />
            </Field>
            <Field label="Reply to HELP" hint="Sent when a client texts HELP to a location's number.">
              <Textarea rows={3} value={v.helpText} onChange={(e) => set("helpText", e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Reporting" subtitle="A booking or sale within the window after a message counts toward that campaign (the latest message wins). Costs are for ROI." />
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <Field label="Attribution window (days)">
              <Input type="number" min={1} max={60} value={v.attributionDays} onChange={(e) => set("attributionDays", n(e.target.value))} />
            </Field>
            <Field label="Cost per text (¢)">
              <Input type="number" step="0.01" min={0} value={v.smsCostCents} onChange={(e) => set("smsCostCents", n(e.target.value))} />
            </Field>
            <Field label="Cost per email (¢)">
              <Input type="number" step="0.01" min={0} value={v.emailCostCents} onChange={(e) => set("emailCostCents", n(e.target.value))} />
            </Field>
            <Field label="Cost per push (¢)">
              <Input type="number" step="0.01" min={0} value={v.pushCostCents} onChange={(e) => set("pushCostCents", n(e.target.value))} />
            </Field>
          </div>
        </Card>
      </fieldset>
      {error && <Notice tone="red">{error}</Notice>}
      {saved && <Notice tone="green">Saved.</Notice>}
      {mayEdit && (
        <div className="flex justify-end">
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => saveMarketingSettingsAction(v),
                () => setSaved(true),
              )
            }
          >
            Save settings
          </Button>
        </div>
      )}
      {mayExport && (
        <Card>
          <CardHeader title="Export campaign contacts" subtitle="A CSV of clients who agreed to marketing, with the contact details you're allowed to see. Every export is logged." />
          <div className="flex flex-wrap items-end gap-3 p-4">
            <Field label="Who">
              <Select className="w-72" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">Everyone who agreed to marketing</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    Sent {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <a className={buttonClass("secondary")} href={`/admin/campaign-center/export${campaign ? `?campaign=${campaign}` : ""}`}>
              Download CSV
            </a>
          </div>
        </Card>
      )}
    </>
  );
}
