"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Notice, Select } from "@/components/ui";
import type { ActionResult } from "@/server/action";
import { acknowledgeCashAction, approveBatchAction, buildBatchAction, cancelBatchAction, payoutAction } from "./actions";

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        after?.(r.data);
        router.refresh();
      }
    });
  return { pending, error, run };
}

export function BuildBatch({ shopId, defaultCutoff, today, hasDraft, label }: { shopId: string; defaultCutoff: string; today: string; hasDraft: boolean; label?: string }) {
  const router = useRouter();
  const [cutoff, setCutoff] = useState(defaultCutoff);
  const { pending, error, run } = useAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-zinc-600">
          Tips through
          <Input type="date" className="w-36 py-1" max={today} value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
        </label>
        <Button size="sm" disabled={pending} onClick={() => run(() => buildBatchAction({ shopId, cutoff }), (d) => router.push(`/admin/tips/${(d as { batchId: string }).batchId}`))}>
          {label ?? (hasDraft ? "Refresh draft batch" : "Build batch")}
        </Button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function BatchActions({ batchId, canApprove, total }: { batchId: string; canApprove: boolean; total: string }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending || !canApprove} onClick={() => run(() => approveBatchAction(batchId))}>
          Approve and pay {total}
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => setCancelling(!cancelling)}>
          Cancel batch
        </Button>
      </div>
      {cancelling && (
        <div className="flex items-center gap-2">
          <Input placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="danger" size="sm" disabled={pending || !reason.trim()} onClick={() => run(() => cancelBatchAction(batchId, reason))}>
            Cancel it
          </Button>
        </div>
      )}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

type PayoutOp = "hold" | "release" | "remove" | "adjust";
const OP_LABEL: Record<PayoutOp, string> = { hold: "Hold", release: "Release", remove: "Take out", adjust: "Adjust" };

export function PayoutActions({ payoutId, ops }: { payoutId: string; ops: PayoutOp[] }) {
  const [op, setOp] = useState<PayoutOp | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const { pending, error, run } = useAction();
  if (!ops.length) return null;
  const cents = Math.round((Number(amount) || 0) * 100);
  const submit = (o: PayoutOp) => run(() => payoutAction({ payoutId, action: o, reason, cents }), () => (setOp(null), setReason(""), setAmount("")));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {ops.map((o) => (
          <Button key={o} size="sm" variant={op === o ? "dark" : "secondary"} disabled={pending} onClick={() => (o === "release" ? submit(o) : setOp(op === o ? null : o))}>
            {OP_LABEL[o]}
          </Button>
        ))}
      </div>
      {op && op !== "release" && (
        <div className="flex flex-wrap items-center gap-2">
          {op === "adjust" && <Input className="w-28" inputMode="decimal" placeholder="+/- dollars" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          <Input className="min-w-56 flex-1" placeholder="Reason (required, goes in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" disabled={pending || !reason.trim() || (op === "adjust" && !cents)} onClick={() => submit(op)}>
            {op === "hold" ? "Hold payout" : op === "remove" ? "Take out of batch" : "Add adjustment"}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** At the drawer: the employee takes their cash and acknowledges it with their clock PIN or by typing their name. */
export function CashAck({ payoutId, name, amount }: { payoutId: string; name: string; amount: string }) {
  const [by, setBy] = useState<"pin" | "name">("pin");
  const [value, setValue] = useState("");
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-40 py-1" value={by} onChange={(e) => (setBy(e.target.value as "pin" | "name"), setValue(""))}>
          <option value="pin">Clock PIN</option>
          <option value="name">Type full name</option>
        </Select>
        <Input
          className={by === "pin" ? "w-28 py-1" : "w-48 py-1"}
          type={by === "pin" ? "password" : "text"}
          inputMode={by === "pin" ? "numeric" : "text"}
          autoComplete="off"
          placeholder={by === "pin" ? "PIN" : name}
          value={value}
          onChange={(e) => setValue(by === "pin" ? e.target.value.replace(/\D/g, "") : e.target.value)}
        />
        <Button
          size="sm"
          disabled={pending || !value.trim()}
          onClick={() => run(() => acknowledgeCashAction({ payoutId, by, ...(by === "pin" ? { pin: value } : { name: value }) }), () => setValue(""))}
        >
          {name} received {amount}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
