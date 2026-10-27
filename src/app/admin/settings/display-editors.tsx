"use client";

import { useState } from "react";
import { useSettingSync } from "@/components/brand-sync";
import { Card, CardHeader, Field, Select } from "@/components/ui";
import { PAYROLL_HOURS_LABEL, PAYROLL_HOURS_STYLES, type PayrollHoursStyle } from "@/domain/display";
import { formatPayHours, setPayrollHoursStyle } from "@/lib/hours";
import { CLOCK_FORMATS, CLOCK_FORMAT_LABEL, minutesToLabel, setClockFormat, type ClockFormat } from "@/lib/time";
import { SaveBar } from "./editors";

/** The brand's time format: 12-hour with AM and PM by default, never Squire's 24-hour unless chosen here. */
export function TimeFormatEditor({ initial, canEdit }: { initial: ClockFormat; canEdit: boolean }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("display.clock");
  const [v, setV] = useState(initial);
  const sample = [9 * 60 + 5, 12 * 60, 17 * 60 + 30].map((m) => minutesToLabel(m, v)).join(", ");
  return (
    <Card>
      <CardHeader
        title="Time format"
        subtitle="How every time reads: the calendar, the time clock, timesheets and punch edits, reports and readable exports, the staff app and client messages. Times are kept in UTC and shown in each shop's time zone."
      />
      <div className="p-4">
        <Field label="Show times as" hint={`For example: ${sample}.`}>
          <Select value={v} disabled={!canEdit} onChange={(e) => setV(e.target.value as ClockFormat)} data-testid="time-format">
            {CLOCK_FORMATS.map((f) => (
              <option key={f} value={f}>
                {CLOCK_FORMAT_LABEL[f]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {canEdit && <SaveBar pending={pending} msg={msg} onClick={() => saveSetting(v, () => setClockFormat(v))} />}
      {dialog}
    </Card>
  );
}

/** Payroll hours on screen: decimal like the payroll workbook, or hours and minutes. The iSolved file stays decimal. */
export function PayrollHoursEditor({ initial, canEdit }: { initial: PayrollHoursStyle; canEdit: boolean }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("display.payroll_hours");
  const [v, setV] = useState(initial);
  return (
    <div data-testid="payroll-hours-style">
      <div className="px-4 py-3">
        <Field label="Show payroll hours as" hint={`For example, 79 hours 56 minutes reads ${formatPayHours(79 + 56 / 60, { style: v })}. The iSolved file always has decimal hours.`}>
        <Select value={v} disabled={!canEdit} onChange={(e) => setV(e.target.value as PayrollHoursStyle)} className="max-w-sm">
          {PAYROLL_HOURS_STYLES.map((s) => (
            <option key={s} value={s}>
              {PAYROLL_HOURS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      </div>
      {canEdit && <SaveBar pending={pending} msg={msg} onClick={() => saveSetting(v, () => setPayrollHoursStyle(v))} />}
      {dialog}
    </div>
  );
}
