"use client";

import { useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { api } from "@/lib/api-client";

export type SignedIn = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  isNew: boolean;
  identityCheckRequired?: boolean;
};
/** What /auth/otp/verify, /auth/otp/complete and /auth/step-up/verify can answer. */
export type SignInStep =
  | SignedIn
  | { needsProfile: true; selectionToken: string }
  | {
      needsProfile: false;
      stepUp: "email";
      selectionToken: string;
      emailHint: string;
    }
  | {
      needsProfile: false;
      cantSignIn: true;
      selectionToken: string;
      reason: "idle_number";
    };

export const isSignedIn = (r: SignInStep): r is SignedIn => "accessToken" in r;

function useStep() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return { busy, error, step };
}

/** A number unused for 18 months: confirm with a code to the profile's verified email. */
export function EmailStepUp({
  selectionToken,
  emailHint,
  deviceName,
  onSignedIn,
  onHelp,
}: {
  selectionToken: string;
  emailHint: string;
  deviceName: string;
  onSignedIn: (t: SignedIn) => Promise<void>;
  onHelp: () => void;
}) {
  const { busy, error, step } = useStep();
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  return (
    <div className="space-y-3" data-testid="email-step-up">
      <p className="text-sm text-zinc-600">It&apos;s been a while since this number was used here, so we need to check it&apos;s still you. We&apos;ll email a code to {emailHint}.</p>
      {!sent ? (
        <Button
          disabled={busy}
          onClick={() =>
            step(async () => {
              const r = await api<{ devCode?: string }>("/auth/step-up/start", {
                method: "POST",
                auth: false,
                body: JSON.stringify({ selectionToken }),
              });
              setDevCode(r.devCode ?? null);
              setSent(true);
            })
          }
        >
          Email me a code
        </Button>
      ) : (
        <>
          <Field label="Code from the email" hint={devCode ? `Dev mode: your code is ${devCode}` : undefined}>
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus />
          </Field>
          <Button
            disabled={busy || code.length < 6}
            onClick={() =>
              step(async () => {
                const r = await api<SignedIn>("/auth/step-up/verify", {
                  method: "POST",
                  auth: false,
                  body: JSON.stringify({ selectionToken, code, deviceName }),
                });
                await onSignedIn(r);
              })
            }
          >
            Confirm
          </Button>
        </>
      )}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="button" className="block text-xs text-zinc-500 underline" onClick={onHelp}>
        I don&apos;t have that email any more
      </button>
    </div>
  );
}

/** "I can't sign in": sends the shop a request to confirm who they are and sort it out. */
export function SignInHelpForm({ selectionToken, phone, intro }: { selectionToken?: string | null; phone?: string; intro?: string }) {
  const { busy, error, step } = useStep();
  const [f, setF] = useState({
    firstName: "",
    lastName: "",
    phone: phone ?? "",
    email: "",
    message: "",
  });
  const [done, setDone] = useState(false);
  if (done) return <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Thanks. The shop will confirm it&apos;s you and get you signed in. We&apos;ll text or call you.</p>;
  return (
    <div className="space-y-3" data-testid="sign-in-help">
      <p className="text-sm text-zinc-600">{intro ?? "Tell us who you are and the shop will help you sign in."}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name">
          <Input autoComplete="given-name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input autoComplete="family-name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} />
        </Field>
        {!selectionToken && (
          <>
            <Field label="Phone you used at the shop">
              <Input type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </Field>
            <Field label="Or email">
              <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="Anything that helps (optional)" className="sm:col-span-2">
          <Input value={f.message} maxLength={500} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="e.g. I changed numbers last year" />
        </Field>
      </div>
      <Button
        disabled={busy || !f.firstName.trim() || (!selectionToken && !f.phone.trim() && !f.email.trim())}
        onClick={() =>
          step(async () => {
            await api("/auth/help", {
              method: "POST",
              auth: false,
              body: JSON.stringify({
                selectionToken: selectionToken ?? undefined,
                firstName: f.firstName.trim(),
                lastName: f.lastName.trim() || undefined,
                phone: f.phone.trim() || undefined,
                email: f.email.trim() || undefined,
                message: f.message.trim() || undefined,
              }),
            });
            setDone(true);
          })
        }
      >
        Ask the shop for help
      </Button>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

/** The one-time check on a profile carried over from the old booking system, before its rewards can be used. */
export function IdentityCheckCard({ onVerified }: { onVerified: () => void }) {
  const { busy, error, step } = useStep();
  const [lastName, setLastName] = useState("");
  const [lastShop, setLastShop] = useState("");
  return (
    <div className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200" data-testid="identity-check">
      <div className="text-sm font-semibold">Confirm it&apos;s you to use your rewards</div>
      <p className="mt-1 text-sm text-zinc-700">We brought your visits over from our old booking system. Tell us your last name, or the shop you last visited.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Last name">
          <Input autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label="Or your last shop">
          <Input value={lastShop} onChange={(e) => setLastShop(e.target.value)} placeholder="e.g. Coralville" />
        </Field>
      </div>
      <Button
        className="mt-3"
        disabled={busy || (!lastName.trim() && !lastShop.trim())}
        onClick={() =>
          step(async () => {
            await api("/me/identity-check", {
              method: "POST",
              body: JSON.stringify({
                lastName: lastName.trim() || undefined,
                lastShop: lastShop.trim() || undefined,
              }),
            });
            onVerified();
          })
        }
      >
        Confirm
      </Button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

/** C17: a new email is saved only after the code sent to it is entered. */
export function EmailCard({ email, verified, onChanged }: { email: string | null; verified: boolean; onChanged: () => void }) {
  const { busy, error, step } = useStep();
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState("");
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="email-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Email</div>
          <div className="text-sm text-zinc-600">
            {email ?? "None yet"} {email && <span className={verified ? "text-emerald-700" : "text-amber-700"}>· {verified ? "confirmed" : "not confirmed"}</span>}
          </div>
        </div>
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {email && !verified ? "Confirm" : email ? "Change" : "Add"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 space-y-3">
          <Field label="Email">
            <Input type="email" autoComplete="email" value={next} disabled={sent} onChange={(e) => setNext(e.target.value)} placeholder={email ?? "you@example.com"} />
          </Field>
          {sent && (
            <Field label="Code from the email" hint={devCode ? `Dev mode: your code is ${devCode}` : undefined}>
              <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            </Field>
          )}
          <Button
            disabled={busy || !next.includes("@") || (sent && code.length < 6)}
            onClick={() =>
              step(async () => {
                if (!sent) {
                  const r = await api<{ devCode?: string }>("/me/email/start", {
                    method: "POST",
                    body: JSON.stringify({ email: next.trim() }),
                  });
                  setDevCode(r.devCode ?? null);
                  setSent(true);
                  return;
                }
                await api("/me/email/verify", {
                  method: "POST",
                  body: JSON.stringify({ email: next.trim(), code }),
                });
                setEditing(false);
                setSent(false);
                setCode("");
                onChanged();
              })
            }
          >
            {sent ? "Confirm" : "Email me a code"}
          </Button>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
