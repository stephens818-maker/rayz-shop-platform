"use client";

import { useState } from "react";
import { Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { OPERATOR_ANSWER_LABEL, OperatorAnswer, PhoneOperator } from "@/domain/phone-operator";
import { FILING_LABEL, FilingFrequency, stateName } from "@/domain/sales-tax";
import { saveDrawerOpeningAction, savePhoneOperatorAction, saveTaxFilingAction } from "./actions";
import { SaveBar, useSave } from "./editors";

export function DrawerOpeningEditor({ shopId, initialCents }: { shopId: string; initialCents: number }) {
  const { pending, msg, save } = useSave();
  const [amount, setAmount] = useState((initialCents / 100).toFixed(2));
  return (
    <Card>
      <CardHeader title="Cash drawer" subtitle="What the drawer opens with each day. Whoever opens it can count a different amount; the day keeps what they counted." />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Usual opening balance">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveDrawerOpeningAction(shopId, Math.round((Number(amount) || 0) * 100)))} />
    </Card>
  );
}

export function PhoneOperatorEditor({ shopId, initial, hasLine }: { shopId: string; initial: PhoneOperator; hasLine: boolean }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  return (
    <Card>
      <CardHeader
        title="Phone operator"
        subtitle="Answers the shop's Twilio number when nobody at the shop can. Callers press 1 for a text with the booking link, 2 for the hours, or 3 to ring the shop while it's open. Its calls, bookings and minutes saved are on the Phone operator report."
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" disabled={!hasLine && !v.enabled} checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Phone operator on
          {!hasLine && <span className="text-zinc-500">(give the shop a Twilio number first)</span>}
        </label>
        <Field label="Answers">
          <Select value={v.answer} onChange={(e) => setV({ ...v, answer: e.target.value as OperatorAnswer })}>
            {(Object.keys(OPERATOR_ANSWER_LABEL) as OperatorAnswer[]).map((a) => (
              <option key={a} value={a}>
                {OPERATOR_ANSWER_LABEL[a]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Staff minutes per call" hint="For the report's minutes saved">
          <Input inputMode="numeric" value={v.minutesPerCall} onChange={(e) => setV({ ...v, minutesPerCall: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
        </Field>
        <Field label="Greeting" hint="Said before the menu. Leave empty for “Thanks for calling Rays <shop>.”" className="sm:col-span-2">
          <Textarea rows={2} maxLength={300} value={v.greeting ?? ""} onChange={(e) => setV({ ...v, greeting: e.target.value || null })} />
        </Field>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => savePhoneOperatorAction(shopId, v))} />
    </Card>
  );
}

/** How often each state's sales tax is filed; the Sales tax report and its saved shortcuts follow it. */
export function TaxFilingEditor({ states }: { states: { state: string; frequency: FilingFrequency }[] }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(Object.fromEntries(states.map((s) => [s.state, s.frequency])));
  return (
    <Card>
      <CardHeader title="Sales tax filing" subtitle="How often each state is filed. The reports hub keeps a saved Sales tax report for each, set to the last full period." />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        {states.map((s) => (
          <Field key={s.state} label={stateName(s.state)}>
            <Select value={v[s.state]} onChange={(e) => setV({ ...v, [s.state]: e.target.value as FilingFrequency })}>
              {(Object.keys(FILING_LABEL) as FilingFrequency[]).map((f) => (
                <option key={f} value={f}>
                  {FILING_LABEL[f]}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <SaveBar
        pending={pending}
        msg={msg}
        onClick={() =>
          save(async () => {
            for (const s of states) {
              if (v[s.state] === s.frequency) continue;
              const r = await saveTaxFilingAction(s.state, v[s.state]);
              if (!r.ok) return r;
            }
            return { ok: true as const, data: null };
          })
        }
      />
    </Card>
  );
}
