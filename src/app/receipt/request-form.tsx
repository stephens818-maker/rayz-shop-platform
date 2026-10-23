"use client";

import { useState, useTransition } from "react";
import { requestReceiptAction } from "./actions";

export function RequestForm() {
  const [contact, setContact] = useState("");
  const [sent, setSent] = useState<{ channel: "sms" | "email"; masked: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (sent)
    return (
      <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900" role="status" data-testid="request-sent">
        If {sent.masked} is the {sent.channel === "sms" ? "number" : "email"} on file with the shop, your receipts are on the way. Nothing there in a few minutes? Ask the shop.
      </p>
    );
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await requestReceiptAction(contact);
          if (r.ok) setSent(r.data);
          else setError(r.error);
        });
      }}
    >
      <label className="block text-sm font-medium text-zinc-800">
        Mobile number or email
        <input
          className="mt-1 block h-12 w-full rounded-xl border border-zinc-300 px-3 text-base outline-none focus:border-zinc-900"
          autoComplete="email tel"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="(319) 555-0100 or name@example.com"
        />
      </label>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button className="h-12 w-full rounded-xl bg-zinc-900 text-base font-semibold text-white disabled:opacity-50" disabled={pending || !contact.trim()}>
        Send my receipts
      </button>
    </form>
  );
}
