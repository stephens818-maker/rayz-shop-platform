"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Field, Input, StatusBadge } from "@/components/ui";
import { api, dollars, fmtDay, fmtTime, getTokens, setTokens } from "@/lib/api-client";

interface Me {
  firstName: string;
  phone: string | null;
  email: string | null;
}
interface Loyalty {
  enabled: boolean;
  thresholdCents: number;
  rewardCents: number;
  progressCents: number;
  remainingCents: number;
  availableCents: number;
  rewards: { id: string; amountCents: number; expiresAt: string | null }[];
  rules: { earn: string; redeem: string; expiry: string };
}
interface Appt {
  code: string;
  status: string;
  startsAt: string;
  shop: { name: string };
  barber: { displayName: string };
  items: { name: string }[];
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [appts, setAppts] = useState<{ upcoming: Appt[]; past: Appt[] } | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [stage, setStage] = useState<"phone" | "code" | "profile">("phone");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadMe() {
    try {
      const [m, l, a] = await Promise.all([api<Me>("/me"), api<Loyalty>("/me/loyalty"), api<{ upcoming: Appt[]; past: Appt[] }>("/me/appointments")]);
      setMe(m);
      setLoyalty(l);
      setAppts(a);
    } catch {
      setTokens(null);
      setMe(null);
    }
  }
  useEffect(() => {
    if (getTokens()) loadMe();
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ devCode?: string }>("/auth/otp/start", { method: "POST", auth: false, body: JSON.stringify({ phone }) });
      setDevCode(r.devCode ?? null);
      setStage("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ needsProfile: boolean; accessToken: string; refreshToken: string; expiresIn: number }>("/auth/otp/verify", {
        method: "POST",
        auth: false,
        body: JSON.stringify({ phone, code, firstName: stage === "profile" ? firstName : undefined, deviceName: "web" }),
      });
      if (r.needsProfile) {
        // Code is consumed; request a fresh one together with the name.
        const s = await api<{ devCode?: string }>("/auth/otp/start", { method: "POST", auth: false, body: JSON.stringify({ phone }) });
        setDevCode(s.devCode ?? null);
        setCode("");
        setStage("profile");
        return;
      }
      setTokens(r);
      await loadMe();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    const t = getTokens();
    if (t) await api("/auth/logout", { method: "POST", auth: false, body: JSON.stringify({ refreshToken: t.refreshToken }) }).catch(() => {});
    setTokens(null);
    setMe(null);
    setStage("phone");
  }

  if (!me) {
    return (
      <div className="mx-auto max-w-sm rounded-xl bg-white p-6 ring-1 ring-zinc-200">
        <h1 className="text-xl font-bold">My visits & rewards</h1>
        <p className="mt-1 text-sm text-zinc-500">Sign in with a one-time code — no password.</p>
        <div className="mt-4 space-y-3">
          <Field label="Mobile phone">
            <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={stage !== "phone"} placeholder="(319) 555-0100" />
          </Field>
          {stage === "profile" && (
            <Field label="First name" hint="New here? Tell us what to call you.">
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
          )}
          {stage !== "phone" && (
            <Field label="6-digit code" hint={devCode ? `Dev mode: your code is ${devCode}` : "Check your texts."}>
              <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {stage === "phone" ? (
            <Button className="w-full" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={start}>
              Text me a code
            </Button>
          ) : (
            <Button className="w-full" disabled={busy || code.length < 6 || (stage === "profile" && !firstName.trim())} onClick={verify}>
              Sign in
            </Button>
          )}
        </div>
      </div>
    );
  }

  const pct = loyalty ? Math.min(100, Math.round((loyalty.progressCents / loyalty.thresholdCents) * 100)) : 0;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Hi, {me.firstName}</h1>
        <Button variant="ghost" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
      {loyalty?.enabled && (
        <div className="rounded-xl bg-ink-900 p-5 text-white">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Ray&apos;z Rewards</div>
            {loyalty.availableCents > 0 && <div className="rounded-full bg-emerald-500 px-3 py-1 text-sm font-semibold">{dollars(loyalty.availableCents)} ready to use</div>}
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 text-sm text-zinc-300">
            {dollars(loyalty.progressCents)} of {dollars(loyalty.thresholdCents)} · {dollars(loyalty.remainingCents)} to your next {dollars(loyalty.rewardCents)} reward
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            {loyalty.rules.earn} {loyalty.rules.expiry}
          </p>
        </div>
      )}
      <List title="Upcoming" list={appts?.upcoming ?? []} empty={<Link href="/" className="text-brand-600 underline">Book a cut</Link>} />
      <List title="Past visits" list={appts?.past ?? []} />
    </div>
  );
}

function List({ title, list, empty }: { title: string; list: Appt[]; empty?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white ring-1 ring-zinc-200">
      <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">{title}</div>
      {list.length === 0 && <div className="px-4 py-6 text-sm text-zinc-500">Nothing here yet. {empty}</div>}
      {list.map((a) => (
        <Link key={a.code} href={`/a/${a.code}`} className="flex items-center justify-between border-b border-zinc-50 px-4 py-3 last:border-0 hover:bg-zinc-50">
          <div>
            <div className="text-sm font-medium">
              {fmtDay(a.startsAt)} · {fmtTime(a.startsAt)}
            </div>
            <div className="text-xs text-zinc-500">
              {a.items.map((i) => i.name).join(" + ")} with {a.barber.displayName} · {a.shop.name}
            </div>
          </div>
          <StatusBadge status={a.status} />
        </Link>
      ))}
    </div>
  );
}
