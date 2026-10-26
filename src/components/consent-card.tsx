"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

type Channel = {
  channel: string;
  label: string;
  marketing: boolean;
  granted: boolean;
  text: string;
  textVersion: string;
  blockedBy: "stop" | "no_phone" | "no_verified_email" | null;
};

const BLOCKED: Record<NonNullable<Channel["blockedBy"]>, string> = {
  stop: "Your number replied STOP, so texts are off until you text START to the shop.",
  no_phone: "Add a phone number first.",
  no_verified_email: "Confirm your email above first.",
};

/** The account page's message choices: each box starts as saved, shows the exact wording, and records it when ticked. */
export function ConsentCard() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ channels: Channel[] }>("/me/consent")
      .then((r) => setChannels(r.channels))
      .catch(() => setChannels(null));
  }, []);
  if (!channels) return null;
  const toggle = async (c: Channel, granted: boolean) => {
    setBusy(c.channel);
    setError(null);
    try {
      const r = await api<{ channels: Channel[] }>("/me/consent", { method: "PUT", body: JSON.stringify({ changes: [{ channel: c.channel, granted, textVersion: c.textVersion }] }) });
      setChannels(r.channels);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const shown = channels.filter((c) => !c.channel.startsWith("push"));
  const group = (marketing: boolean) =>
    shown
      .filter((c) => c.marketing === marketing)
      .map((c) => (
        <label key={c.channel} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={c.granted}
            disabled={busy === c.channel || (!c.granted && c.blockedBy !== null && c.blockedBy !== "stop")}
            onChange={(e) => toggle(c, e.target.checked)}
          />
          <span>
            <span className="font-medium">{c.label}.</span> <span className="text-zinc-600">{c.text}</span>
            {c.blockedBy && <span className="block text-xs text-amber-700">{BLOCKED[c.blockedBy]}</span>}
          </span>
        </label>
      ));
  return (
    <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="consent-card">
      <div className="text-sm font-semibold">Messages</div>
      <div className="space-y-2">{group(false)}</div>
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Offers (optional)</div>
      <div className="space-y-2">{group(true)}</div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
