"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Notice, Table, Td, Th, cx } from "@/components/ui";
import type { ImportResult } from "@/server/importer";
import { importAction } from "./actions";

type Kind = "clients" | "appointments" | "loyalty" | "gift_cards";

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: "clients", label: "1. Clients", hint: "Client list export. Import first so the other files can match clients." },
  { id: "appointments", label: "2. Appointments", hint: "History and future bookings. Past rows feed reports and KPIs; future rows land on the calendar." },
  { id: "loyalty", label: "3. Loyalty", hint: "Progress toward the next reward and available rewards, per client." },
  { id: "gift_cards", label: "4. Gift cards", hint: "Code and remaining balance. Existing codes keep working at checkout." },
];

const FIELD_LABEL: Record<string, string> = {
  squireId: "Squire client ID",
  appointmentId: "Appointment ID",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Name",
  phone: "Phone",
  email: "Email",
  notes: "Notes",
  shop: "Shop",
  smsOptIn: "SMS opt-in",
  date: "Date",
  time: "Time",
  start: "Start",
  duration: "Duration",
  barber: "Barber",
  service: "Service",
  price: "Price",
  status: "Status",
  progress: "Loyalty progress",
  rewards: "Rewards",
  code: "Code",
  balance: "Balance",
  initial: "Original amount",
  expires: "Expires",
};

export function Importer() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("clients");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (dryRun: boolean) => {
    if (!file) return;
    setError(null);
    start(async () => {
      const r = await importAction({ kind, csv: file.text, filename: file.name, dryRun });
      if (!r.ok) {
        setError(r.error);
        setResult(null);
        return;
      }
      setResult(r.data);
      if (!dryRun) router.refresh();
    });
  };

  const reset = (k: Kind) => {
    setKind(k);
    setResult(null);
    setError(null);
  };

  return (
    <Card>
      <CardHeader title="Upload a file" subtitle="Import in order: clients, appointments, loyalty, gift cards." />
      <div className="space-y-4 p-4">
        <div className="grid gap-2 sm:grid-cols-4">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => reset(k.id)}
              className={cx(
                "rounded-lg p-3 text-left text-sm ring-1 transition",
                kind === k.id ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white ring-zinc-200 hover:ring-zinc-400",
              )}
            >
              <div className="font-semibold">{k.label}</div>
              <div className={cx("mt-1 text-xs", kind === k.id ? "text-zinc-300" : "text-zinc-500")}>{k.hint}</div>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-zinc-200"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setResult(null);
              setError(null);
              setFile(f ? { name: f.name, text: await f.text() } : null);
            }}
          />
          <Button variant="secondary" disabled={!file || pending} onClick={() => run(true)}>
            {pending ? "Checking…" : "Dry run"}
          </Button>
          <Button disabled={!file || pending || !result?.dryRun} onClick={() => run(false)} title={!result?.dryRun ? "Run a dry run first" : undefined}>
            Commit import
          </Button>
        </div>
        {error && <Notice tone="red">{error}</Notice>}
        {result && <ResultView result={result} />}
      </div>
    </Card>
  );
}

function ResultView({ result }: { result: ImportResult }) {
  const mapped = Object.entries(result.headerMap);
  return (
    <div className="space-y-3">
      <Notice tone={result.dryRun ? "blue" : "green"}>
        {result.dryRun ? "Dry run. Nothing was saved. " : "Imported. "}
        {result.totalRows} rows: {result.inserted} {result.dryRun ? "would be added" : "added"}, {result.updated} {result.dryRun ? "would be updated" : "updated"},{" "}
        {result.skipped} skipped.
      </Notice>
      <div className="text-sm">
        <div className="mb-1 font-medium text-zinc-700">Columns recognized</div>
        <div className="flex flex-wrap gap-1.5">
          {mapped.length === 0 && <span className="text-zinc-500">None. Is this the right file type?</span>}
          {mapped.map(([field, header]) => (
            <span key={field} className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs">
              {FIELD_LABEL[field] ?? field} ← <span className="font-mono">{header}</span>
            </span>
          ))}
        </div>
      </div>
      {result.errors.length > 0 && (
        <div>
          <div className="mb-1 text-sm font-medium text-zinc-700">Rows that will be skipped</div>
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {result.errors.map((e) => (
                <tr key={e.row}>
                  <Td className="tabular">{e.row}</Td>
                  <Td>{e.message}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
