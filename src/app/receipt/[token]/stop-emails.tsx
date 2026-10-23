"use client";

import { useState, useTransition } from "react";
import { stopEmailsAction } from "./actions";

export function StopEmails({ token, stopped }: { token: string; stopped: boolean }) {
  const [done, setDone] = useState(stopped);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done) return <p data-testid="emails-stopped">Receipt emails to this address are off. Ask the shop for a text receipt instead.</p>;
  return (
    <p>
      <button
        type="button"
        className="underline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await stopEmailsAction(token);
            if (r.ok) setDone(true);
            else setError(r.error);
          })
        }
        data-testid="stop-emails"
      >
        Stop receipt emails to this address
      </button>
      {error && <span className="block text-red-700">{error}</span>}
    </p>
  );
}
