"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Notice, Select } from "@/components/ui";
import type { BankingStatus } from "@/domain/banking";
import { METHOD_LABEL, TipMethod } from "@/domain/tips";
import { changeDestinationAction, refreshBankingAction, setMyPayoutMethodAction, startStripeSetupAction } from "./actions";

export function PayoutChoice(p: {
  methods: TipMethod[];
  method: TipMethod | null;
  instant: boolean;
  instantAllowed: boolean;
  instantEligible: boolean;
  feeText: string;
  feePassedOn: boolean;
  feeTerms: string;
  feeAckRequired: boolean;
  feeAccepted: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<TipMethod | "">(p.method ?? "");
  const [instant, setInstant] = useState(p.instant);
  const [accept, setAccept] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const wantsInstant = method === "stripe" && instant;
  const needsAck = wantsInstant && p.feeAckRequired && !p.feeAccepted;
  const save = () =>
    start(async () => {
      const r = await setMyPayoutMethodAction({ method: method || null, instant: wantsInstant, acceptInstantFee: needsAck && accept ? p.feeTerms : null });
      setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <div className="space-y-2 border-t border-zinc-100 pt-3">
      <Field label="My choice">
        <Select value={method} onChange={(e) => setMethod(e.target.value as TipMethod | "")}>
          <option value="">The shop&rsquo;s default</option>
          {p.methods.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </Select>
      </Field>
      {method === "stripe" && p.instantAllowed && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={instant} disabled={!p.instantEligible} onChange={(e) => setInstant(e.target.checked)} />
          <span>
            Instant payout to my debit card
            <span className="block text-xs text-zinc-500">
              {!p.instantEligible
                ? "Your Stripe account needs an eligible debit card for instant payouts."
                : p.feePassedOn
                  ? `Stripe's instant fee comes out of each payout: ${p.feeText}. Without it, payouts reach your bank in 1 to 2 business days at no fee.`
                  : `The shop pays Stripe's instant fee (${p.feeText}), so you get the whole payout in minutes.`}
            </span>
          </span>
        </label>
      )}
      {method === "stripe" && p.instantAllowed && p.instantEligible && !instant && <p className="text-xs text-zinc-500">Instant payouts are off unless you turn them on. Stripe&rsquo;s fee: {p.feeTerms}.</p>}
      {needsAck && (
        <label className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          <input type="checkbox" className="mt-0.5" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>I accept Stripe&rsquo;s instant payout fee: {p.feeTerms}.</span>
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending || (needsAck && !accept)} onClick={save}>
          Save
        </Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

export function StripeSetup({ status, simulator, hasDestination }: { status: BankingStatus; simulator: boolean; hasDestination: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (fn: () => Promise<{ ok: true; data: { url: string | null } } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else if (r.data.url) window.location.assign(r.data.url);
      else router.refresh();
    });
  const setupLabel = status === "not_set_up" ? "Set up Stripe payouts" : status === "action_needed" ? "Add what Stripe needs" : "Update my details on Stripe";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status !== "ready" && (
          <Button size="sm" disabled={pending} onClick={() => go(startStripeSetupAction)}>
            {setupLabel}
          </Button>
        )}
        {status !== "not_set_up" && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => go(changeDestinationAction)}>
            {hasDestination ? "Change my card or bank" : "Add a card or bank"}
          </Button>
        )}
        {status !== "not_set_up" && !simulator && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => go(refreshBankingAction)}>
            Check status with Stripe
          </Button>
        )}
      </div>
      {simulator && (
        <p className="text-xs text-zinc-500">
          Simulator: setup finishes at once with Stripe&rsquo;s test Visa debit card, and changing switches between it and a test bank account. With Stripe keys these open Stripe&rsquo;s own pages.
        </p>
      )}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
