"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import type { Level } from "@/domain/client-privacy";
import { createCustomerAction } from "../actions";

/** A detail the person may add, and how they'll see it once it's saved. */
type Addable = { key: string; label?: string; level: Level };

const BUILTIN: Record<string, { label: string; type?: string; placeholder?: string; wide?: boolean }> = {
  phone: { label: "Mobile", type: "tel", placeholder: "(319) 555-0123" },
  email: { label: "Email", type: "email" },
  address: { label: "Address", placeholder: "Street, city, state zip", wide: true },
  birthday: { label: "Birthday", type: "date" },
};

const later = (l: Level) => (l === "hidden" ? "You won't see this once it's saved." : l === "masked" ? "Once saved, you'll see it masked." : undefined);

/** Only the details the brand portal lets this person add get an input; they may be ones the person won't see once saved. */
export function NewClientForm({
  shops,
  barbers,
  defaultShopId,
  fields,
}: {
  shops: { id: string; name: string }[];
  barbers: { id: string; label: string }[];
  defaultShopId: string | null;
  fields: Addable[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState({ firstName: "", lastName: "", smsOptIn: false, emailOptIn: false, homeShopId: defaultShopId, preferredStaffId: null as string | null });
  const [v, setV] = useState<Record<string, string>>({});
  const may = (k: string) => fields.find((f) => f.key === k);
  const preferred = may("preferred_barber");
  const notes = may("notes");
  const set = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const submit = () => {
    const given = (k: string) => (may(k) && v[k]?.trim() ? v[k] : undefined);
    const custom = Object.fromEntries(fields.flatMap((f) => (f.key.startsWith("custom:") && v[f.key]?.trim() ? [[f.key.slice(7), v[f.key]]] : [])));
    start(async () => {
      const r = await createCustomerAction({
        ...p,
        phone: given("phone"),
        email: given("email"),
        address: given("address"),
        birthday: given("birthday"),
        notes: given("notes"),
        custom,
        preferredStaffId: preferred ? p.preferredStaffId : undefined,
      });
      if (!r.ok) return setError(r.error);
      router.push(`/admin/customers/${r.data.id}${r.data.existed ? "?existing=1" : ""}`);
    });
  };
  return (
    <Card>
      <div className="grid grid-cols-2 gap-3 p-4">
        <Field label="First name">
          <Input value={p.firstName} onChange={(e) => setP({ ...p, firstName: e.target.value })} autoFocus />
        </Field>
        <Field label="Last name">
          <Input value={p.lastName} onChange={(e) => setP({ ...p, lastName: e.target.value })} />
        </Field>
        {fields
          .filter((f) => BUILTIN[f.key])
          .map((f) => (
            <Field key={f.key} label={BUILTIN[f.key].label} hint={later(f.level)} className={BUILTIN[f.key].wide ? "col-span-2" : undefined}>
              <Input type={BUILTIN[f.key].type} placeholder={BUILTIN[f.key].placeholder} value={v[f.key] ?? ""} onChange={set(f.key)} />
            </Field>
          ))}
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
        {preferred && (
          <Field label="Preferred barber" hint={later(preferred.level)}>
            <Select value={p.preferredStaffId ?? ""} onChange={(e) => setP({ ...p, preferredStaffId: e.target.value || null })}>
              <option value="">No preference</option>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {fields
          .filter((f) => f.key.startsWith("custom:"))
          .map((f) => (
            <Field key={f.key} label={f.label ?? "Custom field"} hint={later(f.level)} className="col-span-2">
              <Input value={v[f.key] ?? ""} onChange={set(f.key)} />
            </Field>
          ))}
        {notes && (
          <Field label="Notes (staff only)" hint={later(notes.level)} className="col-span-2">
            <Textarea rows={3} value={v.notes ?? ""} onChange={set("notes")} />
          </Field>
        )}
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
        <Button disabled={pending || !p.firstName.trim()} onClick={submit}>
          Add client
        </Button>
      </div>
    </Card>
  );
}
