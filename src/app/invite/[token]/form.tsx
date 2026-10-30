"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input, LinkButton, Notice } from "@/components/ui";
import { acceptInviteAction } from "./actions";

export function SignUpForm({ token, email, minLength, enroll }: { token: string; email: string; minLength: number; enroll: { sealed: string; qr: string; secret: string } | null }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [v, setV] = useState({ password: "", confirm: "", code: "" });
  if (done)
    return (
      <div className="mt-5 space-y-4">
        <Notice tone="green">You&apos;re all set. Sign in with {email} and your new password.</Notice>
        <LinkButton href="/login" className="w-full">
          Go to sign in
        </LinkButton>
      </div>
    );
  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await acceptInviteAction({ token, ...v, sealed: enroll?.sealed ?? null, code: enroll ? v.code : null });
          if (!r.ok) return setError(r.error);
          setDone(true);
        });
      }}
    >
      <Field label="Email">
        <Input value={email} readOnly autoComplete="username" />
      </Field>
      <Field label="Password" hint={`At least ${minLength} characters.`}>
        <Input type="password" autoComplete="new-password" minLength={minLength} required value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />
      </Field>
      <Field label="Password again">
        <Input type="password" autoComplete="new-password" required value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} />
      </Field>
      {enroll && (
        <div className="space-y-3 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700 ring-1 ring-zinc-200">
          <p className="font-medium text-zinc-900">Set up two-step sign-in</p>
          <p>Your account needs a code from an authenticator app each time you sign in. Scan this with the app, then enter the 6-digit code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not a static asset */}
          <img src={enroll.qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded-lg bg-white ring-1 ring-zinc-200" />
          <p className="text-xs text-zinc-500">
            Can&apos;t scan it? Enter this key instead: <code className="select-all rounded bg-white px-1 py-0.5 font-mono">{enroll.secret}</code>
          </p>
          <Field label="Code from the app">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />
          </Field>
        </div>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Setting up…" : "Create my sign-in"}
      </Button>
    </form>
  );
}
