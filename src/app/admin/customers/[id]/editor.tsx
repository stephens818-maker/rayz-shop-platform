"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, useTransition, type ReactNode } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import type { Level } from "@/domain/client-privacy";
import { findClientsAction, grantRewardAction, mergeCustomersAction, updateCustomerAction, updateNotesAction } from "../actions";
import { Masked } from "../privacy";

type P = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
  birthday: string;
  notes: string;
  custom: Record<string, string>;
  smsOptIn: boolean;
  emailOptIn: boolean;
  homeShopId: string | null;
  preferredStaffId: string | null;
};

/** A client field as the viewer may see it: `value` is already masked unless the level is full. */
export type ShownField = { key: string; label: string; level: Level; value: string | null };

const INPUT: Record<string, { type?: string; placeholder?: string; wide?: boolean }> = {
  phone: { type: "tel", placeholder: "(319) 555-0123" },
  email: { type: "email" },
  address: { placeholder: "Street, city, state zip", wide: true },
  birthday: { type: "date" },
};

/** Masked fields show with Reveal; hidden ones aren't sent at all, so they're only named. */
function FieldRows({ id, fields, canReveal, input }: { id: string; fields: ShownField[]; canReveal: boolean; input: (f: ShownField) => ReactNode }) {
  const hidden = fields.filter((f) => f.level === "hidden");
  return (
    <>
      {fields
        .filter((f) => f.level !== "hidden")
        .map((f) =>
          f.level === "full" ? (
            <Field key={f.key} label={f.label} className={INPUT[f.key]?.wide || f.key.startsWith("custom:") ? "col-span-2" : undefined}>
              {input(f)}
            </Field>
          ) : (
            <div key={f.key} className="col-span-2 text-sm">
              <div className="mb-1 text-xs font-medium text-zinc-700">{f.label}</div>
              <Masked customerId={id} field={f.key} value={f.value} level={f.level} canReveal={canReveal} />
            </div>
          ),
        )}
      {hidden.length > 0 && <p className="col-span-2 text-xs text-zinc-500">Not shown to you: {hidden.map((f) => f.label.toLowerCase()).join(", ")}.</p>}
    </>
  );
}

