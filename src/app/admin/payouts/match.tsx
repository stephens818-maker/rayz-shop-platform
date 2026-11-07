"use client";

import { useState } from "react";
import { Badge, Button, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { markReconciledAction, unmarkReconciledAction } from "./actions";

export interface MatchState {
  bankReference: string | null;
  note: string | null;
  by: string | null;
  at: string;
}

/** The bank column of one deposit: who matched it to the statement, or a way to match it. */
export function BankMatch({ payoutId, matched, canEdit, reconcilable }: { payoutId: string; matched: MatchState | null; canEdit: boolean; reconcilable: boolean }) {
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState(matched?.bankReference ?? "");
  const [note, setNote] = useState(matched?.note ?? "");
  const { pending, error, run } = useAction();

  if (open)
    return (
      <div className="w-64 space-y-1.5 text-left">
        <Input className="py-1" placeholder="Bank reference (optional)" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Bank reference" />
        <Input className="py-1" placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <div className="flex gap-1.5">
          <Button size="sm" disabled={pending} onClick={() => run(() => markReconciledAction({ payoutId, bankReference: ref, note }), () => setOpen(false))}>
            Matched
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    );

  if (matched)
    return (
      <div className="text-xs text-zinc-500">
        <Badge tone="green">Matched</Badge>
        <div className="mt-1">
          {matched.by ?? "Someone"}, {matched.at}
        </div>
        {matched.bankReference && <div>Ref {matched.bankReference}</div>}
        {matched.note && <div className="max-w-48 whitespace-normal">{matched.note}</div>}
        {canEdit && (
          <div className="mt-1 flex gap-2">
            <button type="button" className="underline" onClick={() => setOpen(true)}>
              Edit
            </button>
            <button type="button" className="underline" disabled={pending} onClick={() => run(() => unmarkReconciledAction(payoutId))}>
              Unmatch
            </button>
          </div>
        )}
        {error && <div className="text-red-600">{error}</div>}
      </div>
    );

  if (!reconcilable) return <span className="text-xs text-zinc-400">—</span>;
  return canEdit ? (
    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
      Mark matched
    </Button>
  ) : (
    <Badge tone="amber">Not matched</Badge>
  );
}
