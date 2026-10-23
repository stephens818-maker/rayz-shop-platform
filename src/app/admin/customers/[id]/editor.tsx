"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Textarea, cx } from "@/components/ui";
import type { ShownField } from "@/domain/client-privacy";
import { findClientsAction, grantRewardAction, mergeCustomersAction, updateCustomerAction, updateNotesAction } from "../actions";
import { Masked } from "../privacy";

type P = { firstName: string; lastName: string; smsOptIn: boolean; emailOptIn: boolean; allowOtherShop: boolean; homeShopId: string | null; preferredStaffId: string | null };

const INPUT: Record<string, { type?: string; placeholder?: string; wide?: boolean }> = {
  phone: { type: "tel", placeholder: "(319) 555-0123" },
  email: { type: "email" },
  address: { placeholder: "Street, city, state zip", wide: true },
  birthday: { type: "date" },
};
const NOTES_PLACEHOLDER = "#2 on sides, likes a skin fade…";

const editable = (f: ShownField) => (f.saved ? f.canEdit : f.canAdd);
const wide = (key: string) => key === "notes" || !!INPUT[key]?.wide || key.startsWith("custom:");
/** What becomes of a value typed into a field the person doesn't see in full. */
const afterSave = (f: ShownField) => (f.level === "hidden" ? "You won't see this once it's saved." : "Once saved, you'll see it masked.");

function Control({ field, value, onChange, autoFocus }: { field: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return field === "notes" ? (
    <Textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={NOTES_PLACEHOLDER} autoFocus={autoFocus} />
  ) : (
    <Input type={INPUT[field]?.type} placeholder={INPUT[field]?.placeholder} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} />
  );
}

/**
 * One protected field on a form. A field seen in full is an input when the person may enter it.
 * Anything else shows only as the person may see it (masked, or "Saved, hidden by policy"), with
 * Replace when they may edit it; what they type stays in the form until it's saved, then the field
 * shows at their level again. An empty field they may add to is a blank input.
 */
