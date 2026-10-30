"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { drawerMoveAction, noSaleAction, openDrawerAction } from "./actions";

const cents = (s: string) => Math.round((Number(s) || 0) * 100);

export function OpenDrawerForm({ shopId, date, defaultCents }: { shopId: string; date: string; defaultCents: number }) {
  const router = useRouter();
  const [amount, setAmount] = useState((defaultCents / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3 p-4" data-testid="open-drawer">
      <Field label="Opening balance" hint={`The shop's usual opening is $${(defaultCents / 100).toFixed(2)}. Count the drawer and change it if it's different.`}>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <Button
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await openDrawerAction({ shopId, date, openingCents: cents(amount) });
            if (!r.ok) setError(r.error);
            else router.refresh();
          })
        }
      >
        Open drawer
      </Button>
    </div>
  );
}

export function DrawerMoveForm({ shopId, date }: { shopId: string; date: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<"paid_out" | "paid_in">("paid_out");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3 p-4" data-testid="drawer-move">
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <Field label="Cash">
          <Select value={kind} onChange={(e) => setKind(e.target.value as "paid_out" | "paid_in")}>
            <option value="paid_out">Paid out</option>
            <option value="paid_in">Paid in</option>
          </Select>
        </Field>
        <Field label="Amount">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </Field>
      </div>
      <Field label="What for">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === "paid_out" ? "Towels from the store" : "Change from the bank"} />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <Button
        variant="secondary"
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await drawerMoveAction({ shopId, date, kind, amountCents: cents(amount), reason });
            if (!r.ok) setError(r.error);
            else {
              setError(null);
              setAmount("");
              setReason("");
              router.refresh();
            }
          })
        }
      >
        Record {kind === "paid_out" ? "paid out" : "paid in"}
      </Button>
    </div>
  );
}

/** Opens the drawer with no sale, to make change. Kept in the register history with who did it. */
export function NoSaleButton({ shopId, date }: { shopId: string; date: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 p-4" data-testid="no-sale">
      <Input className="min-w-40 flex-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional): making change" aria-label="Why the drawer was opened" />
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await noSaleAction({ shopId, date, reason });
            if (!r.ok) return setMsg({ ok: false, text: r.error });
            setReason("");
            setMsg({ ok: true, text: "Recorded: opened, no sale" });
            router.refresh();
          })
        }
      >
        Open drawer, no sale
      </Button>
      {msg && <span className={msg.ok ? "text-xs text-green-700" : "text-xs text-red-600"}>{msg.text}</span>}
    </div>
  );
}
