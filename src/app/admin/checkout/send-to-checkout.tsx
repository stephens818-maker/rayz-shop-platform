"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendToCheckoutAction } from "../calendar/actions";

/** The barber's "Send to checkout" on a visit in the chair: it joins the checkout queue, on its group's ticket. */
export function SendToCheckoutButton({ appointmentId, readyAt }: { appointmentId: string; readyAt: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<{ ready: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (readyAt || done)
    return (
      <span className="text-xs font-medium text-emerald-700" data-testid="sent-to-checkout">
        Sent to checkout{done && done.total > 1 ? ` · ${done.ready}/${done.total} ready` : ""}
      </span>
    );
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        disabled={pending}
        data-testid="send-to-checkout"
        className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await sendToCheckoutAction(appointmentId);
            if (!r.ok) return setError(r.error);
            setDone(r.data);
            router.refresh();
          })
        }
      >
        Send to checkout
      </button>
      {error && <span className="text-[11px] text-red-700">{error}</span>}
    </span>
  );
}
