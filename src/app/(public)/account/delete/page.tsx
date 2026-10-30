"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PhoneSignIn } from "@/components/sign-in-recovery";
import { Button, Field, Input } from "@/components/ui";
import { api, getTokens, setTokens } from "@/lib/api-client";

interface Preview {
  profile: { id: string; firstName: string };
  dependents: { id: string; firstName: string }[];
  canDelete: boolean;
  blockers: string[];
  kept: { explanation: string };
  timing: string;
  consequences: string[];
}

/**
 * Delete an account on the web, so it works after the app is uninstalled (the App Store and Google
 * Play data-deletion link). Sign in with a code, read what happens, then confirm with a second code.
 */
export default function DeleteAccountPage() {
  const [signedIn, setSignedIn] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(id: string | null) {
    setError(null);
    try {
      setPreview(await api<Preview>(`/me/delete${id ? `?profileId=${id}` : ""}`));
      setSignedIn(true);
    } catch {
      setTokens(null);
      setSignedIn(false);
    }
  }
  useEffect(() => {
    if (getTokens()) load(null);
  }, []);

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

  if (done) {
    return (
      <div className="mx-auto max-w-md rounded-xl bg-white p-6 ring-1 ring-zinc-200" data-testid="account-deleted">
        <h1 className="text-xl font-bold">Deleted</h1>
        <p className="mt-2 text-sm text-zinc-600">
          {profileId ? "That profile has been deleted." : "Your account has been deleted and you've been signed out everywhere."} Thanks for coming to Ray&apos;z.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-brand-600 underline">
          Back to the home page
        </Link>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="space-y-4">
        <PhoneSignIn
          title="Delete your account"
          subtitle="Sign in with a code to the phone on your account. Next you'll see exactly what's deleted before anything happens."
          deviceName="web (delete account)"
          onSignedIn={async (t) => {
            setTokens(t);
            await load(null);
          }}
        />
        <p className="mx-auto max-w-sm text-center text-xs text-zinc-500">
          No longer have that number? Use &ldquo;I can&apos;t sign in&rdquo; and the shop will confirm it&apos;s you, or see <Link href="/support">support</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 rounded-xl bg-white p-6 ring-1 ring-zinc-200" data-testid="delete-preview">
      <h1 className="text-xl font-bold">Delete {profileId ? `${preview?.profile.firstName}'s profile` : "your account"}</h1>
      {preview && !profileId && preview.dependents.length > 0 && (
        <p className="text-sm text-zinc-600">
          Only want to remove a child&apos;s profile?{" "}
          {preview.dependents.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ", "}
              <button type="button" className="text-brand-600 underline" onClick={() => (setProfileId(d.id), setSent(false), load(d.id))}>
                {d.firstName}
              </button>
            </span>
          ))}
        </p>
      )}
      {profileId && (
        <button type="button" className="text-sm text-brand-600 underline" onClick={() => (setProfileId(null), setSent(false), load(null))}>
          Delete my whole account instead
        </button>
      )}
      {preview && (
        <>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {preview.consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="text-sm text-zinc-600">{preview.kept.explanation}</p>
          <p className="text-sm text-zinc-600">When: {preview.timing}</p>
          {preview.blockers.map((b) => (
            <p key={b} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {b}
            </p>
          ))}
          {preview.canDelete && !sent && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                step(async () => {
                  const r = await api<{ devCode?: string }>("/me/delete/start", { method: "POST" });
                  setDevCode(r.devCode ?? null);
                  setSent(true);
                })
              }
            >
              Send me a code to confirm
            </Button>
          )}
          {preview.canDelete && sent && (
            <div className="space-y-3">
              <Field label="Code" hint={devCode ? `Dev mode: your code is ${devCode}` : "We sent it to the phone (or confirmed email) on your account."}>
                <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
              </Field>
              <Button
                variant="danger"
                disabled={busy || code.length < 6}
                onClick={() =>
                  step(async () => {
                    await api("/me/delete", { method: "POST", body: JSON.stringify({ code, profileId: profileId ?? undefined }) });
                    if (!profileId) setTokens(null);
                    setDone(true);
                  })
                }
              >
                Delete permanently
              </Button>
            </div>
          )}
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Link href="/account" className="block text-sm text-zinc-500 underline">
        Keep my account
      </Link>
    </div>
  );
}
