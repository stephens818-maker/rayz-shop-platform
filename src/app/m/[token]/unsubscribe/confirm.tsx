"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { unsubscribeAction } from "./actions";

export function Confirm({ token, channelLabel }: { token: string; channelLabel: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done)
    return (
      <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="unsubscribed">
        You&apos;re unsubscribed. You won&apos;t get offers by {channelLabel} any more. Appointment confirmations and reminders still come.
      </p>
    );
  return (
    <>
      <Button
        className="mt-4"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await unsubscribeAction(token);
            if (r.ok) setDone(true);
            else setError(r.error);
          })
        }
        data-testid="unsubscribe"
      >
        {pending ? "Unsubscribing…" : "Unsubscribe"}
      </Button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </>
  );
}
