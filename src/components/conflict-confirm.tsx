"use client";

import type { BookedConflict } from "@/server/staff-time";
import { Button } from "./ui";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Booked appointments inside time someone is about to block. Saving anyway keeps every one of them booked. */
export function ConflictConfirm({
  conflicts,
  onConfirm,
  onCancel,
  pending,
  confirmLabel = "Block anyway",
  note = "They stay booked. Move them on the calendar or ask a manager to, so no client is left without a barber.",
}: {
  conflicts: BookedConflict[];
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  confirmLabel?: string;
  note?: string;
}) {
  const n = conflicts.length;
  return (
    <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
      <div className="font-semibold">
        {n} booked appointment{n === 1 ? "" : "s"} in this time
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {conflicts.slice(0, 8).map((c) => (
          <li key={c.id} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{when(c.startsAt)}</span>
            <span>{c.customerName}</span>
            <span className="text-amber-700">
              {c.shopName} · {c.code}
            </span>
          </li>
        ))}
        {n > 8 && <li className="text-amber-700">and {n - 8} more</li>}
      </ul>
      <p className="mt-2 text-xs text-amber-800">{note}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="dark" disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onCancel}>
          Don&apos;t save
        </Button>
      </div>
    </div>
  );
}
