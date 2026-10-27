"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { BrandTipPolicy, DEFAULT_CARD_DELAY, METHOD_LABEL, SCHEDULE_LABEL, ShopTipSettings, TIP_METHODS, TIP_SCHEDULES, TipMethod, TipSchedule } from "@/domain/tips";
import { saveShopTipSettingsAction } from "../actions";
import { useSettingSync } from "@/components/brand-sync";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return { pending, msg, save };
}

export function PolicyForm({ policy }: { policy: BrandTipPolicy }) {
  const [p, setP] = useState(policy);
  const { pending, msg, saveSetting, dialog } = useSettingSync("tip_payouts");
  const toggle = (m: TipMethod, on: boolean) => setP({ ...p, methods: on ? TIP_METHODS.filter((x) => x === m || p.methods.includes(x)) : p.methods.filter((x) => x !== m) });
  return (
    <Card>
      <CardHeader title="Brand policy" subtitle="The payout methods shops may use, and whether employees choose their own." />
      <div className="space-y-3 p-4">
        <div className="space-y-2">
          {TIP_METHODS.map((m) => (
            <Check key={m} checked={p.methods.includes(m)} onChange={(v) => toggle(m, v)}>
              {METHOD_LABEL[m]}
              {m === "stripe" && <span className="block text-xs text-zinc-500">Each employee sets up their own Stripe Express account on Stripe&rsquo;s page; the app never sees their bank details.</span>}
              {m === "payroll" && <span className="block text-xs text-zinc-500">Not paid separately: the tips go to iSolved with the pay period.</span>}
            </Check>
          ))}
        </div>
        <Check checked={p.employeeChooses} onChange={(v) => setP({ ...p, employeeChooses: v })}>
          Employees choose their own method from these
        </Check>
        <Check checked={p.instantAllowed} onChange={(v) => setP({ ...p, instantAllowed: v })}>
          Allow Stripe instant payouts to an eligible debit card (Stripe&rsquo;s instant fee is shown before the employee chooses it)
        </Check>
        {p.instantAllowed && (
          <div className="ml-6">
            <Check checked={p.instantFeePassedOn} onChange={(v) => setP({ ...p, instantFeePassedOn: v })}>
              Pass the instant payout fee on to the employee
              <span className="block text-xs text-zinc-500">
                On: it comes out of their payout. Off: they get every cent and the shop pays the fee on top, out of the same account the tips come from.
              </span>
            </Check>
          </div>
        )}
        {msg && <Notice tone={msg.ok ? "green" : "red"}>{msg.text}</Notice>}
        <Button disabled={pending || !p.methods.length} onClick={() => saveSetting(p)}>
          Save brand policy
        </Button>
        {dialog}
      </div>
    </Card>
  );
}

export function ShopTipForm({ shopId, shopName, settings, policy }: { shopId: string; shopName: string; settings: ShopTipSettings; policy: BrandTipPolicy }) {
  const [s, setS] = useState(settings);
  const { pending, msg, save } = useSave();
  const setSchedule = (schedule: TipSchedule) =>
    setS({ ...s, schedule, cardDelayDays: s.schedule === schedule ? s.cardDelayDays : DEFAULT_CARD_DELAY[schedule], defaultMethod: schedule === "payroll" ? "payroll" : s.defaultMethod === "payroll" ? policy.methods.find((m) => m !== "payroll") ?? "cash" : s.defaultMethod });
  return (
    <Card>
      <CardHeader title={shopName} />
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <Field label="Payout schedule" className="md:col-span-2">
          <Select value={s.schedule} onChange={(e) => setSchedule(e.target.value as TipSchedule)}>
            {TIP_SCHEDULES.filter((x) => x !== "payroll" || policy.methods.includes("payroll")).map((x) => (
              <option key={x} value={x}>
                {SCHEDULE_LABEL[x]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Card tips wait (days)" hint="Card tips become payable this many days after the sale, once the card money has settled. Cash tips are payable at once.">
          <Input type="number" min={0} max={14} value={s.cardDelayDays} onChange={(e) => setS({ ...s, cardDelayDays: Math.max(0, Math.min(14, Math.trunc(Number(e.target.value) || 0))) })} />
        </Field>
        {s.schedule === "weekly" ? (
          <Field label="Weekly on">
            <Select value={s.weeklyDay} onChange={(e) => setS({ ...s, weeklyDay: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div />
        )}
        {s.schedule !== "payroll" && (
          <Field label={policy.employeeChooses ? "Default method (for employees who haven't chosen)" : "Method"}>
            <Select value={s.defaultMethod} onChange={(e) => setS({ ...s, defaultMethod: e.target.value as TipMethod })}>
              {policy.methods.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="md:col-span-2">
          <Check checked={s.netCardFee} onChange={(v) => setS({ ...s, netCardFee: v })}>
            Take each card tip&rsquo;s share of the card processing fee out of the payout
            <span className="block text-xs text-amber-700">Confirm with the brand&rsquo;s accountant or lawyer before turning this on: some states don&rsquo;t allow it, and it changes what&rsquo;s reported.</span>
          </Check>
        </div>
        <div className="md:col-span-2 flex items-center gap-3">
          <Button disabled={pending} onClick={() => save(() => saveShopTipSettingsAction(shopId, s))}>
            Save {shopName}
          </Button>
          {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
        </div>
      </div>
    </Card>
  );
}
