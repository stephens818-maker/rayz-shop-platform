"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card, CardHeader, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { addDays, formatDate, type LocalDate } from "@/lib/time";
import { formatCents } from "@/lib/money";
import { trainingRateOn } from "@/domain/payroll/training-rate";
import { addTrainingRateAction, deleteTrainingRateAction, saveIsolvedProfileAction } from "../../payroll/actions";

export interface IsolvedProfile {
  employeeNumber: string;
  keyIsText: boolean;
  isolvedName: string;
  zeroHourlyPay: boolean;
}

/** How the employee appears in the iSolved files: their Key (iSolved employee number) and "LAST, FIRST" name. */
export function PayrollIsolvedCard({ staffId, initial }: { staffId: string; initial: IsolvedProfile }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Payroll (iSolved)"
        subtitle="Column A (Key) and column B of each shop's iSolved file. Rates and row order are on Payroll setup."
        action={
          <Link className="text-sm text-brand-700 hover:underline" href="/admin/payroll/setup">
            Payroll setup
          </Link>
        }
      />
      <div className="flex flex-wrap items-end gap-3 px-4 pb-4 text-sm">
        <label>
          <span className="block text-xs text-zinc-500">iSolved employee number (Key)</span>
          <Input aria-label="iSolved employee number" autoComplete="off" value={v.employeeNumber} onChange={(e) => setV({ ...v, employeeNumber: e.target.value })} className="h-9 w-40" />
        </label>
        <label className="flex items-center gap-2 self-center pt-4">
          <input type="checkbox" checked={v.keyIsText} onChange={(e) => setV({ ...v, keyIsText: e.target.checked })} />
          Key is text (keeps leading zeros)
        </label>
        <label>
          <span className="block text-xs text-zinc-500">iSolved name (LAST, FIRST)</span>
          <Input aria-label="iSolved name" value={v.isolvedName} onChange={(e) => setV({ ...v, isolvedName: e.target.value })} className="h-9 w-56" />
        </label>
        <label className="flex items-center gap-2 self-center pt-4" title="Hours still go to iSolved, but Hourly Total is $0 on the Payroll Report.">
          <input type="checkbox" checked={v.zeroHourlyPay} onChange={(e) => setV({ ...v, zeroHourlyPay: e.target.checked })} />
          $0 hourly pay
        </label>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => saveIsolvedProfileAction({ staffId, ...v }), () => setSaved(true))}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved && !error && <span className="text-xs text-emerald-700">Saved</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </Card>
  );
}

export interface TrainingRateRow {
  id: string;
  effectiveFrom: LocalDate;
  rateCents: number;
}

/** Their flat hourly training rate, effective-dated: what training hours are paid at, outside the greater-of. */
export function TrainingRateCard({ staffId, versions, today, lockedThrough, canEdit }: { staffId: string; versions: TrainingRateRow[]; today: LocalDate; lockedThrough: LocalDate | null; canEdit: boolean }) {
  const { pending, error, run } = useAction();
  const earliest = lockedThrough && addDays(lockedThrough, 1) > today ? addDays(lockedThrough, 1) : today;
  const [from, setFrom] = useState(earliest);
  const [rate, setRate] = useState("");
  const current = trainingRateOn(versions, today);
  return (
    <Card>
      <CardHeader
        title="Training rate"
        subtitle={`Training hours are paid at this flat hourly rate, as their own line: never commission or the greater-of. A change starts on a date after the last locked pay period${lockedThrough ? ` (${formatDate(lockedThrough, "MMM d, yyyy")})` : ""}. Without one, Payroll setup's training rate applies, then their hourly rate (flagged on the report).`}
      />
      <div className="space-y-3 px-4 pb-4 text-sm">
        <p>
          Now: <strong>{current ? `${formatCents(current.rateCents)} an hour` : "none set"}</strong>
        </p>
        {versions.length > 0 && (
          <table className="w-full max-w-md text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="py-1">From</th>
                <th className="py-1 text-right">Rate</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className="border-t border-zinc-100">
                  <td className="py-1">{formatDate(v.effectiveFrom, "MMM d, yyyy")}</td>
                  <td className="py-1 text-right tabular-nums">{formatCents(v.rateCents)}</td>
                  <td className="py-1 text-right">
                    {canEdit && v.effectiveFrom > today && (!lockedThrough || v.effectiveFrom > lockedThrough) && (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteTrainingRateAction({ staffId, versionId: v.id }), undefined, "Training rate deleted")}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit ? (
          <div className="flex flex-wrap items-end gap-3">
            <label>
              <span className="block text-xs text-zinc-500">Starts</span>
              <Input aria-label="Training rate starts" type="date" min={earliest} value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
            </label>
            <label>
              <span className="block text-xs text-zinc-500">Dollars an hour</span>
              <Input aria-label="Training rate per hour" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="h-9 w-28" />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || rate.trim() === "" || !Number.isFinite(Number(rate))}
              onClick={() => run(() => addTrainingRateAction({ staffId, effectiveFrom: from, rateCents: Math.round(Number(rate) * 100) }), () => setRate(""), "Training rate added")}
            >
              {pending ? "Saving…" : "Add rate"}
            </Button>
            {error && <span className="text-xs text-red-700">{error}</span>}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">Your own training rate is set by another payroll admin.</p>
        )}
      </div>
    </Card>
  );
}
