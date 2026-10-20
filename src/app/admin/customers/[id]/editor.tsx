"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Textarea } from "@/components/ui";
import { grantRewardAction, updateCustomerAction } from "../actions";

type P = { firstName: string; lastName: string; phone: string; email: string; notes: string; smsOptIn: boolean; emailOptIn: boolean };

export function CustomerEditor({ id, initial }: { id: string; initial: P }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [p, setP] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Contact" />
      <div className="grid grid-cols-2 gap-3 p-4">
        <Field label="First name">
          <Input value={p.firstName} onChange={(e) => setP({ ...p, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input value={p.lastName} onChange={(e) => setP({ ...p, lastName: e.target.value })} />
        </Field>
        <Field label="Mobile" className="col-span-2">
          <Input value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />
        </Field>
        <Field label="Email" className="col-span-2">
          <Input value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />
        </Field>
        <Field label="Notes (staff only)" className="col-span-2">
          <Textarea rows={3} value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} placeholder="#2 on sides, likes a skin fade…" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.smsOptIn} onChange={(e) => setP({ ...p, smsOptIn: e.target.checked })} /> Texts
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.emailOptIn} onChange={(e) => setP({ ...p, emailOptIn: e.target.checked })} /> Emails
        </label>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await updateCustomerAction(id, p);
              setMsg(r.ok ? "Saved" : r.error);
              router.refresh();
            })
          }
        >
          Save
        </Button>
        {msg && <span className="text-sm text-zinc-600">{msg}</span>}
      </div>
    </Card>
  );
}

export function GrantReward({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="border-t border-zinc-100 px-4 py-3">
      <button
        className="text-xs underline"
        disabled={pending}
        onClick={() => {
          const reason = prompt("Reason for a courtesy reward?");
          if (reason) start(async () => (await grantRewardAction(customerId, reason), router.refresh()));
        }}
      >
        Grant a courtesy reward
      </button>
    </div>
  );
}
