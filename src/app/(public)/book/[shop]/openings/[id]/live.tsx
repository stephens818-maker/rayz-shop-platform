"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, Field, Input, Notice, Select, cx } from "@/components/ui";
import { fmtTime } from "@/lib/api-client";
import type { LiveOpenings } from "@/server/marketing/openings";
import { joinOpeningsWaitlistAction, liveOpeningsAction } from "./actions";

const POLL_MS = 15_000;

/** The barber's open times, refreshed while the page is open so taken times drop off. */
export function LiveOpeningsView({ initial }: { initial: LiveOpenings }) {
  const [live, setLive] = useState(initial);
  const [gone, setGone] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  const before = useRef(new Set(initial.days.flatMap((d) => d.slots)));

  useEffect(() => {
    if (live.state === "over") return;
    let stopped = false;
    async function refresh() {
      if (document.hidden) return;
      const r = await liveOpeningsAction(initial.id).catch(() => null);
      if (stopped || !r?.ok || !r.data) return;
      const now = new Set(r.data.days.flatMap((d) => d.slots));
      const taken = [...before.current].filter((s) => !now.has(s));
      before.current = now;
      if (taken.length) setGone((g) => [...g, ...taken]);
      setLive(r.data);
    }
    const t = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initial.id, live.state]);

  const book = (start?: string) => {
    const q = new URLSearchParams({ service: live.service.slug });
    if (live.barber.slug) q.set("barber", live.barber.slug);
    if (start && live.barber.slug) q.set("start", start);
    return `/book/${live.shop.slug}?${q}`;
  };
  const left = live.days.reduce((n, d) => n + d.slots.length, 0);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {live.barber.firstName} has openings at {live.shop.name}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {live.state === "open" ? `First come, first served. ${left} ${left === 1 ? "time" : "times"} left for a ${live.service.name.toLowerCase()}. Times disappear as they're booked.` : null}
        </p>
      </div>

      {live.state === "open" && (
        <>
          {gone.length > 0 && <Notice tone="blue">{gone.length === 1 ? "A time was just booked." : `${gone.length} times were just booked.`} What&apos;s left is below.</Notice>}
          {live.days.map((d) => (
            <section key={d.date} className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
              <h2 className="font-semibold">{d.label}</h2>
              {d.slots.length ? (
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid={`openings-${d.date}`}>
                  {d.slots.map((s) => (
                    <Link key={s} href={book(s)} className="rounded-lg bg-brand-50 px-2 py-2.5 text-center text-sm font-semibold text-brand-700 ring-1 ring-brand-200 transition hover:bg-brand-100">
                      {fmtTime(s)}
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">All booked.</p>
              )}
            </section>
          ))}
          {joining ? (
            <Waitlist live={live} onDone={() => setJoining(false)} />
          ) : (
            <p className="text-center text-sm text-zinc-500">
              None of these work?{" "}
              <button type="button" className="font-medium text-brand-600 underline" onClick={() => setJoining(true)}>
                Join the waitlist
              </button>
            </p>
          )}
        </>
      )}

      {live.state === "all_booked" && (
        <section className="rounded-xl bg-white p-5 ring-1 ring-zinc-200">
          <h2 className="text-lg font-semibold">All booked, join the waitlist</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Every opening with {live.barber.firstName} was taken. Leave your first name and mobile number and {live.shop.name} will text you if a time opens up.
          </p>
          <Waitlist live={live} />
        </section>
      )}

      {live.state === "over" && (
        <section className="rounded-xl bg-white p-5 text-center ring-1 ring-zinc-200">
          <h2 className="text-lg font-semibold">These openings have passed</h2>
          <p className="mt-1 text-sm text-zinc-600">You can still book {live.barber.firstName} on another day.</p>
          <Link href={book()} className="mt-3 inline-block font-medium text-brand-600 underline">
            See {live.barber.firstName}&apos;s times
          </Link>
        </section>
      )}

      {live.state !== "over" && (
        <p className="text-center text-xs text-zinc-400">
          Want a different day?{" "}
          <Link href={book()} className="underline">
            See all of {live.barber.firstName}&apos;s times
          </Link>
        </p>
      )}
    </div>
  );
}

function Waitlist({ live, onDone }: { live: LiveOpenings; onDone?: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (done) return <Notice tone="green">{done}</Notice>;
  return (
    <form
      className={cx("mt-4 grid gap-3", live.days.length > 1 && "sm:grid-cols-2")}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await joinOpeningsWaitlistAction(live.id, { firstName, phone, date: date || null });
        setBusy(false);
        if (!r.ok) return setError(r.error);
        setDone(`You're on the list, ${firstName.trim()}. ${r.data.shop} will text you if a time with ${r.data.barber} opens up.`);
      }}
    >
      <Field label="First name">
        <Input autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required maxLength={40} />
      </Field>
      <Field label="Mobile number">
        <Input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="(319) 555-0123" />
      </Field>
      {live.days.length > 1 && (
        <Field label="Day (optional)" className="sm:col-span-2">
          <Select value={date} onChange={(e) => setDate(e.target.value)}>
            <option value="">Any of these days</option>
            {live.days.map((d) => (
              <option key={d.date} value={d.date}>
                {d.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="text-xs text-zinc-500 sm:col-span-2">We&apos;ll only text you about an opening with {live.barber.firstName}. Msg &amp; data rates may apply.</p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy || !firstName.trim() || phone.replace(/\D/g, "").length < 10}>
          {busy ? "Joining…" : "Join the waitlist"}
        </Button>
        {onDone && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
