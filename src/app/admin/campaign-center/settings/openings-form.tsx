"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Table, Td, Textarea, Th } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { OPENINGS_FIELDS, OPENINGS_TEMPLATES, type OpeningsSettings, type OpeningsShopRules } from "@/domain/openings";
import { MARKETING_FIELDS } from "@/domain/marketing";
import { saveOpeningsSettingsAction } from "../openings/actions";

const FIELDS = ["first_name", "barber", "shop", "day", "book_link"] as const;
const num = (s: string) => (s === "" ? 0 : Number(s));
const optNum = (s: string) => (s.trim() === "" ? null : Number(s));

/** We have openings' rules for every location, with each location's own limits and approval rule. */
export function OpeningsSettingsForm({ initial, shops, mayEdit }: { initial: OpeningsSettings; shops: { id: string; name: string }[]; mayEdit: boolean }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof OpeningsSettings>(k: K, x: OpeningsSettings[K]) => (setSaved(false), setV({ ...v, [k]: x }));
  const shopRule = (id: string): OpeningsShopRules => v.shops[id] ?? { perDay: null, perWeek: null, approval: null };
  const setShop = (id: string, r: Partial<OpeningsShopRules>) => set("shops", { ...v.shops, [id]: { ...shopRule(id), ...r } });
  const help = (f: (typeof FIELDS)[number]) => (f === "day" ? OPENINGS_FIELDS.day : MARKETING_FIELDS[f]);
  return (
    <section id="openings" className="space-y-5">
      <fieldset disabled={!mayEdit} className="space-y-5">
        <Card>
          <CardHeader
            title="We have openings"
            subtitle="Locations tell a barber's regulars and recent clients about open times today or tomorrow. These are the rules for every location; the weekly and monthly limits above apply too."
          />
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <Field label="One openings message per client every (days)" hint="From any location">
              <Input type="number" min={1} max={60} value={v.capDays} onChange={(e) => set("capDays", num(e.target.value))} />
            </Field>
            <Field label="Blasts a location can send a day" hint="Each barber is one">
              <Input type="number" min={0} max={50} value={v.perDay} onChange={(e) => set("perDay", num(e.target.value))} />
            </Field>
            <Field label="Blasts a location can send in 7 days">
              <Input type="number" min={0} max={200} value={v.perWeek} onChange={(e) => set("perWeek", num(e.target.value))} />
            </Field>
            <Field label="Most clients one blast goes to" hint="Longest since their last visit first">
              <Input type="number" min={1} max={1000} value={v.maxRecipients} onChange={(e) => set("maxRecipients", num(e.target.value))} />
            </Field>
            <Field label="Recent client: a visit with the barber within (days)" hint="Regulars are 2+ visits in a year">
              <Input type="number" min={14} max={365} value={v.recentDays} onChange={(e) => set("recentDays", num(e.target.value))} />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-zinc-700">
              <input type="checkbox" checked={v.approval} onChange={(e) => set("approval", e.target.checked)} />
              The brand approves each blast before it goes
            </label>
          </div>
        </Card>
        <Card>
          <CardHeader title="Openings wording" subtitle={<>Every location uses it. Merge fields: {FIELDS.map((f) => `{${f}}`).join(", ")}.</>} />
          <div className="grid gap-3 p-4 md:grid-cols-2">
            <Field label="Text" hint={`Must say how to opt out. ${FIELDS.map((f) => `{${f}}: ${help(f)}`).join(". ")}.`}>
              <Textarea rows={4} value={v.templates.sms} onChange={(e) => set("templates", { ...v.templates, sms: e.target.value })} />
            </Field>
            <div className="space-y-3">
              <Field label="Email subject">
                <Input value={v.templates.emailSubject} onChange={(e) => set("templates", { ...v.templates, emailSubject: e.target.value })} />
              </Field>
              <Field label="Email" hint="The brand's address and an unsubscribe link are added at the bottom.">
                <Textarea rows={4} value={v.templates.emailBody} onChange={(e) => set("templates", { ...v.templates, emailBody: e.target.value })} />
              </Field>
            </div>
          </div>
          {mayEdit && (
            <div className="px-4 pb-4">
              <button type="button" className="text-xs text-zinc-500 underline" onClick={() => set("templates", { ...OPENINGS_TEMPLATES })}>
                Put back the standard wording
              </button>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Per location" subtitle="Leave blank to follow the rules above." />
          <Table>
            <thead>
              <tr>
                <Th>Location</Th>
                <Th>Blasts a day</Th>
                <Th>Blasts in 7 days</Th>
                <Th>Brand approval</Th>
              </tr>
            </thead>
            <tbody data-testid="openings-shop-rules">
              {shops.map((s) => {
                const r = shopRule(s.id);
                return (
                  <tr key={s.id}>
                    <Td>{s.name}</Td>
                    <Td>
                      <Input type="number" min={0} max={50} placeholder={String(v.perDay)} value={r.perDay ?? ""} onChange={(e) => setShop(s.id, { perDay: optNum(e.target.value) })} className="w-24" aria-label={`${s.name} blasts a day`} />
                    </Td>
                    <Td>
                      <Input type="number" min={0} max={200} placeholder={String(v.perWeek)} value={r.perWeek ?? ""} onChange={(e) => setShop(s.id, { perWeek: optNum(e.target.value) })} className="w-24" aria-label={`${s.name} blasts in 7 days`} />
                    </Td>
                    <Td>
                      <select
                        aria-label={`${s.name} brand approval`}
                        value={r.approval === null ? "" : r.approval ? "yes" : "no"}
                        onChange={(e) => setShop(s.id, { approval: e.target.value === "" ? null : e.target.value === "yes" })}
                        className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-zinc-300"
                      >
                        <option value="">Follow the brand ({v.approval ? "required" : "not required"})</option>
                        <option value="yes">Required</option>
                        <option value="no">Not required</option>
                      </select>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </fieldset>
      {error && <Notice tone="red">{error}</Notice>}
      {saved && <Notice tone="green">Saved.</Notice>}
      {mayEdit && (
        <div className="flex justify-end">
          <Button disabled={pending} onClick={() => run(() => saveOpeningsSettingsAction(v), () => setSaved(true))}>
            Save openings rules
          </Button>
        </div>
      )}
    </section>
  );
}
