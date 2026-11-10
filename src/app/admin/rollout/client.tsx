"use client";

import { useState } from "react";
import { Button, Input, Select, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { formatDate } from "@/lib/time";
import { importSquireAction, savePlanAction, signCleanPeriodAction } from "./actions";

export function PlanForm({
  shopId,
  periodStarts,
  initial,
}: {
  shopId: string;
  periodStarts: string[];
  initial: { wave: 1 | 2; plannedOn: string; payrollFrom: string; squireBackupUntil: string; note: string };
}) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(initial);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: k === "wave" ? (Number(e.target.value) as 1 | 2) : e.target.value });
  const starts = v.payrollFrom && !periodStarts.includes(v.payrollFrom) ? [v.payrollFrom, ...periodStarts] : periodStarts;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="space-y-0.5">
          <span className="block text-xs text-zinc-500">Wave</span>
          <Select aria-label="Wave" value={v.wave} onChange={set("wave")} className="h-9 w-32">
            <option value={1}>Pilot</option>
            <option value={2}>Second wave</option>
          </Select>
        </label>
        <label className="space-y-0.5">
          <span className="block text-xs text-zinc-500">Planned go-live</span>
          <Input aria-label="Planned go-live" type="date" value={v.plannedOn} onChange={set("plannedOn")} className="h-9 w-40" />
        </label>
        <label className="space-y-0.5">
          <span className="block text-xs text-zinc-500">Payroll from here starting</span>
          <Select aria-label="Payroll from here starting" value={v.payrollFrom} onChange={set("payrollFrom")} className="h-9 w-52">
            <option value="">Not yet: Squire data</option>
            {starts.map((d) => (
              <option key={d} value={d}>
                Pay period of {formatDate(d, "EEE, MMM d")}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-0.5">
          <span className="block text-xs text-zinc-500">Squire backup until</span>
          <Input aria-label="Squire backup until" type="date" value={v.squireBackupUntil} onChange={set("squireBackupUntil")} className="h-9 w-40" />
        </label>
        <Input aria-label="Note" placeholder="Note" value={v.note} onChange={set("note")} className="h-9 w-56" maxLength={300} />
        <Button size="sm" className="h-9" disabled={pending} onClick={() => run(() => savePlanAction(shopId, v), undefined, "Saved")}>
          Save
        </Button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function SquireImport({ shopId, periods }: { shopId: string; periods: { start: string; end: string; imported: boolean }[] }) {
  const { pending, error, run } = useAction();
  const [period, setPeriod] = useState(periods.find((p) => !p.imported)?.start ?? periods[0]?.start ?? "");
  const [file, setFile] = useState({ name: "", text: "" });
  const [result, setResult] = useState<{ errors: string[] } | { rows: number; notes: string[] } | null>(null);
  if (!periods.length) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select aria-label="Pay period" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-9 w-60">
          {periods.map((p) => (
            <option key={p.start} value={p.start}>
              {formatDate(p.start, "MMM d")} – {formatDate(p.end, "MMM d")}
              {p.imported ? " (imported; again replaces it)" : ""}
            </option>
          ))}
        </Select>
        <input
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          aria-label="Squire Commissions report"
          className="text-xs"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setFile({ name: f.name, text: await f.text() });
          }}
        />
        <Button size="sm" disabled={pending || !file.text.trim() || !period} onClick={() => run(() => importSquireAction(shopId, period, file), (r) => setResult(r))}>
          Import
        </Button>
      </div>
      <Textarea
        aria-label="Or paste the report"
        rows={3}
        className="font-mono text-xs"
        placeholder="Or paste Squire's Commissions report here, headers included (Name, Hours Worked, …, Total, …, Tips, …, Tax), service block then product block."
        value={file.name ? "" : file.text}
        onChange={(e) => setFile({ name: "", text: e.target.value })}
      />
      {result && "errors" in result && (
        <ul className="list-disc pl-5 text-xs text-red-700">
          {result.errors.slice(0, 20).map((x) => (
            <li key={x}>{x}</li>
          ))}
          {result.errors.length > 20 && <li>…and {result.errors.length - 20} more. Nothing was imported.</li>}
        </ul>
      )}
      {result && "rows" in result && (
        <div className="text-xs text-emerald-700">
          Imported {result.rows} {result.rows === 1 ? "person" : "people"}.
          {result.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-zinc-600">
              {result.notes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function CleanSignOff({ shopId, periodStart }: { shopId: string; periodStart: string }) {
  const { pending, error, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Input aria-label="What you checked" placeholder="What you checked: paychecks right, iSolved took the file, no complaints" value={note} onChange={(e) => setNote(e.target.value)} className="h-9 w-[28rem]" maxLength={300} />
        <Button size="sm" className="h-9" disabled={pending || note.trim().length < 10} onClick={() => run(() => signCleanPeriodAction(shopId, periodStart, note), undefined, "Signed off")}>
          Sign off clean period
        </Button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
