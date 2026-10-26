"use client";

import { Input, Textarea } from "@/components/ui";
import type { Level } from "@/domain/client-privacy";

export type EntryField = { key: string; label?: string; level: Level };
export type EntryValues = Record<string, string>;

const BUILTIN: Record<string, { label: string; type?: string; inputMode?: "tel" | "email"; wide?: boolean }> = {
  phone: { label: "Mobile (for reminders)", type: "tel", inputMode: "tel" },
  email: { label: "Email", type: "email", inputMode: "email" },
  address: { label: "Address (street, city, state zip)", wide: true },
  birthday: { label: "Birthday", type: "date" },
};

const later = (l: Level) => (l === "hidden" ? "hidden once saved" : l === "masked" ? "masked once saved" : null);

/** The details a new client can be given at the desk; only the ones this person may add are offered. */
export function ClientEntryFields({ fields, values, onChange, skip = [] }: { fields: EntryField[]; values: EntryValues; onChange: (v: EntryValues) => void; skip?: string[] }) {
  const shown = fields.filter((f) => !skip.includes(f.key));
  if (!shown.length) return null;
  const set = (k: string) => (e: { target: { value: string } }) => onChange({ ...values, [k]: e.target.value });
  return (
    <>
      {shown.map((f) => {
        const b = BUILTIN[f.key];
        const hint = later(f.level);
        const label = b?.label ?? (f.key === "notes" ? "Client notes (staff only)" : (f.label ?? "Custom field"));
        const placeholder = hint ? `${label}, ${hint}` : label;
        return f.key === "notes" ? (
          <Textarea key={f.key} className="col-span-2" rows={2} aria-label={label} placeholder={placeholder} value={values[f.key] ?? ""} onChange={set(f.key)} />
        ) : (
          <Input
            key={f.key}
            className={b && !b.wide ? undefined : "col-span-2"}
            aria-label={label}
            title={f.key === "birthday" ? placeholder : undefined}
            type={b?.type}
            inputMode={b?.inputMode}
            placeholder={placeholder}
            value={values[f.key] ?? ""}
            onChange={set(f.key)}
          />
        );
      })}
    </>
  );
}

/** What to send with the booking, walk-in or ticket: typed details only, custom fields by id. */
export function entryPayload(fields: EntryField[], v: EntryValues) {
  const given = (k: string) => (fields.some((f) => f.key === k) && v[k]?.trim() ? v[k].trim() : undefined);
  const custom = Object.fromEntries(fields.flatMap((f) => (f.key.startsWith("custom:") && v[f.key]?.trim() ? [[f.key.slice(7), v[f.key].trim()]] : [])));
  return { phone: given("phone"), email: given("email"), address: given("address"), birthday: given("birthday"), notes: given("notes"), custom };
}
