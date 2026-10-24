"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ClientHitRow } from "@/components/client-hit";
import { Button, Card, CardHeader, Field, Input } from "@/components/ui";
import type { ClientHit } from "@/domain/client-search";
import type { ActionResult } from "@/server/action";
import { searchCustomersAction } from "../../calendar/actions";
import { addChildAction, attachChildAction, detachChildAction, splitChildAction, updateChildAction } from "../family-actions";

export interface FamilyKid {
  id: string;
  firstName: string;
  lastName: string | null;
  birthday: string | null;
  age: number | null;
  notes: string | null;
  visits: number;
  lastVisit: string | null;
  cadence: string | null;
  canSplit: boolean;
}

type Draft = { firstName: string; lastName: string; birthday: string; age: string; notes: string };
const blank: Draft = { firstName: "", lastName: "", birthday: "", age: "", notes: "" };
const draftOf = (k: FamilyKid): Draft => ({ firstName: k.firstName, lastName: k.lastName ?? "", birthday: k.birthday ?? "", age: k.age != null && !k.birthday ? String(k.age) : "", notes: k.notes ?? "" });

/**
 * A client's family on their profile: a parent's children (add, edit, take off, give their own
 * account from the brand's age, or put an existing client on the account), or for a child, whose
 * account they're on.
 */
