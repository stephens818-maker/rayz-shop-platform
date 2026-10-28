"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { useSettingSync } from "@/components/brand-sync";
import {
  AFTER_PAYOUT_LABEL,
  DASHBOARD_LABEL,
  ONBOARDING_LABEL,
  OWED_VIA,
  OWED_VIA_LABEL,
  REVERSAL_RULES,
  REVERSAL_RULE_LABEL,
  REVERSAL_WINDOW_DAYS,
  SERVICE_AGREEMENT_LABEL,
  StaffPayoutSettings,
  TAX_FORMS_LABEL,
  TAX_FORM_FILING,
  TIP_DATE_LABEL,
  TIP_DATE_RULES,
  TIP_REFUND_OVERFLOW,
  TIP_REFUND_OVERFLOW_LABEL,
} from "@/domain/staff-payouts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function Choice<T extends string>({ label, hint, value, options, labels, onChange }: { label: string; hint?: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The brand's staff payouts settings (staff_payouts): how barbers' Stripe accounts are made, owed tips, refunds, the tip date and the tax form check. */
export function StaffPayoutsForm({ settings, directPayouts }: { settings: StaffPayoutSettings; directPayouts: boolean }) {
  const [s, set] = useState(settings);
  const { pending, msg, saveSetting, dialog } = useSettingSync("staff_payouts");
  const put = <K extends keyof StaffPayoutSettings>(k: K) => (v: StaffPayoutSettings[K]) => set({ ...s, [k]: v });
  return (
    <Card>
      <CardHeader title="Staff payouts" subtitle="How each barber's Stripe account is made, what happens to tips nobody can pay yet, when a refund takes a tip back, and the yearly tax form check." />
      <div className="space-y-3 p-4">
        {!directPayouts && (
          <Notice tone="blue">
            Direct Stripe payouts are off in this deployment: FEATURE_TIP_TO_BARBER is set to false, or live Stripe keys wait for their end-to-end test (MONEY_MOVEMENT_LIVE). Stripe tips are owed until then; with owed tips through
            payroll, they&rsquo;re paid with the paycheck at the cutoff.
          </Notice>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Barber's Stripe account" hint="A Connect recipient account for every barber: no Stripe Dashboard login, and Ray'z pays Stripe's fees so Stripe sends no 1099.">
            <p className="text-sm text-zinc-700">
              {SERVICE_AGREEMENT_LABEL[s.serviceAgreement]} · Dashboard: {DASHBOARD_LABEL[s.dashboard]}
            </p>
          </Field>
          <Field label="Payout setup" hint="Setup, card and bank changes happen in the staff app with Stripe's embedded components.">
            <p className="text-sm text-zinc-700">{ONBOARDING_LABEL[s.onboarding]}</p>
          </Field>
          <Choice label="Tips nobody can pay directly yet" value={s.owedVia} options={OWED_VIA} labels={OWED_VIA_LABEL} onChange={put("owedVia")} />
          <Choice label="A refund takes the tip back" hint="Otherwise the shop absorbs it. Disputes are always the shop's." value={s.reversalRule} options={REVERSAL_RULES} labels={REVERSAL_RULE_LABEL} onChange={put("reversalRule")} />
          {s.reversalRule === "full_refund_in_window" && (
            <Field label="Reversal window (days after the sale)">
              <Input
                type="number"
                min={REVERSAL_WINDOW_DAYS.min}
                max={REVERSAL_WINDOW_DAYS.max}
                value={s.reversalWindowDays}
                onChange={(e) => put("reversalWindowDays")(Math.min(REVERSAL_WINDOW_DAYS.max, Math.max(REVERSAL_WINDOW_DAYS.min, Math.round(Number(e.target.value) || 0))))}
              />
            </Field>
          )}
          <Field label="A tip refunded after it was paid" hint="Or once it's in a payout, or from an earlier pay period. Never taken back from the barber, so there's nothing to choose.">
            <p className="text-sm text-zinc-700">{AFTER_PAYOUT_LABEL.shop_cost}</p>
          </Field>
          <Choice
            label="A refund bigger than the sale's portion"
            hint="Refunds come out of the shop's portion first. Past it, the tip is already with the barber and never taken back. Confirm with Charles."
            value={s.tipRefundOverflow}
            options={TIP_REFUND_OVERFLOW}
            labels={TIP_REFUND_OVERFLOW_LABEL}
            onChange={put("tipRefundOverflow")}
          />
          <Choice label="A tip belongs to" value={s.tipDate} options={TIP_DATE_RULES} labels={TIP_DATE_LABEL} onChange={put("tipDate")} />
          <Choice label="Stripe tax forms (1099)" value={s.taxForms} options={TAX_FORM_FILING} labels={TAX_FORMS_LABEL} onChange={put("taxForms")} />
          <Field label="Yearly tax form check due in" hint="Before Stripe files for the year just ended; the brand is emailed weekly until it's recorded.">
            <Select value={s.taxCheckMonth} onChange={(e) => put("taxCheckMonth")(Number(e.target.value))}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={s.instantFeeAck} onChange={(e) => put("instantFeeAck")(e.target.checked)} />
          <span>
            Barbers accept Stripe&rsquo;s instant payout fee, as shown, before instant payouts turn on
            <span className="block text-xs text-zinc-500">Instant payouts stay off for everyone until they turn them on.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={s.tipsOnPaycheck} onChange={(e) => put("tipsOnPaycheck")(e.target.checked)} />
          <span>
            Employees can choose to get their tips on their paycheck instead of Stripe deposits
            <span className="block text-xs text-zinc-500">
              Off until Charles decides. Either way, nobody is paid by Stripe deposit without agreeing to it, and tips of anyone who hasn&rsquo;t agreed follow &ldquo;Tips nobody can pay directly yet&rdquo; above.
            </span>
          </span>
        </label>
        {msg && <Notice tone={msg.ok ? "green" : "red"}>{msg.text}</Notice>}
        <Button disabled={pending} onClick={() => saveSetting(s)}>
          Save staff payouts
        </Button>
        {dialog}
      </div>
    </Card>
  );
}
