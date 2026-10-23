"use client";

import { useState } from "react";
import { Button, Input, Select, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { addTimeEntryAction, deleteTimeEntryAction, importTimeCsvAction } from "../actions";

export function AddEntry({ staff, shops, defaultDate }: { staff: { id: string; label: string }[]; shops: { id: string; name: string }[]; defaultDate: string }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState({ staffId: staff[0]?.id ?? "", shopId: shops[0]?.id ?? "", kind: "worked", date: defaultDate, start: "09:00", end: "17:00", note: "" });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <Select aria-label="Barber" value={v.staffId} onChange={set("staffId")} className="h-9 w-40">
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Shop" value={v.shopId} onChange={set("shopId")} className="h-9 w-36">
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Kind" value={v.kind} onChange={set("kind")} className="h-9 w-28">
          <option value="worked">Worked</option>
          <option value="training">Training</option>
          <option value="pto">PTO</option>
        </Select>
        <Input aria-label="Date" type="date" value={v.date} onChange={set("date")} className="h-9 w-40" />
        <Input aria-label="Start" type="time" value={v.start} onChange={set("start")} className="h-9 w-28" />
        <Input aria-label="End" type="time" value={v.end} onChange={set("end")} className="h-9 w-28" />
        <Input aria-label="Note" placeholder="Note" value={v.note} onChange={set("note")} className="h-9 w-48" />
        <Button size="sm" className="h-9" disabled={pending} onClick={() => run(() => addTimeEntryAction(v))}>
          Add
        </Button>
      </div>
      <p className="text-xs text-zinc-500">Shop time (Central). An end before the start runs past midnight.</p>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function ImportCsv() {
  const { pending, error, run } = useAction();
  const [csv, setCsv] = useState("");
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      <Textarea
        aria-label="CSV"
        rows={5}
        className="font-mono text-xs"
        placeholder={"employee,shop,date,start,end,kind,note\n910100,Moline,2026-10-19,9:00,17:30,worked,\nJAMIE,Moline,10/20/2026,7:00 AM,8:45 AM,training,New-hire training"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          className="text-xs"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
        />
        <Button size="sm" disabled={pending || !csv.trim()} onClick={() => run(() => importTimeCsvAction(csv), (n) => (setDone(n), setCsv("")))}>
          Import
        </Button>
        {done !== null && <span className="text-xs text-emerald-700">Imported {done} entries.</span>}
      </div>
      <p className="text-xs text-zinc-500">
        Columns: employee (iSolved Employee Number, iSolved name or the name in the app), shop, date, start, end, and optionally kind (worked, training, pto) and note. Nothing is imported if any
        line has a problem.
      </p>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function DeleteEntry({ id }: { id: string }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <button className="text-xs text-red-700 underline disabled:opacity-50" disabled={pending} onClick={() => run(() => deleteTimeEntryAction(id))}>
        Delete
      </button>
      {error && <span className="ml-1 text-xs text-red-700">{error}</span>}
    </>
  );
}