export function FamilyCard(props: {
  customerId: string;
  firstName: string;
  /** This client is a child: their parent, and their own profile to edit and maybe split. */
  parent: { id: string; name: string } | null;
  self: FamilyKid | null;
  /** Split off or taken off a parent's account earlier. */
  former: { id: string; name: string; at: string | null } | null;
  kids: FamilyKid[];
  settings: { maxChildren: number; splitAge: number; loyalty: "household" | "individual" };
  canEdit: boolean;
  /** Which fields this person may enter: the same per-field rules as any client. */
  allow: { birthday: boolean; notes: boolean; phone: boolean; email: boolean };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [split, setSplit] = useState({ phone: "", email: "", smsOptIn: false });
  const [attachQ, setAttachQ] = useState("");
  const [hits, setHits] = useState<ClientHit[]>([]);

  const run = <T,>(fn: () => Promise<ActionResult<T>>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.();
      setEditing(null);
      setSplitting(null);
      router.refresh();
    });
  const input = (d: Draft) => ({
    firstName: d.firstName,
    lastName: d.lastName,
    ...(props.allow.birthday ? { birthday: d.birthday, ...(d.birthday ? {} : { age: d.age.trim() ? Number(d.age) : null }) } : {}),
    ...(props.allow.notes ? { notes: d.notes } : {}),
  });
  const full = props.kids.length >= props.settings.maxChildren;

  const form = (save: () => void, label: string) => (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="First name">
          <Input value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
        </Field>
        {props.allow.birthday && (
          <>
            <Field label="Birthday">
              <Input type="date" value={draft.birthday} onChange={(e) => setDraft({ ...draft, birthday: e.target.value })} />
            </Field>
            <Field label="Or age">
              <Input inputMode="numeric" disabled={!!draft.birthday} value={draft.age} onChange={(e) => setDraft({ ...draft, age: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
            </Field>
          </>
        )}
      </div>
      {props.allow.notes && (
        <Field label="Notes" hint="Sensory needs, style preferences">
          <textarea className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm" rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
        </Field>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !draft.firstName.trim()} onClick={save}>
          {label}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );

  const splitForm = (k: FamilyKid) => (
    <div className="mt-2 space-y-2 rounded-lg bg-zinc-50 p-3">
      <p className="text-xs text-zinc-600">
        {k.firstName} gets their own account: the same record, so every visit, badge, rating, note and photo stays. Rewards already earned stay on the household card.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {props.allow.phone && (
          <Field label="Their phone">
            <Input inputMode="tel" value={split.phone} onChange={(e) => setSplit({ ...split, phone: e.target.value })} />
          </Field>
        )}
        {props.allow.email && (
          <Field label="Their email">
            <Input type="email" value={split.email} onChange={(e) => setSplit({ ...split, email: e.target.value })} />
          </Field>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={split.smsOptIn} onChange={(e) => setSplit({ ...split, smsOptIn: e.target.checked })} />
        They agreed to appointment texts
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || (!split.phone.trim() && !split.email.trim())}
          onClick={() => run(() => splitChildAction(k.id, { phone: split.phone || undefined, email: split.email || undefined, smsOptIn: split.smsOptIn && !!split.phone }))}
        >
          Create their account
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setSplitting(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );

  if (props.parent && props.self) {
    const k = props.self;
    return (
      <Card data-testid="family-card">
        <CardHeader title="Family" subtitle="Reminders, receipts and marketing go to the parent, under the parent's consent." />
        <div className="space-y-2 p-4 text-sm">
          <div>
            Child on{" "}
            <Link className="font-medium underline" href={`/admin/customers/${props.parent.id}`}>
              {props.parent.name}
            </Link>
            &apos;s account{k.age != null ? `, age ${k.age}` : ""}.
            {props.settings.loyalty === "household" && " Visits count toward the household's loyalty card."}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {props.canEdit && editing !== k.id && splitting !== k.id && (
            <div className="flex flex-wrap gap-3 text-xs">
              <button
                className="underline"
                onClick={() => {
                  setDraft(draftOf(k));
                  setEditing(k.id);
                }}
              >
                Edit child details
              </button>
              {k.canSplit ? (
                <button className="underline" onClick={() => setSplitting(k.id)}>
                  Give them their own account
                </button>
              ) : (
                <span className="text-zinc-500">Own account from age {props.settings.splitAge}</span>
              )}
              <button
                className="text-zinc-500 underline hover:text-red-600"
                disabled={pending}
                onClick={() => confirm(`Take ${k.firstName} off ${props.parent!.name}'s account? Their history stays.`) && run(() => detachChildAction(k.id))}
              >
                Take off the account
              </button>
            </div>
          )}
          {editing === k.id && form(() => run(() => updateChildAction(k.id, input(draft))), "Save")}
          {splitting === k.id && splitForm(k)}
        </div>
      </Card>
    );
  }

  return (
    <Card data-testid="family-card">
      <CardHeader
        title={`Family${props.kids.length ? ` (${props.kids.length})` : ""}`}
        subtitle={`Up to ${props.settings.maxChildren} children. They have no login; everything goes to ${props.firstName}.`}
      />
      <div className="space-y-2 p-4 text-sm">
        {props.former && (
          <div className="text-xs text-zinc-500">
            Was on{" "}
            <Link className="underline" href={`/admin/customers/${props.former.id}`}>
              {props.former.name}
            </Link>
            &apos;s account{props.former.at ? ` until ${props.former.at}` : ""}.
          </div>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <ul className="divide-y divide-zinc-100">
          {props.kids.map((k) => (
            <li key={k.id} className="py-2" data-testid="family-kid">
              <div className="flex items-baseline justify-between gap-2">
                <Link className="font-medium underline" href={`/admin/customers/${k.id}`}>
                  {[k.firstName, k.lastName].filter(Boolean).join(" ")}
                  {k.age != null && <span className="font-normal text-zinc-500">, {k.age}</span>}
                </Link>
                <span className="text-xs text-zinc-500">
                  {k.visits} visit{k.visits === 1 ? "" : "s"}
                  {k.cadence && ` · ${k.cadence.toLowerCase()}`}
                </span>
              </div>
              {k.notes && <div className="text-xs text-zinc-600">{k.notes}</div>}
              {props.canEdit && editing !== k.id && splitting !== k.id && (
                <div className="mt-1 flex flex-wrap gap-3 text-xs">
                  <button
                    className="underline"
                    onClick={() => {
                      setDraft(draftOf(k));
                      setEditing(k.id);
                    }}
                  >
                    Edit
                  </button>
                  {k.canSplit && (
                    <button className="underline" onClick={() => setSplitting(k.id)}>
                      Own account
                    </button>
                  )}
                  <button
                    className="text-zinc-500 underline hover:text-red-600"
                    disabled={pending}
                    onClick={() => confirm(`Take ${k.firstName} off this account? Their history stays.`) && run(() => detachChildAction(k.id))}
                  >
                    Take off
                  </button>
                </div>
              )}
              {editing === k.id && <div className="mt-2">{form(() => run(() => updateChildAction(k.id, input(draft))), "Save")}</div>}
              {splitting === k.id && splitForm(k)}
            </li>
          ))}
        </ul>
        {props.canEdit &&
          (editing === "new" ? (
            form(() => run(() => addChildAction(props.customerId, input(draft))), "Add child")
          ) : (
            <div className="space-y-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={full}
                title={full ? `Up to ${props.settings.maxChildren} children` : undefined}
                onClick={() => {
                  setDraft(blank);
                  setEditing("new");
                }}
              >
                Add a child
              </Button>
              {!full && (
                <div>
                  <Input
                    placeholder="Or put an existing client on this account: search by name"
                    value={attachQ}
                    onChange={(e) => {
                      const q = e.target.value;
                      setAttachQ(q);
                      if (q.trim().length < 2) return setHits([]);
                      searchCustomersAction(q).then((r) => setHits(r.ok ? r.data.filter((h) => h.id !== props.customerId && !h.family?.guardian && !h.family?.kids.length).slice(0, 5) : []));
                    }}
                  />
                  {hits.length > 0 && (
                    <ul className="mt-1 divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200">
                      {hits.map((h) => (
                        <li key={h.id}>
                          <button
                            className="w-full px-2 py-1.5 text-left hover:bg-zinc-50"
                            disabled={pending}
                            onClick={() =>
                              confirm(`Put ${h.firstName} on ${props.firstName}'s account? Their visits stay theirs; their own phone, email and consent are cleared.`) &&
                              run(
                                () => attachChildAction(props.customerId, h.id),
                                () => {
                                  setAttachQ("");
                                  setHits([]);
                                },
                              )
                            }
                          >
                            <ClientHitRow hit={h} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>
    </Card>
  );
}
