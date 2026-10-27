"use client";

import { useState } from "react";
import { Button, Input, Notice, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { declareCashTipsAction, managerDeclareAction } from "./actions";

export interface DeclarationRow {
  id: string;
  shopId: string;
  businessDate: string;
  amountCents: number;
}

/**
 * Declaring cash tips for a day, or correcting a declaration (it keeps the shop and day). For
 * themselves they check the attestation; a manager entering someone's gives a reason instead.
 */
export function DeclareCashTips({
  shops,
  today,
  attestation,
  staffId,
  correcting,
  onDone,
}: {
  shops: { id: string; name: string }[];
  today: string;
  attestation: string;
  /** A manager entering someone else's. */
  staffId?: string;
  correcting?: DeclarationRow | null;
  onDone?: () => void;
}) {
  const { pending, error, run } = useAction();
  const [shopId, setShopId] = useState(correcting?.shopId ?? shops[0]?.id ?? "");
  const [date, setDate] = useState(correcting?.businessDate ?? today);
  const [amount, setAmount] = useState(correcting ? (correcting.amountCents / 100).toFixed(2) : "");
  const [attest, setAttest] = useState(false);
  const [reason, setReason] = useState("");
  const manager = !!staffId;
  const cents = Math.round(Number(amount) * 100);
  const ready = amount.trim() !== "" && Number.isFinite(cents) && cents >= 0 && (manager || attest) && (!(manager || correcting) || reason.trim());

  const submit = () =>
    run(
      () => {
        const v = { shopId, businessDate: date, amountCents: cents, attest, replacesId: correcting?.id ?? null, reason: reason.trim() || null };
        return staffId ? managerDeclareAction({ ...v, staffId }) : declareCashTipsAction(v);
      },
      () => {
        setAmount("");
        setAttest(false);
        setReason("");
        onDone?.();
      },
      correcting ? "Declaration corrected" : "Cash tips declared",
    );

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        {shops.length > 1 && (
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Shop</span>
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)} disabled={!!correcting} aria-label="Shop">
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Day</span>
          <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} disabled={!!correcting} aria-label="Day" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Cash tips</span>
          <Input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" aria-label="Cash tips" />
        </label>
        {(manager || correcting) && (
          <label className="block min-w-48 flex-1">
            <span className="mb-1 block text-xs text-zinc-500">{correcting ? "Why it's being corrected" : "Why you're entering it"}</span>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          </label>
        )}
      </div>
      {!manager && (
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5" />
          <span>{attestation}</span>
        </label>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      <Button size="sm" disabled={pending || !ready} onClick={submit}>
        {correcting ? "Save correction" : "Declare"}
      </Button>
    </div>
  );
}

/** Their declarations with a Correct button on the ones still open. */
export function DeclarationList({
  rows,
  shops,
  today,
  attestation,
  staffId,
}: {
  rows: (DeclarationRow & { shop: string; current: boolean; closesOn: string; source: string; reason: string | null })[];
  shops: { id: string; name: string }[];
  today: string;
  attestation: string;
  staffId?: string;
}) {
  const [fixing, setFixing] = useState<string | null>(null);
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  return (
    <ul className="divide-y divide-zinc-100 text-sm">
      {rows.map((r) => (
        <li key={r.id} className={r.current ? "px-4 py-2" : "px-4 py-2 text-zinc-400 line-through"}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28">{r.businessDate}</span>
            <span className="flex-1">{r.shop}</span>
            <span className="tabular-nums">{money(r.amountCents)}</span>
            <span className="w-24 text-xs text-zinc-500">{r.source.replace("_", " ")}</span>
            {r.current && (staffId || r.closesOn >= today) && (
              <button type="button" className="text-xs text-brand-700 underline" onClick={() => setFixing(fixing === r.id ? null : r.id)}>
                Correct
              </button>
            )}
          </div>
          {r.reason && <div className="text-xs text-zinc-500 no-underline">{r.reason}</div>}
          {fixing === r.id && (
            <div className="mt-2">
              <DeclareCashTips shops={shops} today={today} attestation={attestation} staffId={staffId} correcting={r} onDone={() => setFixing(null)} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
