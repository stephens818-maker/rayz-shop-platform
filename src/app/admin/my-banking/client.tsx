"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Notice, Select } from "@/components/ui";
import { METHOD_LABEL, TipMethod } from "@/domain/tips";
import { setMyPayoutMethodAction, startStripeSetupAction, stripeDashboardAction } from "./actions";

export function PayoutChoice(p: { methods: TipMethod[]; method: TipMethod | null; instant: boolean; instantAllowed: boolean; instantEligible: boolean; feeText: string }) {
  const router = useRouter();
  const [method, setMethod] = useState<TipMethod | "">(p.method ?? "");
  const [instant, setInstant] = useState(p.instant);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () =>
    start(async () => {
      const r = await setMyPayoutMethodAction({ method: method || null, instant: method === "stripe" && instant });
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
              {p.instantEligible ? `Stripe's instant fee comes out of each payout: ${p.feeText}. Without it, payouts reach your bank in 1 to 2 business days at no fee.` : "Your Stripe account needs an eligible debit card for instant payouts."}
            </span>
          </span>
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

export function StripeSetup({ state, simulator }: { state: "none" | "onboarding" | "restricted" | "ready"; simulator: boolean }) {
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
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {state !== "ready" && (
          <Button size="sm" disabled={pending} onClick={() => go(startStripeSetupAction)}>
            {state === "none" ? "Set up Stripe payouts" : "Finish setup on Stripe"}
          </Button>
        )}
        {state === "ready" && !simulator && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => go(stripeDashboardAction)}>
            Change my card or bank
          </Button>
        )}
      </div>
      {simulator && <p className="text-xs text-zinc-500">Simulator: setup finishes at once with a test debit card. With Stripe keys this opens Stripe&rsquo;s own page.</p>}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
