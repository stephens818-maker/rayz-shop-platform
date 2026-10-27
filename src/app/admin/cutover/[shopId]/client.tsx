"use client";

import { useState } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { handBackAction, reconcileAction, recordFreezeAction, signOffAction, squireTipsEndAction } from "../actions";

const FILES = [
  { id: "bookings", label: "Appointments (upcoming)" },
  { id: "loyalty", label: "Loyalty balances" },
  { id: "gift_cards", label: "Gift cards" },
  { id: "tickets", label: "Transactions (optional)" },
] as const;

export function FreezeForm({ shopId }: { shopId: string }) {
  const { pending, error, run } = useAction();
  const [local, setLocal] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Squire booking turned off at (shop time)">
        <Input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} className="w-56" />
      </Field>
      <Button disabled={!local || pending} onClick={() => run(() => recordFreezeAction(shopId, local))}>
        Record freeze
      </Button>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function ReconcileForm({ shopId }: { shopId: string }) {
  const { pending, error, run } = useAction();
  const [files, setFiles] = useState<Record<string, { name: string; csv: string }>>({});
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {FILES.map((f) => (
          <Field key={f.id} label={f.label}>
            <input
              type="file"
              accept=".csv,text/csv"
              data-testid={`reconcile-${f.id}`}
              className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-zinc-200"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                const next = { ...files };
                if (file) next[f.id] = { name: file.name, csv: await file.text() };
                else delete next[f.id];
                setFiles(next);
              }}
            />
          </Field>
        ))}
      </div>
      <Button disabled={!Object.keys(files).length || pending} onClick={() => run(() => reconcileAction(shopId, files))}>
        {pending ? "Reconciling…" : "Reconcile"}
      </Button>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function SignOffButton({ shopId, ready, notOnboarded }: { shopId: string; ready: boolean; notOnboarded: number }) {
  const { pending, error, run } = useAction();
  const [sure, setSure] = useState(false);
  const [waiver, setWaiver] = useState("");
  const needsWaiver = notOnboarded > 0;
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={sure} disabled={!ready} onChange={(e) => setSure(e.target.checked)} />
        I&apos;ve checked the reconciliation and Squire booking is off for this shop.
      </label>
      {needsWaiver && (
        <Field
          label={`${notOnboarded} ${notOnboarded === 1 ? "person hasn't" : "people haven't"} finished Stripe payout setup. To switch anyway, say why (goes in the audit log)`}
          hint="Their tips wait for them in held payouts and go out once they finish."
        >
          <Input value={waiver} maxLength={500} disabled={!ready} onChange={(e) => setWaiver(e.target.value)} placeholder="e.g. on leave until next month" />
        </Field>
      )}
      <Button disabled={!ready || !sure || pending || (needsWaiver && !waiver.trim())} onClick={() => run(() => signOffAction(shopId, needsWaiver ? waiver : undefined))}>
        Sign off and book here
      </Button>
      {!ready && <div className="text-xs text-zinc-500">Available once the latest reconciliation matches to the cent.</div>}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function SquireTipsEndForm({ shopId, current }: { shopId: string; current: string | null }) {
  const { pending, error, run } = useAction();
  const [date, setDate] = useState(current ?? "");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Last day Squire pays this shop's tips">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
      </Field>
      <Button variant="secondary" disabled={pending || date === (current ?? "")} onClick={() => run(() => squireTipsEndAction(shopId, date))}>
        {date ? "Save date" : "Clear date"}
      </Button>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function HandBackForm({ shopId, current }: { shopId: string; current: string }) {
  const { pending, error, run } = useAction();
  const [url, setUrl] = useState(current);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Squire booking link">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="w-80" />
      </Field>
      <Button variant="secondary" disabled={!url || pending} onClick={() => run(() => handBackAction(shopId, url))}>
        Hand back to Squire
      </Button>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
