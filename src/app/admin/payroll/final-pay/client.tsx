"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { approveFinalPayAction } from "../actions";

export function ApproveFinalPay({ staffId, lastDay, name, blocked }: { staffId: string; lastDay: string; name: string; blocked: string | null }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col items-end gap-1" data-testid="final-pay-approve">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Input aria-label="Final pay note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 w-56 text-xs" />
        <Button disabled={pending || !!blocked} title={blocked ?? undefined} onClick={() => run(() => approveFinalPayAction({ staffId, lastDay, note }), () => router.push("/admin/payroll/final-pay"))}>
          {pending ? "Approving…" : `Approve ${name}'s final pay`}
        </Button>
      </div>
      {blocked && <span className="max-w-md text-right text-xs text-zinc-600">{blocked}</span>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
