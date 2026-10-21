"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { formatPhone } from "@/lib/phone";
import { findClientsAction, grantRewardAction, mergeCustomersAction, updateCustomerAction, updateNotesAction } from "../actions";

type P = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  notes: string;
  smsOptIn: boolean;
  emailOptIn: boolean;
  homeShopId: string | null;
  preferredStaffId: string | null;
};

export function CustomerEditor({
  id,
  initial,
  shops,
  barbers,
  usualBarber,
  showContact,
}: {
  id: string;
  initial: P;
  shops: { id: string; name: string }[];
  barbers: { id: string; label: string }[];
  usualBarber: string | null;
  showContact: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [p, setP] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
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
        {showContact ? (
          <>
            <Field label="Mobile" className="col-span-2">
              <Input value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />
            </Field>
            <Field label="Email" className="col-span-2">
              <Input value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />
            </Field>
          </>
        ) : (
          <p className="col-span-2 text-xs text-zinc-500">Phone and email are hidden: your role doesn&apos;t include client contact info.</p>
        )}
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

/** What a barber sees for their own client: cut notes they can edit, and who the client likes. */
export function NotesEditor({ id, initial, preferred, usual }: { id: string; initial: string; preferred: string | null; usual: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Notes" subtitle={[preferred && `Prefers ${preferred}`, usual && `usually sees ${usual}`].filter(Boolean).join(" · ") || undefined} />
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
            {label} <span className="text-zinc-500">{formatPhone(f.phone) || f.email}</span>
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
