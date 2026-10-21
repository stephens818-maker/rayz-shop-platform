"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Notice, Table, Td, Th, cx } from "@/components/ui";
import { errorsCsv } from "@/lib/import-errors";
import { statLines } from "@/lib/import-stats";
import type { ImportKind, ImportResult } from "@/server/importer";
import { importAction } from "./actions";

const KINDS: { id: ImportKind; label: string; hint: string }[] = [
  { id: "clients", label: "1. Clients", hint: "Client list: names, contact, notes, consent, home shop, preferred barber. Import first." },
  { id: "appointments", label: "2. Appointments", hint: "Every past visit (incl. no-shows and cancellations) and upcoming bookings, with services, add-ons, and prices." },
  { id: "transactions", label: "3. Transactions", hint: "Tickets: service and product totals, tips, tax, payment method. Linked to the matching visit." },
  { id: "loyalty", label: "4. Loyalty", hint: "Progress toward the next reward and available rewards. Re-running replaces, never adds." },
  { id: "gift_cards", label: "5. Gift cards", hint: "Code and remaining balance. Existing codes keep working at checkout." },
];

const FIELD_LABEL: Record<string, string> = {
  squireId: "Squire client ID",
  appointmentId: "Appointment ID",
  transactionId: "Transaction ID",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Name",
  phone: "Phone",
  email: "Email",
  notes: "Notes",
  shop: "Shop",
  smsOptIn: "SMS opt-in",
  emailOptIn: "Email opt-in",
  preferredBarber: "Preferred barber",
  clientSince: "Client since",
  date: "Date",
  time: "Time",
  start: "Start",
  bookedAt: "Booked at",
  duration: "Duration",
  barber: "Barber",
  service: "Services",
  addons: "Add-ons",
  price: "Price",
  serviceTotal: "Service total",
  productTotal: "Product total",
  tip: "Tip",
  tax: "Tax",
  discount: "Discount",
  total: "Total",
  paymentMethod: "Payment method",
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
  const [kind, setKind] = useState<ImportKind>("clients");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<(ImportResult & { errorsTruncated: number }) | null>(null);
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

  const reset = (k: ImportKind) => {
    setKind(k);
    setResult(null);
    setError(null);
  };

  return (
    <Card>
      <CardHeader title="Upload a file" subtitle="Import in order: clients, appointments, transactions, loyalty, gift cards." />
      <div className="space-y-4 p-4">
        <div className="grid gap-2 sm:grid-cols-5">
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

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function ResultView({ result }: { result: ImportResult & { errorsTruncated: number } }) {
  const mapped = Object.entries(result.headerMap);
  const reasons = Object.entries(result.skippedByReason).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3">
      <Notice tone={result.dryRun ? "blue" : "green"}>
        {result.dryRun ? "Dry run. Nothing was saved. " : "Imported. "}
        {result.totalRows} rows: {result.inserted} {result.dryRun ? "would be added" : "added"}, {result.updated} {result.dryRun ? "would be updated" : "updated"},{" "}
        {result.skipped} skipped.
      </Notice>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg ring-1 ring-zinc-200">
          <div className="border-b border-zinc-100 px-3 py-2 text-sm font-medium">Reconciliation</div>
          <dl className="divide-y divide-zinc-50 text-sm">
            <div className="flex justify-between px-3 py-1.5">
              <dt>Rows in file</dt>
              <dd className="tabular">{result.totalRows}</dd>
            </div>
            {statLines(result.kind, result.stats).map(([l, v]) => (
              <div key={l} className="flex justify-between px-3 py-1.5">
                <dt>{l}</dt>
                <dd className="tabular">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-lg ring-1 ring-zinc-200">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-sm font-medium">
            <span>Skipped rows by reason</span>
            {result.errors.length > 0 && (
              <button className="text-xs underline" onClick={() => download(`${result.kind}-skipped-rows.csv`, errorsCsv(result.errors))}>
                Download error file
              </button>
            )}
          </div>
          {reasons.length === 0 ? (
            <div className="px-3 py-2 text-sm text-zinc-500">None</div>
          ) : (
            <dl className="divide-y divide-zinc-50 text-sm">
              {reasons.map(([r, n]) => (
                <div key={r} className="flex justify-between px-3 py-1.5">
                  <dt>{r}</dt>
                  <dd className="tabular">{n}</dd>
                </div>
              ))}
            </dl>
          )}
          {result.errorsTruncated > 0 && <div className="px-3 py-2 text-xs text-zinc-500">{result.errorsTruncated} more rows are in the saved run&apos;s error file.</div>}
        </div>
      </div>
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
          <div className="mb-1 text-sm font-medium text-zinc-700">Rows {result.dryRun ? "that will be" : ""} skipped</div>
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Reason</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {result.errors.slice(0, 100).map((e) => (
                <tr key={e.row}>
                  <Td className="tabular">{e.row}</Td>
                  <Td>{e.reason}</Td>
                  <Td>{e.message}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {result.errors.length > 100 && <div className="mt-1 text-xs text-zinc-500">Showing 100 of {result.errors.length}. Download the error file for all of them.</div>}
        </div>
      )}
    </div>
  );
}