export function CustomerEditor({
  id,
  initial,
  fields,
  canReveal,
  preferred,
  shops,
  barbers,
  usualBarber,
}: {
  id: string;
  initial: P;
  fields: ShownField[];
  canReveal: boolean;
  preferred: ShownField;
  shops: { id: string; name: string }[];
  barbers: { id: string; label: string }[];
  usualBarber: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [p, setP] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const value = (key: string) => (key.startsWith("custom:") ? (p.custom[key.slice(7)] ?? "") : String(p[key as keyof P] ?? ""));
  const set = (key: string, v: string) => setP(key.startsWith("custom:") ? { ...p, custom: { ...p.custom, [key.slice(7)]: v } } : { ...p, [key]: v });
  const notes = fields.find((f) => f.key === "notes");
  return (
    <Card>
      <CardHeader title="Contact & preferences" />
      <div className="grid grid-cols-2 gap-3 p-4">
        <Field label="First name">
          <Input value={p.firstName} onChange={(e) => setP({ ...p, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input value={p.lastName} onChange={(e) => setP({ ...p, lastName: e.target.value })} />
        </Field>
        <FieldRows
          id={id}
          canReveal={canReveal}
          fields={fields.filter((f) => f.key !== "notes")}
          input={(f) => <Input type={INPUT[f.key]?.type} placeholder={INPUT[f.key]?.placeholder} value={value(f.key)} onChange={(e) => set(f.key, e.target.value)} />}
        />
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
        {preferred.level === "full" ? (
          <Field label="Preferred barber" hint={usualBarber ? `Usually sees ${usualBarber}` : undefined}>
            <Select value={p.preferredStaffId ?? ""} onChange={(e) => setP({ ...p, preferredStaffId: e.target.value || null })}>
              <option value="">No preference</option>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : preferred.level === "masked" ? (
          <div className="text-sm">
            <div className="mb-1 text-xs font-medium text-zinc-700">Preferred barber</div>
            <Masked customerId={id} field="preferred_barber" value={preferred.value} level="masked" canReveal={canReveal} empty="No preference" />
          </div>
        ) : null}
        {notes && (
          <FieldRows
            id={id}
            canReveal={canReveal}
            fields={[{ ...notes, label: "Notes (staff only)" }]}
            input={() => <Textarea rows={3} value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} placeholder="#2 on sides, likes a skin fade…" />}
          />
        )}
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

/** What someone without "edit clients" sees: the details their role shows, and cut notes they can edit when notes are shown in full. */
export function NotesEditor({
  id,
  initial,
  notes: notesField,
  fields,
  canReveal,
  preferred,
  usual,
}: {
  id: string;
  initial: string;
  notes: ShownField;
  fields: ShownField[];
  canReveal: boolean;
  preferred: string | null;
  usual: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const shown = fields.filter((f) => f.level !== "hidden" && f.value);
  return (
    <Card>
      <CardHeader title="Notes" subtitle={[preferred && `Prefers ${preferred}`, usual && `usually sees ${usual}`].filter(Boolean).join(" · ") || undefined} />
      {shown.length > 0 && (
        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 border-b border-zinc-100 px-4 py-3 text-sm">
          {shown.map((f) => (
            <Fragment key={f.key}>
              <dt className="text-zinc-500">{f.label}</dt>
              <dd className="col-span-2">
                <Masked customerId={id} field={f.key} value={f.value} level={f.level} canReveal={canReveal} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {notesField.level !== "full" ? (
        <div className="p-4 text-sm">
          <Masked customerId={id} field="notes" value={notesField.value} level={notesField.level} canReveal={canReveal} empty="No notes" />
        </div>
      ) : (
        <>
          <div className="p-4">
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="#2 on sides, likes a skin fade…" />
          </div>
          <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await updateNotesAction(id, notes);
                  setMsg(r.ok ? "Saved" : r.error);
                  router.refresh();
                })
              }
            >
              Save notes
            </Button>
            {msg && <span className="text-sm text-zinc-600">{msg}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

type Found = { id: string; firstName: string; lastName: string | null; phone: string | null; email: string | null };

export function MergeInto({ keepId, keepName, suggestions }: { keepId: string; keepName: string; suggestions: { id: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const r = await findClientsAction(q);
      if (r.ok) setFound(r.data.filter((f) => f.id !== keepId));
    }, 200);
    return () => clearTimeout(t);
  }, [q, keepId]);
  const merge = (dropId: string, label: string) => {
    if (!confirm(`Merge ${label} into ${keepName}? ${label}'s record is removed and everything moves to ${keepName}. This can't be undone (the audit log keeps a copy).`)) return;
    start(async () => {
      const r = await mergeCustomersAction(keepId, dropId);
      if (!r.ok) return setError(r.error);
      setQ("");
      router.push(`/admin/customers/${keepId}?merged=1`);
      router.refresh();
    });
  };
  return (
    <div className="space-y-2 border-t border-zinc-100 p-4">
      {suggestions.map((s) => (
        <Button key={s.id} size="sm" variant="secondary" className="w-full" disabled={pending} onClick={() => merge(s.id, s.label)}>
          Merge {s.label} into this client
        </Button>
      ))}
      <Input placeholder="Find another record to merge in" value={q} onChange={(e) => setQ(e.target.value)} />
      {found.map((f) => {
        const label = `${f.firstName} ${f.lastName ?? ""}`.trim();
        return (
          <button key={f.id} disabled={pending} onClick={() => merge(f.id, label)} className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-50">
            {label} <span className="text-zinc-500">{f.phone || f.email}</span>
          </button>
        );
      })}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
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
