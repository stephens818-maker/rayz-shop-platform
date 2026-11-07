"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";

/** Where receipts go after paying at the counter. The website offers email; the app also offers itself. */
export function ReceiptChoiceCard({ current, verifiedEmail, onChanged }: { current: "email" | "app" | null; verifiedEmail: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (receiptDelivery: "email" | null) => {
    setBusy(true);
    setError(null);
    try {
      await api("/me", { method: "PATCH", body: JSON.stringify({ receiptDelivery }) });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="receipt-choice">
      <div className="text-sm font-semibold">Receipts</div>
      {current === "app" ? (
        <p className="text-sm text-zinc-600">Your receipts go to the Ray&apos;z app.</p>
      ) : (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={current === "email"} disabled={busy || (!verifiedEmail && current !== "email")} onChange={(e) => save(e.target.checked ? "email" : null)} />
          <span>
            Email my receipt every time I pay, without being asked at the counter.
            {!verifiedEmail && current !== "email" && <span className="block text-xs text-amber-700">Confirm your email above first.</span>}
          </span>
        </label>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
