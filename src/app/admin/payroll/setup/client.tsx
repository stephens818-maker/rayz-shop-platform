"use client";

import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import {
  CARD_FEE_BASE_LABEL,
  EXPORT_COLUMNS,
  EXPORT_FORMAT_LABEL,
  FT_BASIS_LABEL,
  HOURS_SOURCE_LABEL,
  LOYALTY_BASE_LABEL,
  OT_REGULAR_RATE_LABEL,
  type CommissionBase,
  type ExportFormat,
  type HoursSource,
  type OtRegularRate,
  type PayrollSettings,
  type TipDeclarationSettings,
  type TipTaxSettings,
} from "@/domain/payroll/calc";
import { calendarProblem, periodsAround, type PayCalendar } from "@/domain/payroll/calendar";
import { formatDate, todayLocal } from "@/lib/time";
import { removeEmployerStateAction, saveEmployerAction, saveEmployerStateAction, savePayGroupAction, savePeriodDatesAction, saveProfileAction } from "../actions";

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
        label="Training hours on top of clocked hours count toward the weekly 40 for overtime (C2)"
        hint="On: Charles says training hours are on top of clocked production hours (Q11), so production plus training over 40 in a Sun–Sat week is overtime, across every shop, shared out to the shops by their hours with training counted. This treats training as hours worked under the FLSA, which the CPA still needs to confirm; turn it off only on the CPA's advice. Training inside the same person's clocked time is already in their hours and is never counted twice. Training pay is training hours × the training rate, outside the greater-of; it and training's share of O.T. Pay are the Training Cost inside labor cost."
        checked={v.trainingCountsTowardOt}
        onChange={(x) => setV({ ...v, trainingCountsTowardOt: x })}
      />
      <Check
        label="Round export values to 2 decimals, half up (6.315 → 6.32)"
        hint="Off: values go out unrounded, exactly as the workbook has them (iSolved's Implied Decimal Places is None). Pending Charles."
        checked={v.roundExport2dp}
        onChange={(x) => setV({ ...v, roundExport2dp: x })}
      />
      <Check
        label="Hours come from the time clock: approve and lock waits for every shop's timesheets to be locked"
        hint="Charles: the basic clock ships at launch. A shop's timesheets lock (Payroll → Timesheets) once each one is manager-approved with no missed punches. Off only for a period whose hours were typed in or imported."
        checked={v.hoursFromClock}
        onChange={(x) => setV({ ...v, hoursFromClock: x })}
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
      </div>
      <p className="text-xs text-zinc-500">
        The iSolved file is always the workbook&apos;s 8 columns. Every tip goes in E_Cash Tips Recd_Dollars: card and cash tips, tips paid out from the drawer or by Stripe, and declared cash
        tips. There are no separate tip codes (Charles declined them). iSolved doesn&apos;t pay that column in the check, so tips owed through payroll are flagged on the run to pay outside it.
      </p>
      <IsolvedFileFields v={v} onChange={(x) => setV({ ...v, ...x })} />
      <BrandCalendarFields cal={v.calendar} onChange={(calendar) => setV({ ...v, calendar })} />
      <DeclarationFields d={v.declarations} onChange={(declarations) => setV({ ...v, declarations })} />
      <TipTaxFields t={v.tipTax} onChange={(tipTax) => setV({ ...v, tipTax })} />
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

