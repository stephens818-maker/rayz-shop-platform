"use client";

import { useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { EmailStepUp, type SignedIn, type SignInStep, SignInHelpForm, isSignedIn } from "@/components/sign-in-recovery";
import { api } from "@/lib/api-client";
import { AGE_TEXT, EMAIL_CONSENT_TEXT, SMS_CONSENT_TEXT, initialBookingForm } from "@/domain/booking-consent";

type Form = ReturnType<typeof initialBookingForm>;
export type { SignedIn };

/**
 * The guest's phone, confirmed with a texted code before anything about the account shows: who's
 * on the phone and their kids only appear once the code checks out, so typing someone else's
 * number shows nothing. A phone with no single profile on it asks for a name (and the consents):
 * it finds theirs among the people on that phone, or makes one, without ever listing them. A number
 * idle for 18 months is confirmed by email, or handed to the shop.
 */
export function VerifyPhone({ form, setForm, onSignedIn, onSkip }: { form: Form; setForm: (f: Form) => void; onSignedIn: (t: SignedIn) => Promise<void>; onSkip: () => void }) {
  const [stage, setStage] = useState<"phone" | "code" | "profile" | "stepUp" | "help">("phone");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    token: string;
    emailHint?: string;
  } | null>(null);
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
      const r = await api<{ devCode?: string }>("/auth/otp/start", {
        method: "POST",
        auth: false,
        body: JSON.stringify({ phone: form.phone }),
      });
      setDevCode(r.devCode ?? null);
      setCode("");
      setStage("code");
    });
  const verify = () =>
    step(async () => {
      await next(
        await api<SignInStep>("/auth/otp/verify", {
          method: "POST",
          auth: false,
          body: JSON.stringify({
            phone: form.phone,
            code,
            deviceName: "web booking",
          }),
        }),
      );
    });
  const next = async (r: SignInStep) => {
    if (isSignedIn(r)) return onSignedIn(r);
    setSelection({
      token: r.selectionToken,
      emailHint: "emailHint" in r ? r.emailHint : undefined,
    });
    setStage("stepUp" in r ? "stepUp" : "cantSignIn" in r ? "help" : "profile");
  };
  const complete = (pick: { firstName: string; lastName: string | null }) =>
    step(async () => {
      await next(
        await api<SignInStep>("/auth/otp/complete", {
          method: "POST",
          auth: false,
          body: JSON.stringify({
            selectionToken: selection!.token,
            deviceName: "web booking",
            ageConfirmed: form.over13,
            ...pick,
          }),
        }),
      );
    });

  return (
    <div className="space-y-3" data-testid="verify-phone">
      <p className="text-sm text-zinc-600">We&apos;ll text you a code to confirm your number. Then you can book for yourself, your kids, or both.</p>
      <Field label="Mobile phone">
        <Input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          disabled={stage !== "phone"}
          placeholder="(319) 555-0123"
        />
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
            <label className="flex items-start gap-2 text-sm text-zinc-600 sm:col-span-2">
              <input type="checkbox" className="mt-1" checked={form.over13} onChange={(e) => setForm({ ...form, over13: e.target.checked })} />
              <span>{AGE_TEXT}</span>
            </label>
            <Button
              className="sm:col-span-2 sm:w-auto sm:justify-self-start"
              disabled={busy || !form.firstName.trim() || !form.over13}
              onClick={() =>
                complete({
                  firstName: form.firstName.trim(),
                  lastName: form.lastName.trim() || null,
                })
              }
            >
              Continue
            </Button>
          </div>
        </div>
      )}
      {stage === "stepUp" && selection?.emailHint && (
        <EmailStepUp selectionToken={selection.token} emailHint={selection.emailHint} deviceName="web booking" onSignedIn={async (t) => next(t)} onHelp={() => setStage("help")} />
      )}
      {stage === "help" && (
        <SignInHelpForm
          selectionToken={selection?.token}
          phone={form.phone}
          intro="This number hasn't been used here in a long time, so the shop needs to confirm it's you. You can still book just for yourself below."
        />
      )}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="button" className="block text-xs text-zinc-500 underline" onClick={onSkip}>
        Can&apos;t get a text? Book just for yourself without a code
      </button>
    </div>
  );
}
