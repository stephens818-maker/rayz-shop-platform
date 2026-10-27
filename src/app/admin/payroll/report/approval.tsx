"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { ApprovalStatus } from "@/server/payroll/run";
import { approvePayrollAction, lockPayrollAction, revokeApprovalAction } from "../actions";

/** Approve the figures after review, then lock: two steps, each recorded. A change after approval needs approving again before the lock. */
export function ApprovalControls({ start, end, label, status, blocked }: { start: string; end: string; label: string; status: ApprovalStatus; blocked: string | null }) {
  const { pending, error, run } = useAction();
  const [step, setStep] = useState<"approve" | "lock" | "revoke" | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  if (status === "locked") return null;
  const close = () => {
    setStep(null);
    setNote("");
    setReason("");
  };
  return (
    <div className="flex flex-col items-end gap-1" data-testid="payroll-approval">
      {step === "approve" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-sm text-zinc-600">Approve the figures for {label}?</span>
          <Input aria-label="Approval note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 w-56 text-xs" />
          <Button size="sm" disabled={pending} onClick={() => run(() => approvePayrollAction(start, end, note), close)}>
            {pending ? "Approving…" : "Yes, approve"}
          </Button>
          <Button size="sm" variant="secondary" onClick={close}>
            Cancel
          </Button>
        </div>
      ) : step === "lock" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-sm text-zinc-600">Lock {label}? Hours, sales and adjustments in it can&apos;t change afterwards.</span>
          <Button size="sm" disabled={pending} onClick={() => run(() => lockPayrollAction(start, end), close)}>
            {pending ? "Locking…" : "Yes, lock"}
          </Button>
          <Button size="sm" variant="secondary" onClick={close}>
            Cancel
          </Button>
        </div>
      ) : step === "revoke" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Input aria-label="Why the approval is taken back" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 w-64 text-xs" />
          <Button size="sm" variant="secondary" disabled={pending || !reason.trim()} onClick={() => run(() => revokeApprovalAction(start, end, reason), close)}>
            {pending ? "Taking back…" : "Take back approval"}
          </Button>
          <Button size="sm" variant="secondary" onClick={close}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {status === "approved" ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setStep("revoke")}>
                Take back approval
              </Button>
              <Button disabled={!!blocked} title={blocked ?? undefined} onClick={() => setStep("lock")}>
                Lock period
              </Button>
            </>
          ) : (
            <>
              {status === "stale" && (
                <Button size="sm" variant="secondary" onClick={() => setStep("revoke")}>
                  Take back approval
                </Button>
              )}
              <Button disabled={!!blocked} title={blocked ?? undefined} onClick={() => setStep("approve")}>
                {status === "stale" ? "Approve again" : "Approve figures"}
              </Button>
            </>
          )}
        </div>
      )}
      {blocked && <span className="text-xs text-red-700">{blocked}</span>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
