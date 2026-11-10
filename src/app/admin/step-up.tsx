"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { STEP_UP_LABEL, STEP_UP_MINUTES, type StepUpAction } from "@/domain/staff-auth";
import { stepUpAction } from "./my-security/actions";

const EVENT = "rayz-step-up";
type Ask = { action: StepUpAction; done: (ok: boolean) => void };

/** Asks them to confirm it's them (password or authenticator code); true once they have. */
export function confirmIdentity(action: StepUpAction): Promise<boolean> {
  return new Promise((done) => window.dispatchEvent(new CustomEvent<Ask>(EVENT, { detail: { action, done } })));
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string; stepUp?: StepUpAction };

/** Runs a server action; when it needs a fresh sign-in (reveal, export, refund), asks for one and runs it once more. */
export async function withStepUp<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  const r = await fn();
  if (r.ok || !r.stepUp) return r;
  return (await confirmIdentity(r.stepUp)) ? fn() : r;
}

/** The "Confirm it's you" dialog, mounted once in the admin layout. */
export function StepUpHost({ factor }: { factor: "code" | "password" }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setAsk((e as CustomEvent<Ask>).detail);
      setValue("");
      setError(null);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (ask) input.current?.focus();
  }, [ask]);
  if (!ask) return null;
  const close = (ok: boolean) => {
    ask.done(ok);
    setAsk(null);
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !pending && close(false)}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
        data-testid="step-up-dialog"
        className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-zinc-900/10"
        onKeyDown={(e) => e.key === "Escape" && !pending && close(false)}
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await stepUpAction(factor === "code" ? { code: value } : { password: value });
          setPending(false);
          if (r.ok) close(true);
          else setError(r.error);
        }}
      >
        <h2 id="step-up-title" className="text-lg font-semibold tracking-tight">
          Confirm it&apos;s you
        </h2>
        <p className="text-sm text-zinc-600">
          To {STEP_UP_LABEL[ask.action]}, {factor === "code" ? "enter the code from your authenticator app" : "enter your password"}. It counts for {STEP_UP_MINUTES} minutes on this browser.
        </p>
        <Input
          ref={input}
          type={factor === "code" ? "text" : "password"}
          inputMode={factor === "code" ? "numeric" : undefined}
          autoComplete={factor === "code" ? "one-time-code" : "current-password"}
          aria-label={factor === "code" ? "Authenticator code" : "Password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button disabled={pending || !value.trim()}>Confirm</Button>
        </div>
      </form>
    </div>
  );
}