const EARNING_LABEL: Record<(typeof EXPORT_COLUMNS)[number]["from"], string> = {
  hours: "Regular hours",
  otHours: "Overtime hours",
  tipsOutside: "Tips already received",
  netComm: "Commission",
  ptoHours: "Paid time",
  trainingHours: "Training hours",
};
const orderText = (xs: string[]) => xs.join(", ");
const orderOf = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The iSolved files and the Payroll Report: what Charles is still to confirm, each with today's behaviour as the default. */
function IsolvedFileFields({ v, onChange }: { v: PayrollSettings; onChange: (x: Partial<PayrollSettings>) => void }) {
  const [report, setReport] = useState(orderText(v.reportOrder));
  const [sheets, setSheets] = useState(orderText(v.sheetOrder));
  return (
    <fieldset className="rounded-lg border border-zinc-200 p-3">
      <legend className="px-1 text-sm font-medium">iSolved files and the Payroll Report</legend>
      <p className="mb-2 text-xs text-zinc-500">
        Names take {"{start}"} and {"{end}"} (MM.DD.YY), {"{startIso}"} and {"{endIso}"}, {"{shop}"} (the sheet name), {"{payGroup}"} and {"{period}"}; &quot;.xlsx&quot; is added. The earning
        codes are the iSolved column headers, character for character. Pending Charles (Q2, Q4, Q9, Q10).
      </p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block text-xs text-zinc-500">Cell formats</span>
          <Select value={v.exportFormat} onChange={(e) => onChange({ exportFormat: e.target.value as ExportFormat })} className="h-9 w-80">
            {Object.entries(EXPORT_FORMAT_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="block text-xs text-zinc-500">A shop&apos;s file name</span>
          <Input value={v.exportFileName} onChange={(e) => onChange({ exportFileName: e.target.value })} className="h-9 w-64" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">The all-shops workbook&apos;s name</span>
          <Input value={v.exportWorkbookName} onChange={(e) => onChange({ exportWorkbookName: e.target.value })} className="h-9 w-64" />
        </label>
        {EXPORT_COLUMNS.map((c) => (
          <label key={c.from}>
            <span className="block text-xs text-zinc-500">{EARNING_LABEL[c.from]} column</span>
            <Input aria-label={`iSolved earning code for ${c.header}`} value={v.earningCodes[c.from]} onChange={(e) => onChange({ earningCodes: { ...v.earningCodes, [c.from]: e.target.value } })} className="h-9 w-56" />
          </label>
        ))}
        <label>
          <span className="block text-xs text-zinc-500">Card surcharge, for commission (I10)</span>
          <Select value={v.commissionBase.cardFee} onChange={(e) => onChange({ commissionBase: { ...v.commissionBase, cardFee: e.target.value as CommissionBase["cardFee"] } })} className="h-9 w-80">
            {Object.entries(CARD_FEE_BASE_LABEL).map(([x, l]) => (
              <option key={x} value={x}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="block text-xs text-zinc-500">A loyalty reward, for commission (I10, Q15)</span>
          <Select value={v.commissionBase.loyalty} onChange={(e) => onChange({ commissionBase: { ...v.commissionBase, loyalty: e.target.value as CommissionBase["loyalty"] } })} className="h-9 w-80">
            {Object.entries(LOYALTY_BASE_LABEL).map(([x, l]) => (
              <option key={x} value={x}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Overtime on commission (FLSA regular rate, C1: Needs Charles)</span>
          <Select value={v.otRegularRate} onChange={(e) => onChange({ otRegularRate: e.target.value as OtRegularRate })} className="h-9 w-[28rem]">
            {Object.entries(OT_REGULAR_RATE_LABEL).map(([x, l]) => (
              <option key={x} value={x}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        {v.otRegularRate === "adjust" && (
          <label>
            <span className="block text-xs text-zinc-500">OT premium adjustment column</span>
            <Input aria-label="iSolved earning code for the OT premium adjustment" value={v.otPremiumHeader} onChange={(e) => onChange({ otPremiumHeader: e.target.value })} className="h-9 w-56" />
          </label>
        )}
        {(["ptoSource", "trainingSource"] as const).map((k) => (
          <label key={k}>
            <span className="block text-xs text-zinc-500">{k === "ptoSource" ? "PTO (Ray'z Paid Time) hours" : "Training hours"} come from</span>
            <Select value={v[k]} onChange={(e) => onChange({ [k]: e.target.value as HoursSource })} className="h-9 w-80">
              {Object.entries(HOURS_SOURCE_LABEL).map(([x, l]) => (
                <option key={x} value={x}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>
      <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <label>
          <span className="block text-xs text-zinc-500">Payroll Report shop order</span>
          <Input
            value={report}
            onChange={(e) => {
              setReport(e.target.value);
              onChange({ reportOrder: orderOf(e.target.value) });
            }}
            className="h-9 w-full"
          />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">All-shops workbook sheet order</span>
          <Input
            value={sheets}
            onChange={(e) => {
              setSheets(e.target.value);
              onChange({ sheetOrder: orderOf(e.target.value) });
            }}
            className="h-9 w-full"
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Card tips under the same code as the tips column (the default) go to iSolved with cash tips as tips already received, as the workbook does; another code gives them their own column. Shops
        not in an order list follow, by name.
      </p>
    </fieldset>
  );
}

const Num = ({ label, value, onChange, step, w = "w-24" }: { label: string; value: number; onChange: (v: number) => void; step?: string; w?: string }) => (
  <label>
    <span className="block text-xs text-zinc-500">{label}</span>
    <Input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={`h-9 ${w}`} />
  </label>
);

/** The brand's pay calendar, with the periods it makes, to check against iSolved's calendar before saving. */
function BrandCalendarFields({ cal, onChange }: { cal: PayCalendar; onChange: (c: PayCalendar) => void }) {
  const problem = calendarProblem(cal);
  const preview = problem ? [] : periodsAround(cal, todayLocal(), 2, 2).reverse();
  return (
    <fieldset className="rounded-lg border border-zinc-200 p-3">
      <legend className="px-1 text-sm font-medium">Brand pay calendar</legend>
      <p className="mb-2 text-xs text-zinc-500">
        Match it to iSolved&apos;s pay calendar. New shops start on it, and so do the brand-wide pay periods (tips by pay period, timesheets). Shops still on the old one move with it; once a
        shop has a locked period, the calendar can only be renumbered, not moved to other dates.
      </p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block text-xs text-zinc-500">A period starts on</span>
          <Input type="date" value={cal.anchorStart} onChange={(e) => onChange({ ...cal, anchorStart: e.target.value })} className="h-9 w-40" />
        </label>
        <Num label="Its iSolved number" value={cal.anchorNumber} onChange={(anchorNumber) => onChange({ ...cal, anchorNumber })} />
        <label>
          <span className="block text-xs text-zinc-500">Length</span>
          <Select value={cal.periodDays} onChange={(e) => onChange({ ...cal, periodDays: Number(e.target.value) })} className="h-9 w-32">
            <option value={14}>Bi-weekly</option>
            <option value={7}>Weekly</option>
          </Select>
        </label>
        <Num label="Due in iSolved, days after the end" value={cal.submitOffsetDays} onChange={(submitOffsetDays) => onChange({ ...cal, submitOffsetDays })} />
        <Num label="Check date, days after the end" value={cal.checkOffsetDays} onChange={(checkOffsetDays) => onChange({ ...cal, checkOffsetDays })} />
        <Check label="Numbers restart each year" checked={cal.numberResetsYearly} onChange={(numberResetsYearly) => onChange({ ...cal, numberResetsYearly })} />
      </div>
      {problem ? (
        <p className="mt-2 text-xs text-red-700">{problem}</p>
      ) : (
        <ul className="mt-2 grid gap-1 text-xs text-zinc-600 sm:grid-cols-2">
          {preview.map((p) => (
            <li key={p.index}>
              Period {p.number}: {formatDate(p.start, "EEE MMM d")} – {formatDate(p.end, "EEE MMM d, yyyy")}, due {formatDate(p.submitBy, "EEE MMM d")}, check {formatDate(p.checkDate, "EEE MMM d")}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function DeclarationFields({ d, onChange }: { d: TipDeclarationSettings; onChange: (d: TipDeclarationSettings) => void }) {
  return (
    <fieldset className="rounded-lg border border-zinc-200 p-3">
      <legend className="px-1 text-sm font-medium">Cash tip declarations</legend>
      <p className="mb-2 text-xs text-zinc-500">
        Employees declare the cash tips handed to them (never rung up) in the staff app and at clock-out. The IRS wants them monthly by the 10th once they reach $20; they go to iSolved in
        E_Cash Tips Recd_Dollars with their other tips, reported and taxed, never paid by the shop. The CPA and iSolved confirm the electronic declaration meets the IRS tip report rules.
      </p>
      <div className="space-y-2">
        <Check label="Employees declare cash tips" checked={d.enabled} onChange={(enabled) => onChange({ ...d, enabled })} />
        <Check label="Ask at clock-out" checked={d.atClockOut} onChange={(atClockOut) => onChange({ ...d, atClockOut })} />
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <Num label="Remind from the 1st through day" value={d.remindUntilDay} onChange={(remindUntilDay) => onChange({ ...d, remindUntilDay })} />
          <Num label="Last month closes after day" value={d.lockDay} onChange={(lockDay) => onChange({ ...d, lockDay })} />
        </div>
        <label className="block text-sm">
          <span className="block text-xs text-zinc-500">What the employee attests to</span>
          <Input value={d.attestation} onChange={(e) => onChange({ ...d, attestation: e.target.value })} className="h-9 w-full" />
        </label>
      </div>
    </fieldset>
  );
}

function TipTaxFields({ t, onChange }: { t: TipTaxSettings; onChange: (t: TipTaxSettings) => void }) {
  return (
    <fieldset className="rounded-lg border border-zinc-200 p-3">
      <legend className="px-1 text-sm font-medium">W-2 tip and overtime codes, 45B FICA tip credit</legend>
      <p className="mb-2 text-xs text-zinc-500">
        For the W-2 codes and 45B reports. Qualified tips and overtime (the FLSA half-time premium) go on the W-2 under their box 12 codes, with each employee&apos;s occupation code (Payroll
        setup, per barber, for box 14b). 45B covers barbering from 2025 at the $7.25 federal minimum wage (2025 Form 8846). The codes, the floor and the start date are the CPA&apos;s and
        iSolved&apos;s to confirm.
      </p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block text-xs text-zinc-500">Qualified tips code</span>
          <Input value={t.qualifiedTipsCode} onChange={(e) => onChange({ ...t, qualifiedTipsCode: e.target.value.toUpperCase() })} className="h-9 w-20" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">Qualified overtime code</span>
          <Input value={t.overtimeCode} onChange={(e) => onChange({ ...t, overtimeCode: e.target.value.toUpperCase() })} className="h-9 w-20" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">45B from</span>
          <Input type="date" value={t.creditFrom} onChange={(e) => onChange({ ...t, creditFrom: e.target.value })} className="h-9 w-40" />
        </label>
        <Num label="45B wage floor ($/h)" step="0.01" value={t.creditWageCentsPerHour / 100} onChange={(x) => onChange({ ...t, creditWageCentsPerHour: Math.round(x * 100) })} />
        <Num label="Employer FICA rate (%)" step="0.01" value={Math.round(t.ficaRate * 10000) / 100} onChange={(x) => onChange({ ...t, ficaRate: x / 100 })} />
      </div>
    </fieldset>
  );
}

export interface GroupRow {
  id: string;
  shop: string;
  label: string;
  legalEntity: string;
  exportTab: string;
  code: string;
  anchorStart: string;
  anchorNumber: number;
  periodDays: number;
  checkOffsetDays: number;
  submitOffsetDays: number;
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
        <Input aria-label="iSolved pay group code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} maxLength={4} className="h-8 w-14 text-xs" />
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
        <Input aria-label="Due in iSolved, days after period end" type="number" value={v.submitOffsetDays} onChange={num("submitOffsetDays")} className="h-8 w-16 text-xs" />
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

export interface PeriodDatesView {
  key: string;
  start: string;
  end: string;
  checkDate: string;
  submitBy: string;
  moved: boolean;
  reason: string | null;
  locked: boolean;
  groups: { label: string; code: string | null; number: number }[];
}

export function PeriodDatesRow({ p }: { p: PeriodDatesView }) {
  const { pending, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState({ checkDate: p.checkDate, submitBy: p.submitBy, reason: "" });
  const numbers = [...new Set(p.groups.map((g) => g.number))];
  const nums = numbers.length === 1 ? String(numbers[0]).padStart(2, "0") : p.groups.map((g) => `${g.label} ${String(g.number).padStart(2, "0")}`).join(", ");
  return (
    <tr className="border-t border-zinc-100 align-top" data-testid={`period-dates-${p.start}`}>
      <td className="px-2 py-1.5 font-medium tabular-nums">{nums}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {formatDate(p.start, "EEE MMM d")} – {formatDate(p.end, "EEE MMM d, yyyy")}
      </td>
      {editing ? (
        <>
          <td className="px-2 py-1.5">
            <Input aria-label="Due in iSolved" type="date" value={v.submitBy} onChange={(e) => setV({ ...v, submitBy: e.target.value })} className="h-8 w-36 text-xs" />
          </td>
          <td className="px-2 py-1.5">
            <Input aria-label="Check date" type="date" value={v.checkDate} onChange={(e) => setV({ ...v, checkDate: e.target.value })} className="h-8 w-36 text-xs" />
          </td>
          <td className="px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Why the dates moved" placeholder="Why (e.g. a holiday)" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} maxLength={200} className="h-8 w-52 text-xs" />
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => savePeriodDatesAction({ start: p.start, end: p.end, ...v }), () => setEditing(false))}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
            {error && <p className="mt-1 max-w-64 text-xs text-red-700">{error}</p>}
          </td>
        </>
      ) : (
        <>
          <td className={`px-2 py-1.5 whitespace-nowrap ${p.moved ? "font-medium text-amber-800" : ""}`}>{formatDate(p.submitBy, "EEE MMM d")}</td>
          <td className={`px-2 py-1.5 whitespace-nowrap ${p.moved ? "font-medium text-amber-800" : ""}`}>
            {formatDate(p.checkDate, "EEE MMM d")}
            {p.reason && <span className="ml-2 text-xs font-normal text-zinc-500">Moved: {p.reason}</span>}
          </td>
          <td className="px-2 py-1.5">
            {p.locked ? (
              <span className="text-xs text-zinc-500">Locked</span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Move dates
              </Button>
            )}
          </td>
        </>
      )}
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
  tippedOccupationCode: string;
  zeroHourlyPay: boolean;
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
        <Input
          aria-label="Tipped occupation code"
          title="Treasury's tipped occupation code for the 2026 W-2 (barber versus front desk). Blank: their tips aren't reported as qualified."
          value={v.tippedOccupationCode}
          onChange={(e) => setV({ ...v, tippedOccupationCode: e.target.value.toUpperCase().slice(0, 8) })}
          className="h-8 w-20 text-xs"
        />
      </td>
      <td className="px-2 py-1.5 text-center">
        <input
          type="checkbox"
          aria-label="$0 hourly pay"
          title="Hours still go to iSolved, but Hourly Total is $0 on the report (the owner's row in the workbook)."
          checked={v.zeroHourlyPay}
          onChange={(e) => setV({ ...v, zeroHourlyPay: e.target.checked })}
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
                tippedOccupationCode: v.tippedOccupationCode,
                zeroHourlyPay: v.zeroHourlyPay,
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

export function EmployerRow({ e }: { e: { id: string; legalName: string; shops: number; isolvedCompanyCode: string; taxIdLast4: string } }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(e);
  return (
    <tr className="border-t border-zinc-100 align-top">
      <td className="px-2 py-1.5 font-medium">{e.legalName}</td>
      <td className="px-2 py-1.5 text-zinc-600">{e.shops}</td>
      <td className="px-2 py-1.5">
        <Input aria-label="iSolved company code" value={v.isolvedCompanyCode} onChange={(x) => setV({ ...v, isolvedCompanyCode: x.target.value })} className="h-8 w-36 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input
          aria-label="Last 4 of the EIN"
          inputMode="numeric"
          maxLength={4}
          autoComplete="off"
          placeholder="1234"
          value={v.taxIdLast4}
          onChange={(x) => setV({ ...v, taxIdLast4: x.target.value.replace(/\D/g, "").slice(0, 4) })}
          className="h-8 w-20 text-xs"
        />
      </td>
      <td className="px-2 py-1.5">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => saveEmployerAction(v))}>
          Save
        </Button>
        {error && <p className="mt-1 max-w-48 text-xs text-red-700">{error}</p>}
      </td>
    </tr>
  );
}

type StateReg = { state: string; withholdingIdLast4: string; unemploymentIdLast4: string; registeredOn: string };
const digits4 = (s: string) => s.replace(/\D/g, "").slice(0, 4);

function StateRegForm({ employerId, r, isNew }: { employerId: string; r: StateReg; isNew?: boolean }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(r);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        aria-label="State"
        value={v.state}
        maxLength={2}
        placeholder="IL"
        disabled={!isNew}
        onChange={(x) => setV({ ...v, state: x.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase() })}
        className="h-7 w-12 text-xs"
      />
      <Input aria-label="Withholding account last 4" placeholder="WH last 4" inputMode="numeric" autoComplete="off" maxLength={4} value={v.withholdingIdLast4} onChange={(x) => setV({ ...v, withholdingIdLast4: digits4(x.target.value) })} className="h-7 w-24 text-xs" />
      <Input aria-label="Unemployment account last 4" placeholder="UI last 4" inputMode="numeric" autoComplete="off" maxLength={4} value={v.unemploymentIdLast4} onChange={(x) => setV({ ...v, unemploymentIdLast4: digits4(x.target.value) })} className="h-7 w-24 text-xs" />
      <Input aria-label="Registered on" type="date" value={v.registeredOn} onChange={(x) => setV({ ...v, registeredOn: x.target.value })} className="h-7 w-36 text-xs" />
      <Button size="sm" variant="secondary" disabled={pending || v.state.length !== 2} onClick={() => run(() => saveEmployerStateAction({ employerId, ...v, registeredOn: v.registeredOn || null }))}>
        {isNew ? "Add state" : "Save"}
      </Button>
      {!isNew && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removeEmployerStateAction({ employerId, state: v.state }))}>
          Remove
        </Button>
      )}
      {error && <p className="w-full text-xs text-red-700">{error}</p>}
    </div>
  );
}

/** Where a legal entity is registered to withhold and pay unemployment tax, against the states its shops are in. */
export function EmployerStatesRow({ e }: { e: { id: string; workStates: string[]; unregistered: string[]; states: StateReg[] } }) {
  return (
    <tr className="border-t border-dashed border-zinc-100">
      <td />
      <td colSpan={4} className="space-y-1.5 px-2 pb-3 pt-1">
        <p className="text-[11px] text-zinc-500">
          State registrations{e.workStates.length ? ` · shops in ${e.workStates.join(", ")}` : ""}. Only the last 4 of each state account number is kept.
        </p>
        {e.unregistered.length > 0 && <p className="text-xs text-amber-700">No registration on file for {e.unregistered.join(", ")}, where this entity has shops.</p>}
        {e.states.map((r) => (
          <StateRegForm key={r.state} employerId={e.id} r={r} />
        ))}
        <StateRegForm key={`new-${e.states.length}`} employerId={e.id} isNew r={{ state: e.unregistered[0] ?? "", withholdingIdLast4: "", unemploymentIdLast4: "", registeredOn: "" }} />
      </td>
    </tr>
  );
}
