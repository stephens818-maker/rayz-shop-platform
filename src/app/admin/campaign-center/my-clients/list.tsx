"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Button, Card, CardHeader, Notice, cx } from "@/components/ui";
import { LAPSED_BUCKETS } from "@/domain/marketing";
import { formatDate } from "@/lib/time";
import { sendToMyClientsAction } from "./actions";

interface Client {
  customerId: string;
  name: string;
  shopName: string;
  lastVisit: string;
  sinceDays: number;
  bucket: string;
  visits: number;
  /** "Text", "Email", "App push", or null. */
  channel: string | null;
  sentAt: string | null;
  blocked: string | null;
}

export function MyClientList({ clients, left, maxPerDay, minDays, sample, canSend }: { clients: Client[]; left: number; maxPerDay: number; minDays: number; sample: string; canSend: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [bucket, setBucket] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const counts = useMemo(() => new Map(LAPSED_BUCKETS.map((b) => [b.label, clients.filter((c) => c.bucket === b.label).length])), [clients]);
  const shown = clients.filter((c) => !bucket || c.bucket === bucket);
  const sendable = shown.filter((c) => !c.blocked);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const send = () =>
    start(async () => {
      setError(null);
      setDone(null);
      if (!confirm(`Send "From your barber" to ${picked.length} client${picked.length === 1 ? "" : "s"}?`)) return;
      const r = await sendToMyClientsAction(picked);
      if (!r.ok) return setError(r.error);
      setPicked([]);
      setDone(`${r.data.queued} sent${r.data.skipped.length ? `; ${r.data.skipped.map((x) => `${x.count} skipped (${x.reason.toLowerCase()})`).join(", ")}` : ""}. Messages due in quiet hours go out when they end.`);
      router.refresh();
    });
  const chip = (label: string | null, text: string) => (
    <button
      key={text}
      type="button"
      aria-pressed={bucket === label}
      onClick={() => (setBucket(label), setPicked([]))}
      className={cx("rounded-full px-2.5 py-1 text-xs ring-1", bucket === label ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-300 hover:ring-zinc-500")}
    >
      {text}
    </button>
  );
  return (
    <>
      <div className="flex flex-wrap gap-1.5" data-testid="buckets">
        {chip(null, `All · ${clients.length}`)}
        {LAPSED_BUCKETS.map((b) => chip(b.label, `${b.label} · ${counts.get(b.label) ?? 0}`))}
      </div>
      <Card>
        <CardHeader
          title={`${shown.length} lapsed client${shown.length === 1 ? "" : "s"}`}
          subtitle={`You can message up to ${maxPerDay} a day (${left} left today), each once per lapse, from ${minDays} days after their last visit.`}
          action={
            canSend &&
            sendable.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setPicked(picked.length === sendable.length ? [] : sendable.map((c) => c.customerId))}>
                {picked.length === sendable.length ? "Clear" : `Pick all ${sendable.length} I can send to`}
              </Button>
            )
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="my-clients">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
              <tr>
                <th className="w-8 px-4 py-2" />
                <th className="px-2 py-2">Client</th>
                <th className="px-2 py-2">Location</th>
                <th className="px-2 py-2">Last visit</th>
                <th className="px-2 py-2">Weeks since</th>
                <th className="px-2 py-2 text-right">Visits</th>
                <th className="px-2 py-2">Gets it by</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {shown.map((c) => (
                <tr key={c.customerId} className={cx(c.blocked && "text-zinc-500")}>
                  <td className="px-4 py-2">
                    <input type="checkbox" aria-label={`Pick ${c.name}`} disabled={!canSend || !!c.blocked} checked={picked.includes(c.customerId)} onChange={() => toggle(c.customerId)} />
                  </td>
                  <td className="px-2 py-2 font-medium text-zinc-900">{c.name}</td>
                  <td className="px-2 py-2">{c.shopName}</td>
                  <td className="px-2 py-2">{formatDate(c.lastVisit, "MMM d, yyyy")}</td>
                  <td className="px-2 py-2">
                    {Math.floor(c.sinceDays / 7)} <span className="text-xs text-zinc-400">({c.bucket})</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{c.visits}</td>
                  <td className="px-2 py-2">{c.channel ?? "—"}</td>
                  <td className="px-2 py-2 text-xs">{c.sentAt ? `Sent ${formatDate(c.sentAt, "MMM d")}` : (c.blocked ?? <span className="text-emerald-700">Ready</span>)}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-zinc-500">
                    Nobody here. Your clients are booked or were in recently.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {canSend && (
        <Card>
          <CardHeader title={`"From your barber"`} subtitle="The brand's wording, signed with your first name and a link to book with you. You can't change it here." />
          <div className="space-y-3 p-4">
            <div className="rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200" data-testid="outreach-sample">
              {sample}
            </div>
            {error && <Notice tone="red">{error}</Notice>}
            {done && <Notice tone="green">{done}</Notice>}
            <div className="flex justify-end">
              <Button disabled={pending || !picked.length || picked.length > left} onClick={send} data-testid="send-mine">
                {picked.length > left ? `Only ${left} more today` : `Send to ${picked.length || ""} client${picked.length === 1 ? "" : "s"}`.replace("  ", " ")}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
