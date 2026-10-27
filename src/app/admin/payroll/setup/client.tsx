"use client";

import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import { FT_BASIS_LABEL, type PayrollSettings } from "@/domain/payroll/calc";
import { savePayGroupAction, saveProfileAction } from "../actions";

const Check = ({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-start gap-2 text-sm">
    <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>
      {label}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </span>
  </label>
);

export function SettingsForm({ initial, memoRequired }: { initial: PayrollSettings; memoRequired: boolean }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("payroll");
  const [v, setV] = useState(initial);
  const num = (k: keyof PayrollSettings) => (e: { target: { value: string } }) => setV({ ...v, [k]: Number(e.target.value) });
  return (
    <div className="space-y-3">
      <Check
        label="Training hours count toward the weekly 40 for overtime (C2)"
        hint="Off until Charles answers Q11. If Squire's hours already include training, turning this on would count it twice."
        checked={v.trainingCountsTowardOt}
        onChange={(x) => setV({ ...v, trainingCountsTowardOt: x })}
      />
      <Check
        label="Training pay is labor cost on the Payroll Report"
        hint="Training hours × training rate (or the hourly rate). The workbook leaves it out; the platform includes it by default."
        checked={v.trainingPayInCost}
        onChange={(x) => setV({ ...v, trainingPayInCost: x })}
      />
      <Check
        label="Round export values to 2 decimals, half up (6.315 → 6.32)"
        hint="Off: values go out unrounded, exactly as the workbook has them (iSolved's Implied Decimal Places is None). Pending Charles."
        checked={v.roundExport2dp}
        onChange={(x) => setV({ ...v, roundExport2dp: x })}
      />
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block text-xs text-zinc-500">Full time is more than (h/week)</span>
          <Input type="number" step="0.5" value={v.ftHoursPerWeek} onChange={num("ftHoursPerWeek")} className="h-9 w-28" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Hours basis</span>
          <Select value={v.ftBasis} onChange={(e) => setV({ ...v, ftBasis: e.target.value as PayrollSettings["ftBasis"] })} className="h-9 w-56">
            {Object.entries(FT_BASIS_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Rolling window (weeks)</span>
          <Input type="number" min={1} max={26} value={v.ftWindowWeeks} onChange={num("ftWindowWeeks")} className="h-9 w-24" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Weekly OT threshold (h)</span>
          <Input type="number" value={v.otThresholdHours} onChange={num("otThresholdHours")} className="h-9 w-24" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Daily OT over (h, blank = none)</span>
          <Input
            type="number"
            value={v.dailyOtHours ?? ""}
            onChange={(e) => setV({ ...v, dailyOtHours: e.target.value === "" ? null : Number(e.target.value) })}
            className="h-9 w-24"
          />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Report OT multiplier</span>
          <Input type="number" step="0.1" value={v.otMultiplier} onChange={num("otMultiplier")} className="h-9 w-24" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">iSolved column for tips paid in payroll</span>
          <Input value={v.tipsInPayrollHeader} onChange={(e) => setV({ ...v, tipsInPayrollHeader: e.target.value })} className="h-9 w-72" />
        </label>
        <label className="flex items-center gap-2 self-end text-sm" title={memoRequired ? "Required while tips are paid straight to employees through Stripe" : undefined}>
          <input type="checkbox" checked={v.markPaidTips || memoRequired} disabled={memoRequired} onChange={(e) => setV({ ...v, markPaidTips: e.target.checked })} />
          Mark tips already paid out{memoRequired && " (required with Stripe payouts)"}
        </label>
        {(v.markPaidTips || memoRequired) && (
          <label>
            <span className="block text-xs text-zinc-500">iSolved memo column for tips already paid out</span>
            <Input value={v.tipsPaidOutHeader} onChange={(e) => setV({ ...v, tipsPaidOutHeader: e.target.value })} className="h-9 w-72" />
          </label>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        Tips paid out in cash or by Stripe go to iSolved as E_Cash Tips Recd_Dollars (tips the employee already has). Tips paid through payroll go in this column instead, which a shop&apos;s
        file gets only when someone there has such tips. The earning code is to confirm with Charles.
      </p>
      <p className="text-xs text-zinc-500">
        Marked, the tips already paid out by the time the period is locked (cash from the drawer, or Stripe to the employee&apos;s card or bank) also go in the memo column: part of the tips
        received, never paid again. A shop&apos;s file gets it only when someone there was paid tips. The memo code is to confirm with Charles before the first upload.
        {memoRequired &&
          " With tips paid straight to employees through Stripe, the column can't be turned off, and approve and lock checks it per employee against every payout in the period, to the cent (the Payroll tip report shows it)."}
      </p>
      <p className="text-xs text-zinc-500">Full time / part time: exactly {v.ftHoursPerWeek} is part time. Defaults (clocked worked hours over a rolling 4 weeks) are pending Charles. Overtime is weekly over 40 (federal FLSA); Iowa and
        Illinois appear to add no daily rule, which is to confirm before a daily threshold is set.</p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={() => saveSetting(memoRequired ? { ...v, markPaidTips: true } : v)}>
          Save settings
        </Button>
        <SyncMsg msg={msg} />
      </div>
      {dialog}
    </div>
  );
}

export interface GroupRow {
  id: string;
  shop: string;
  label: string;
  legalEntity: string;
  exportTab: string;
  anchorStart: string;
  anchorNumber: number;
  periodDays: number;
  checkOffsetDays: number;
  numberResetsYearly: boolean;
}

export function PayGroupRow({ g, tabs }: { g: GroupRow; tabs: string[] }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(g);
  const txt = (k: keyof GroupRow) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const num = (k: keyof GroupRow) => (e: { target: { value: string } }) => setV({ ...v, [k]: Number(e.target.value) });
  return (
    <tr className="border-t border-zinc-100 align-top">
      <td className="px-2 py-1.5 font-medium">{g.shop}</td>
      <td className="px-2 py-1.5">
        <Input aria-label="Pay group label" value={v.label} onChange={txt("label")} className="h-8 w-36 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="Legal entity" value={v.legalEntity} onChange={txt("legalEntity")} className="h-8 w-32 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="Export tab" list="payroll-tabs" value={v.exportTab} onChange={txt("exportTab")} className="h-8 w-32 text-xs" />
        <datalist id="payroll-tabs">
          {tabs.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="First day of a known period" type="date" value={v.anchorStart} onChange={txt("anchorStart")} className="h-8 w-36 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="That period's number" type="number" value={v.anchorNumber} onChange={num("anchorNumber")} className="h-8 w-16 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Select aria-label="Period length" value={v.periodDays} onChange={num("periodDays")} className="h-8 w-36 text-xs">
          <option value={14}>Bi-weekly</option>
          <option value={7}>Weekly</option>
        </Select>
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="Check date, days after period end" type="number" value={v.checkOffsetDays} onChange={num("checkOffsetDays")} className="h-8 w-16 text-xs" />
      </td>
      <td className="px-2 py-1.5 text-center">
        <input type="checkbox" aria-label="Numbers restart each year" checked={v.numberResetsYearly} onChange={(e) => setV({ ...v, numberResetsYearly: e.target.checked })} />
      </td>
      <td className="px-2 py-1.5">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => savePayGroupAction(v))}>
          Save
        </Button>
        {error && <p className="mt-1 max-w-48 text-xs text-red-700">{error}</p>}
      </td>
    </tr>
  );
}

export interface ProfileRow {
  staffId: string;
  label: string;
  employeeNumber: string;
  keyIsText: boolean;
  isolvedName: string;
  exportPosition: number | null;
  hourlyRate: number;
  servicePct: number;
  productPct: number;
  trainingRate: number | null;
  shopRates: number;
}

export function ProfileRowForm({ p }: { p: ProfileRow }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState({ ...p, servicePct: Math.round(p.servicePct * 10000) / 100, productPct: Math.round(p.productPct * 10000) / 100 });
  return (
    <tr className="border-t border-zinc-100 align-top">
      <td className="px-2 py-1.5 font-medium">{p.label}</td>
      <td className="px-2 py-1.5">
        <Input aria-label="iSolved Employee Number" value={v.employeeNumber} onChange={(e) => setV({ ...v, employeeNumber: e.target.value })} className="h-8 w-28 text-xs" />
      </td>
      <td className="px-2 py-1.5 text-center">
        <input type="checkbox" aria-label="Key is text" checked={v.keyIsText} onChange={(e) => setV({ ...v, keyIsText: e.target.checked })} />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="iSolved name" value={v.isolvedName} onChange={(e) => setV({ ...v, isolvedName: e.target.value })} className="h-8 w-40 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input
          aria-label="Export row order"
          type="number"
          value={v.exportPosition ?? ""}
          onChange={(e) => setV({ ...v, exportPosition: e.target.value === "" ? null : Number(e.target.value) })}
          className="h-8 w-16 text-xs"
        />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="Hourly wage" type="number" step="0.01" value={v.hourlyRate} onChange={(e) => setV({ ...v, hourlyRate: Number(e.target.value) })} className="h-8 w-20 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="Service %" type="number" step="0.5" value={v.servicePct} onChange={(e) => setV({ ...v, servicePct: Number(e.target.value) })} className="h-8 w-16 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input aria-label="Product %" type="number" step="0.5" value={v.productPct} onChange={(e) => setV({ ...v, productPct: Number(e.target.value) })} className="h-8 w-16 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input
          aria-label="Training rate"
          type="number"
          step="0.01"
          placeholder="hourly"
          value={v.trainingRate ?? ""}
          onChange={(e) => setV({ ...v, trainingRate: e.target.value === "" ? null : Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </td>
      <td className="px-2 py-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run(() =>
              saveProfileAction({
                staffId: p.staffId,
                employeeNumber: v.employeeNumber,
                keyIsText: v.keyIsText,
                isolvedName: v.isolvedName,
                exportPosition: v.exportPosition,
                shopId: null,
                hourlyRate: v.hourlyRate,
                servicePct: v.servicePct / 100,
                productPct: v.productPct / 100,
                trainingRate: v.trainingRate,
              }),
            )
          }
        >
          Save
        </Button>
        {p.shopRates > 0 && <p className="mt-1 text-[11px] text-zinc-500">+{p.shopRates} shop-specific rate{p.shopRates === 1 ? "" : "s"}</p>}
        {error && <p className="mt-1 max-w-48 text-xs text-red-700">{error}</p>}
      </td>
    </tr>
  );
}
