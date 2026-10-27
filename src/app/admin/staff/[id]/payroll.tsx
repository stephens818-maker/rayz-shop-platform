"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card, CardHeader, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { saveIsolvedProfileAction } from "../../payroll/actions";

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
