"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { createCustomerAction } from "../actions";

export function NewClientForm({ shops, barbers, defaultShopId }: { shops: { id: string; name: string }[]; barbers: { id: string; label: string }[]; defaultShopId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState({ firstName: "", lastName: "", phone: "", email: "", notes: "", smsOptIn: false, emailOptIn: false, homeShopId: defaultShopId, preferredStaffId: null as string | null });
  return (
    <Card>
      <div className="grid grid-cols-2 gap-3 p-4">
        <Field label="First name">
          <Input value={p.firstName} onChange={(e) => setP({ ...p, firstName: e.target.value })} autoFocus />
        </Field>
        <Field label="Last name">
          <Input value={p.lastName} onChange={(e) => setP({ ...p, lastName: e.target.value })} />
        </Field>
        <Field label="Mobile">
          <Input type="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} placeholder="(319) 555-0123" />
        </Field>
        <Field label="Email">
          <Input type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />
        </Field>
        <Field label="Home shop">
          <Select value={p.homeShopId ?? ""} onChange={(e) => setP({ ...p, homeShopId: e.target.value || null })}>
            <option value="">—</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Preferred barber">
          <Select value={p.preferredStaffId ?? ""} onChange={(e) => setP({ ...p, preferredStaffId: e.target.value || null })}>
            <option value="">No preference</option>
            {barbers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes (staff only)" className="col-span-2">
          <Textarea rows={3} value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.smsOptIn} onChange={(e) => setP({ ...p, smsOptIn: e.target.checked })} /> Client agreed to texts
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.emailOptIn} onChange={(e) => setP({ ...p, emailOptIn: e.target.checked })} /> Client agreed to emails
        </label>
      </div>
      {error && (
        <div className="px-4 pb-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
      <div className="border-t border-zinc-100 px-4 py-3">
        <Button
          disabled={pending || !p.firstName.trim()}
          onClick={() =>
            start(async () => {
              const r = await createCustomerAction(p);
              if (!r.ok) return setError(r.error);
              router.push(`/admin/customers/${r.data.id}${r.data.existed ? "?existing=1" : ""}`);
            })
          }
        >
          Add client
        </Button>
      </div>
    </Card>
  );
}
