"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MyBadges } from "@/components/my-badges";
import { MyCalendarFeed } from "@/components/my-calendar-feed";
import { MyFamily } from "@/components/my-family";
import { ConsentCard } from "@/components/consent-card";
import { ReceiptChoiceCard } from "@/components/receipt-choice-card";
import { EmailCard, IdentityCheckCard, PhoneSignIn } from "@/components/sign-in-recovery";
import { Button, StatusBadge } from "@/components/ui";
import { VISIT_STATUS_LABEL, cadenceByBarber, cadenceOf } from "@/domain/visit-cadence";
import { api, dollars, fmtDay, fmtTime, getTokens, setTokens } from "@/lib/api-client";
import { formatDate, todayLocal } from "@/lib/time";

interface Me {
  firstName: string;
  phone: string | null;
  email: string | null;
  emailVerified?: boolean;
  identityCheckRequired?: boolean;
  receiptDelivery?: "email" | "app" | null;
}
interface Loyalty {
  enabled: boolean;
  type?: "value" | "transaction";
  visitsGoal?: number;
  thresholdCents: number;
  rewardCents: number;
  progressCents: number;
  remainingCents: number;
  availableCents: number;
  rewards: { id: string; amountCents: number; expiresAt: string | null }[];
  rules: { earn: string; redeem: string; expiry: string };
  redemptionLocked?: boolean;
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

  async function signOut() {
    const t = getTokens();
    if (t)
      await api("/auth/logout", {
        method: "POST",
        auth: false,
        body: JSON.stringify({ refreshToken: t.refreshToken }),
      }).catch(() => {});
    setTokens(null);
    setMe(null);
  }

  if (!me) {
    return (
      <PhoneSignIn
        title="My visits & rewards"
        deviceName="web"
        onSignedIn={async (t) => {
          setTokens(t);
          await loadMe();
        }}
      />
    );
  }

  const visits = loyalty?.type === "transaction";
  const goal = loyalty ? (visits ? (loyalty.visitsGoal ?? 1) : loyalty.thresholdCents) : 1;
  const pct = loyalty ? Math.min(100, Math.round((loyalty.progressCents / Math.max(1, goal)) * 100)) : 0;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Hi, {me.firstName}</h1>
        <Button variant="ghost" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
      {me.identityCheckRequired && <IdentityCheckCard onVerified={loadMe} />}
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
            {visits
              ? `${loyalty.progressCents} of ${goal} visits · ${loyalty.remainingCents} more to your next ${dollars(loyalty.rewardCents)} reward`
              : `${dollars(loyalty.progressCents)} of ${dollars(loyalty.thresholdCents)} · ${dollars(loyalty.remainingCents)} to your next ${dollars(loyalty.rewardCents)} reward`}
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            {loyalty.rules.earn} {loyalty.rules.expiry}
          </p>
        </div>
      )}
      <EmailCard email={me.email} verified={!!me.emailVerified} onChanged={loadMe} />
      <ConsentCard key={`${me.email}:${me.emailVerified}`} />
      <ReceiptChoiceCard current={me.receiptDelivery ?? null} verifiedEmail={!!me.emailVerified} onChanged={loadMe} />
      <MyBadges />
      <MyFamily parentName={me.firstName} />
      <MyCalendarFeed />
      {appts && <Rhythm upcoming={appts.upcoming} past={appts.past} />}
      <List
        title="Upcoming"
        list={appts?.upcoming ?? []}
        empty={
          <Link href="/" className="text-brand-600 underline">
            Book a cut
          </Link>
        }
      />
      <List title="Past visits" list={appts?.past ?? []} />
      <p className="text-center text-xs text-zinc-500">
        <Link href="/account/delete" className="underline">
          Delete my account
        </Link>
      </p>
    </div>
  );
}

const STATUS_CLASS = {
  on_track: "bg-emerald-50 text-emerald-700",
  due: "bg-amber-50 text-amber-800",
  overdue: "bg-red-50 text-red-700",
} as const;

/** How often they come in, from the completed visits the visit list returns (the latest 20 past appointments). */
function Rhythm({ upcoming, past }: { upcoming: Appt[]; past: Appt[] }) {
  const done = past.filter((a) => a.status === "completed");
  const c = cadenceOf(
    done.map((a) => a.startsAt),
    todayLocal(),
    upcoming.length > 0,
  );
  if (!c.lastVisit) return null;
  const barbers = cadenceByBarber(
    done.map((a) => ({
      at: a.startsAt,
      staffId: a.barber.displayName,
      name: a.barber.displayName,
    })),
  );
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="visit-rhythm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Your cut rhythm</div>
          <div className="mt-0.5 text-lg font-bold">{c.label ?? "Shows after your second visit"}</div>
        </div>
        {c.status && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASS[c.status]}`}>{c.booked ? "Booked" : VISIT_STATUS_LABEL[c.status]}</span>}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-zinc-500">Last visit</dt>
          <dd className="font-medium">{formatDate(c.lastVisit, "MMM d")}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Days since</dt>
          <dd className="font-medium">{c.sinceDays}</dd>
        </div>
        {c.nextExpected && (
          <div>
            <dt className="text-xs text-zinc-500">Next cut due</dt>
            <dd className="font-medium">{formatDate(c.nextExpected, "MMM d")}</dd>
          </div>
        )}
      </dl>
      {barbers.some((b) => b.label) && (
        <ul className="mt-3 space-y-0.5 border-t border-zinc-100 pt-2 text-xs text-zinc-600">
          {barbers.map((b) => (
            <li key={b.staffId}>
              With {b.name}: {b.label?.toLowerCase() ?? `${b.visitDays} visit`}
            </li>
          ))}
        </ul>
      )}
      {c.status && c.status !== "on_track" && !c.booked && (
        <p className="mt-3 text-sm">
          {c.status === "due" ? `Your next cut is due around ${formatDate(c.nextExpected!, "MMM d")}. ` : "It's been a while. "}
          <Link href="/" className="font-medium text-brand-600 underline">
            Book a cut
          </Link>
        </p>
      )}
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
