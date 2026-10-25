"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api, fmtDay, getTokens } from "@/lib/api-client";

interface Status {
  on: boolean;
  createdAt: string | null;
  lastFetchedAt: string | null;
}
const BASE = { base: "/api" } as const;

/** Subscribe to upcoming appointments (yours and your kids') in Google, Apple or Outlook calendar, with a private link that can be turned off. */
export function MyCalendarFeed() {
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getTokens()) return;
    api<Status>("/account/calendar-feed", BASE)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  if (!status) return null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const create = () =>
    run(async () => {
      const r = await api<{ url: string }>("/account/calendar-feed", { ...BASE, method: "POST" });
      setUrl(r.url);
      setCopied(false);
      setStatus({ on: true, createdAt: new Date().toISOString(), lastFetchedAt: null });
    });
  const turnOff = () =>
    run(async () => {
      await api("/account/calendar-feed", { ...BASE, method: "DELETE" });
      setUrl(null);
      setStatus({ on: false, createdAt: null, lastFetchedAt: null });
    });
  const webcal = url?.replace(/^https?:/, "webcal:");

  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="calendar-feed">
      <div>
        <div className="text-sm font-semibold">Appointments in your calendar</div>
        <p className="text-sm text-zinc-600">A private link your calendar app checks for new, moved and cancelled appointments, yours and your kids&apos;. Anyone with the link can see them, so keep it to yourself.</p>
      </div>
      {url ? (
        <div className="space-y-2">
          <input readOnly value={url} className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Your calendar link" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
            {webcal && (
              <a className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-100" href={webcal}>
                Open in Apple Calendar
              </a>
            )}
            <a className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-100" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal ?? url)}`} target="_blank" rel="noopener noreferrer">
              Add to Google Calendar
            </a>
          </div>
          <p className="text-xs text-zinc-500">This link is shown once. If you lose it, make a new one; the old one stops working.</p>
        </div>
      ) : status.on ? (
        <p className="text-sm text-zinc-600">
          On since {fmtDay(status.createdAt!)}
          {status.lastFetchedAt ? `, last checked ${fmtDay(status.lastFetchedAt)}` : ", not checked by a calendar yet"}.
        </p>
      ) : null}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant={status.on ? "secondary" : "primary"} disabled={busy} onClick={create}>
          {status.on ? "Make a new link" : "Get my calendar link"}
        </Button>
        {status.on && (
          <Button variant="danger" disabled={busy} onClick={turnOff}>
            Turn off
          </Button>
        )}
      </div>
    </section>
  );
}