function Protected({
  id,
  f,
  canReveal,
  value,
  draft,
  onValue,
  onDraft,
}: {
  id: string;
  f: ShownField;
  canReveal: boolean;
  /** The current value, for a field seen in full. */
  value: string;
  /** What's being typed into a field not seen in full; undefined: not being replaced. */
  draft: string | undefined;
  onValue: (v: string) => void;
  onDraft: (v: string | undefined) => void;
}) {
  const span = wide(f.key) ? "col-span-2" : undefined;
  if (f.level === "full")
    return editable(f) ? (
      <Field label={f.label} className={span}>
        <Control field={f.key} value={value} onChange={onValue} />
      </Field>
    ) : (
      <div className={cx("text-sm", span)}>
        <div className="mb-1 text-xs font-medium text-zinc-700">{f.label}</div>
        <span className="whitespace-pre-line">{f.value ?? <span className="text-zinc-400">—</span>}</span>
      </div>
    );
  if (!f.saved)
    return f.canAdd ? (
      <Field label={f.label} hint={afterSave(f)} className={span}>
        <Control field={f.key} value={draft ?? ""} onChange={onDraft} />
      </Field>
    ) : (
      <div className="col-span-2 text-sm">
        <div className="mb-1 text-xs font-medium text-zinc-700">{f.label}</div>
        <span className="text-zinc-400">—</span>
      </div>
    );
  return (
    <div className="col-span-2 text-sm">
      <div className="mb-1 text-xs font-medium text-zinc-700">{f.label}</div>
      <span className="inline-flex flex-wrap items-center gap-2">
        {f.level === "hidden" ? (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">Saved, hidden by policy</span>
        ) : (
          <Masked customerId={id} field={f.key} value={f.value} level={f.level} canReveal={canReveal} />
        )}
        {f.canEdit && draft === undefined && (
          <button type="button" className="text-xs text-brand-700 underline" onClick={() => onDraft("")}>
            Replace
          </button>
        )}
      </span>
      {draft !== undefined && (
        <div className="mt-2 space-y-1">
          <Control field={f.key} value={draft} onChange={onDraft} autoFocus />
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>Replaces what&apos;s on file without showing it. {afterSave(f)}</span>
            <button type="button" className="underline" onClick={() => onDraft(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Typed values and replacements for the protected fields. `entries` is what goes to the server:
 * fields seen in full and editable, and anything typed into one that isn't; nothing else, so a
 * field left alone is never compared or overwritten.
 */
function useProtected(fields: ShownField[], initial: Record<string, string>) {
  const [shown, setShown] = useState(fields);
  const [values, setValues] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const latest = JSON.stringify(fields);
  useEffect(() => setShown(JSON.parse(latest)), [latest]);
  const entries = () =>
    Object.fromEntries(
      shown.flatMap((f): [string, string][] => (f.level === "full" ? (editable(f) ? [[f.key, values[f.key] ?? ""]] : []) : drafts[f.key]?.trim() ? [[f.key, drafts[f.key]]] : [])),
    );
  /** After a save: show the fields as the server answered (at the person's level) and drop what was typed. */
  const saved = (next: ShownField[]) => {
    setShown((cur) => cur.map((f) => next.find((n) => n.key === f.key) ?? f));
    setDrafts({});
    setVersion((v) => v + 1);
  };
  const field = (f: ShownField, id: string, canReveal: boolean) => (
    <Protected
      key={`${f.key}:${version}`}
      id={id}
      f={f}
      canReveal={canReveal}
      value={values[f.key] ?? ""}
      draft={drafts[f.key] ?? (f.level !== "full" && !f.saved && f.canAdd ? "" : undefined)}
      onValue={(v) => setValues({ ...values, [f.key]: v })}
      onDraft={(v) => setDrafts(({ [f.key]: _, ...rest }) => (v === undefined ? rest : { ...rest, [f.key]: v }))}
    />
  );
  return { shown, entries, saved, field };
}

export function CustomerEditor({
  id,
  initial,
  values,
  fields,
  canReveal,
  preferred,
  shops,
  barbers,
  usualBarber,
}: {
  id: string;
  initial: P;
  /** Fields seen in full, as they are on file. */
  values: Record<string, string>;
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
  const prot = useProtected(fields, values);
  const notHere = prot.shown.filter((f) => f.level === "hidden" && !f.saved && !f.canAdd);
  const save = () =>
    start(async () => {
      const e = prot.entries();
      const custom = Object.fromEntries(Object.entries(e).flatMap(([k, v]) => (k.startsWith("custom:") ? [[k.slice(7), v]] : [])));
      const r = await updateCustomerAction(id, {
        ...p,
        phone: e.phone,
        email: e.email,
        address: e.address,
        birthday: e.birthday,
        notes: e.notes,
        custom,
        preferredStaffId: preferred.level === "full" && editable(preferred) ? p.preferredStaffId : undefined,
      });
      setMsg(r.ok ? "Saved" : r.error);
      if (r.ok) prot.saved(r.data.fields);
      router.refresh();
    });
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
        {prot.shown.filter((f) => f.key !== "notes" && !notHere.includes(f)).map((f) => prot.field(f, id, canReveal))}
        {notHere.length > 0 && <p className="col-span-2 text-xs text-zinc-500">Not shown to you: {notHere.map((f) => f.label.toLowerCase()).join(", ")}.</p>}
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
            <Select disabled={!editable(preferred)} value={p.preferredStaffId ?? ""} onChange={(e) => setP({ ...p, preferredStaffId: e.target.value || null })}>
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
        {prot.shown.filter((f) => f.key === "notes" && !notHere.includes(f)).map((f) => prot.field({ ...f, label: "Notes (staff only)" }, id, canReveal))}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.smsOptIn} onChange={(e) => setP({ ...p, smsOptIn: e.target.checked })} /> Texts
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.emailOptIn} onChange={(e) => setP({ ...p, emailOptIn: e.target.checked })} /> Emails
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.allowOtherShop} onChange={(e) => setP({ ...p, allowOtherShop: e.target.checked })} /> OK to move to another shop when their barber calls in
        </label>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button disabled={pending} onClick={save}>
          Save
        </Button>
        {msg && <span className="text-sm text-zinc-600">{msg}</span>}
      </div>
    </Card>
  );
}

/** What someone without "edit clients" sees: the details their role shows, and cut notes as the portal lets them add or edit them. */
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
  const [msg, setMsg] = useState<string | null>(null);
  const prot = useProtected([notesField], { notes: initial });
  const notes = prot.shown[0];
  const shown = fields.filter((f) => f.level !== "hidden" && f.value);
  const sending = prot.entries().notes;
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
      <div className="grid grid-cols-2 p-4">{prot.field({ ...notes, label: "Client notes" }, id, canReveal)}</div>
      {sending !== undefined && (
        <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await updateNotesAction(id, sending);
                setMsg(r.ok ? "Saved" : r.error);
                if (r.ok) prot.saved([r.data.notes]);
                router.refresh();
              })
            }
          >
            Save notes
          </Button>
          {msg && <span className="text-sm text-zinc-600">{msg}</span>}
        </div>
      )}
      {sending === undefined && msg && <p className="border-t border-zinc-100 px-4 py-3 text-sm text-zinc-600">{msg}</p>}
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
