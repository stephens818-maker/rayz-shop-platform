"use client";

import { useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import { EMAIL_CONSENT_TEXT, SMS_CONSENT_TEXT, initialBookingForm } from "@/domain/booking-consent";

type Form = ReturnType<typeof initialBookingForm>;
type Profile = { id: string; firstName: string; lastInitial: string | null };
export type SignedIn = { accessToken: string; refreshToken: string; expiresIn: number; isNew: boolean };
type Verified = SignedIn | { needsProfile: true; selectionToken: string } | { chooseProfile: true; selectionToken: string; profiles: Profile[] };

/**
 * The guest's phone, confirmed with a texted code before anything about the account shows: who's
 * on the phone and their kids only appear once the code checks out, so typing someone else's
 * number shows nothing. A phone shared by several people asks which one is booking; a new phone
 * asks for a name (and the consents) and makes the account.
 */
export function VerifyPhone({ form, setForm, onSignedIn, onSkip }: { form: Form; setForm: (f: Form) => void; onSignedIn: (t: SignedIn) => Promise<void>; onSkip: () => void }) {
  const [stage, setStage] = useState<"phone" | "code" | "profile">("phone");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ token: string; profiles: Profile[] } | null>(null);
  const [someoneElse, setSomeoneElse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = form.phone.replace(/\D/g, "");

  const step = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    step(async () => {
      const r = await api<{ devCode?: string }>("/auth/otp/start", { method: "POST", auth: false, body: JSON.stringify({ phone: form.phone }) });
      setDevCode(r.devCode ?? null);
      setCode("");
      setStage("code");
    });
  const verify = () =>
    step(async () => {
      const r = await api<Verified>("/auth/otp/verify", { method: "POST", auth: false, body: JSON.stringify({ phone: form.phone, code, deviceName: "web booking" }) });
      if ("selectionToken" in r) {
        setSelection({ token: r.selectionToken, profiles: "profiles" in r ? r.profiles : [] });
        setSomeoneElse(!("profiles" in r));
        setStage("profile");
        return;
      }
      await onSignedIn(r);
    });
  const complete = (pick: { customerId: string } | { firstName: string; lastName: string | null }) =>
    step(async () => {
      const r = await api<SignedIn>("/auth/otp/complete", { method: "POST", auth: false, body: JSON.stringify({ selectionToken: selection!.token, deviceName: "web booking", ...pick }) });
      await onSignedIn(r);
    });

  return (
    <div className="space-y-3" data-testid="verify-phone">
      <p className="text-sm text-zinc-600">We&apos;ll text you a code to confirm your number. Then you can book for yourself, your kids, or both.</p>
      <Field label="Mobile phone">
        <Input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={stage !== "phone"} placeholder="(319) 555-0123" />
      </Field>
      {stage === "phone" && (
        <Button disabled={busy || digits.length < 10} onClick={send}>
          {busy ? "Sending…" : "Text me a code"}
        </Button>
      )}
      {stage === "code" && (
        <>
          <Field label="6-digit code" hint={devCode ? `Dev mode: your code is ${devCode}` : "Check your texts."}>
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || code.length < 6} onClick={verify}>
              Confirm
            </Button>
            <button type="button" className="text-sm text-zinc-600 underline" disabled={busy} onClick={send}>
              Send a new code
            </button>
            <button type="button" className="text-sm text-zinc-600 underline" onClick={() => setStage("phone")}>
              Different number
            </button>
          </div>
        </>
      )}
      {stage === "profile" && selection && (
        <div className="space-y-3">
          {selection.profiles.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Who&apos;s booking?</div>
              {selection.profiles.map((p) => (
                <Button key={p.id} variant="secondary" className="w-full justify-start" disabled={busy} onClick={() => complete({ customerId: p.id })}>
                  {p.firstName} {p.lastInitial ? `${p.lastInitial}.` : ""}
                </Button>
              ))}
              {!someoneElse && (
                <button type="button" className="text-sm text-zinc-600 underline" onClick={() => setSomeoneElse(true)}>
                  Someone else on this phone
                </button>
              )}
            </div>
          )}
          {someoneElse && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name">
                <Input autoComplete="given-name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </Field>
              <Field label="Last name (optional)" hint="Kept private — never shown to others.">
                <Input autoComplete="family-name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </Field>
              <Field label="Email (optional)">
                <Input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <label className="flex items-start gap-2 text-sm text-zinc-600 sm:col-span-2">
                <input type="checkbox" className="mt-1" checked={form.smsOptIn} onChange={(e) => setForm({ ...form, smsOptIn: e.target.checked })} />
                <span>{SMS_CONSENT_TEXT}</span>
              </label>
              {form.email.trim() && (
                <label className="flex items-center gap-2 text-sm text-zinc-600 sm:col-span-2">
                  <input type="checkbox" checked={form.emailOptIn} onChange={(e) => setForm({ ...form, emailOptIn: e.target.checked })} />
                  {EMAIL_CONSENT_TEXT}
                </label>
              )}
              <Button className="sm:col-span-2 sm:w-auto sm:justify-self-start" disabled={busy || !form.firstName.trim()} onClick={() => complete({ firstName: form.firstName.trim(), lastName: form.lastName.trim() || null })}>
                Continue
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="button" className="block text-xs text-zinc-500 underline" onClick={onSkip}>
        Can&apos;t get a text? Book just for yourself without a code
      </button>
    </div>
  );
}
