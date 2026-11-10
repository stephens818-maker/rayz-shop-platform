"use client";

import { useState } from "react";
import { useAction } from "@/components/use-action";
import { Button, Input } from "@/components/ui";
import { voidAction } from "../../sales/actions";

/** An open ticket with no payment. Paid tickets use Void on the sale page. */
export function VoidOpenTicket({ saleId }: { saleId: string }) {
  const { pending, error, run } = useAction();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Void ticket
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why void this open ticket?" aria-label="Void reason" className="w-56" />
      <Button size="sm" variant="danger" disabled={pending || !reason.trim()} onClick={() => run(() => voidAction(saleId, reason.trim()), undefined, "Ticket voided")}>
        Void ticket
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
