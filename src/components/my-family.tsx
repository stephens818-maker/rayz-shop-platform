"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BadgeGlyph } from "@/components/badge-icons";
import { Button, Field, Input } from "@/components/ui";
import type { BadgeIcon } from "@/domain/badges";
import type { CustomerBadge } from "@/domain/customer-badges";
import { cadenceLabel } from "@/domain/visit-cadence";
import { api, fmtDay, fmtTime, getTokens } from "@/lib/api-client";
import { shrinkPhoto } from "@/lib/shrink-photo";

interface Child {
  id: string;
  firstName: string;
  lastName: string | null;
  birthday: string | null;
  age: number | null;
  notes: string | null;
  preferredBarber: string | null;
  photo: string | null;
  visits: number;
  lastVisit: string | null;
  averageDaysBetween: number | null;
  upcoming: { id: string; startsAt: string; shop: string; barber: string; service: string }[];
  badges: CustomerBadge[];
  canSplit: boolean;
}
interface Family {
  settings: { maxChildren: number; loyalty: "household" | "individual"; splitAge: number };
  children: Child[];
}
type Group = { code: string; startsAt: string; endsAt: string; status: string; shop: { name: string }; members: { firstName: string | null; status: string }[] };
type Draft = { firstName: string; lastName: string; birthday: string; age: string; notes: string; photo: string | null | undefined };

const BASE = { base: "/api" } as const;
const empty: Draft = { firstName: "", lastName: "", birthday: "", age: "", notes: "", photo: undefined };
const draftOf = (c: Child): Draft => ({ firstName: c.firstName, lastName: c.lastName ?? "", birthday: c.birthday ?? "", age: c.age != null && !c.birthday ? String(c.age) : "", notes: c.notes ?? "", photo: undefined });
const bodyOf = (d: Draft) =>
  JSON.stringify({
    firstName: d.firstName,
    lastName: d.lastName,
    birthday: d.birthday,
    ...(d.birthday ? {} : { age: d.age.trim() ? Number(d.age) : null }),
    notes: d.notes,
    ...(d.photo !== undefined ? { photo: d.photo } : {}),
  });

/**
 * The parent's children: each one's visits, rhythm, badges and upcoming cuts, and adding, editing,
 * removing or (from the brand's age) giving them their own account. Children have no sign-in.
 */
export function MyFamily({ parentName }: { parentName: string }) {
  const [family, setFamily] = useState<Family | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [split, setSplit] = useState({ phone: "", email: "", smsOptIn: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);

  const load = () =>
    Promise.all([
      api<Family>("/account/family", BASE)
        .then(setFamily)
        .catch(() => setFamily(null)),
      api<{ groups: Group[] }>("/account/family/booking-groups", BASE)
        .then((r) => setGroups(r.groups))
        .catch(() => setGroups([])),
    ]);
  useEffect(() => {
    if (getTokens()) load();
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      setEditing(null);
      setSplitting(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!family) return null;
  const full = family.children.length >= family.settings.maxChildren;
  const save = () =>
    act(() =>
      editing === "new" ? api("/account/family/children", { ...BASE, method: "POST", body: bodyOf(draft) }) : api(`/account/family/children/${editing}`, { ...BASE, method: "PATCH", body: bodyOf(draft) }),
    );

  const form = (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3" data-testid="child-form">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="First name">
          <Input value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
        </Field>
        <Field label="Last name" hint="Optional">
          <Input value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
        </Field>
        <Field label="Birthday">
          <Input type="date" value={draft.birthday} onChange={(e) => setDraft({ ...draft, birthday: e.target.value })} />
        </Field>
        <Field label="Or age">
          <Input inputMode="numeric" disabled={!!draft.birthday} value={draft.age} onChange={(e) => setDraft({ ...draft, age: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
        </Field>
      </div>
      <Field label="Notes for the barber" hint="Sensory needs, how they like their hair, anything that helps">
        <textarea className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm" rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
      </Field>
      <Field label="Photo" hint="Optional">
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setDraft({ ...draft, photo: await shrinkPhoto(f) });
          }}
        />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !draft.firstName.trim()} onClick={save}>
          {editing === "new" ? "Add child" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="my-family">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">My family</div>
          <div className="text-xs text-zinc-500">
            Reminders and receipts for your children come to you
            {family.settings.loyalty === "household" ? ", and their visits count toward your rewards." : "."}
          </div>
        </div>
        {family.children.length > 0 && (
          <Link href="/book" className="shrink-0 text-sm font-medium text-brand-600 underline">
            Book for the family
          </Link>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {groups.length > 0 && (
        <ul className="space-y-1.5" data-testid="family-groups">
          {groups.map((g) => (
            <li key={g.code}>
              <Link href={`/g/${g.code}`} className="flex items-center justify-between gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm ring-1 ring-sky-200 hover:bg-sky-100">
                <span>
                  <span className="font-medium">
                    {fmtDay(g.startsAt)}, {fmtTime(g.startsAt)} – {fmtTime(g.endsAt)}
                  </span>{" "}
                  <span className="text-zinc-600">
                    at {g.shop.name}:{" "}
                    {g.members
                      .filter((m) => m.status !== "cancelled")
                      .map((m) => m.firstName ?? "Guest")
                      .join(", ")}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium underline">Manage</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <ul className="space-y-3">
        {family.children.map((c) => (
          <li key={c.id} className="rounded-lg p-3 ring-1 ring-zinc-200" data-testid="family-child">
            <div className="flex items-start gap-3">
              {c.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.photo} alt="" className="size-12 rounded-full object-cover" />
              ) : (
                <span className="flex size-12 items-center justify-center rounded-full bg-violet-100 text-lg font-semibold text-violet-700">{c.firstName[0]}</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-semibold">
                  {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                  {c.age != null && <span className="font-normal text-zinc-500">, {c.age}</span>}
                </div>
                <div className="text-xs text-zinc-500">
                  {c.visits} visit{c.visits === 1 ? "" : "s"}
                  {c.lastVisit && ` · last ${fmtDay(c.lastVisit, { month: "short", day: "numeric" })}`}
                  {c.averageDaysBetween != null && ` · ${cadenceLabel(c.averageDaysBetween).toLowerCase()}`}
                  {c.preferredBarber && ` · usually with ${c.preferredBarber}`}
                </div>
                {c.notes && <div className="mt-1 text-sm text-zinc-700">{c.notes}</div>}
                {c.badges.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.badges.map((b) => (
                      <span key={b.id} title={b.text} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ color: b.color, backgroundColor: `${b.color}14` }}>
                        <BadgeGlyph icon={b.icon as BadgeIcon} className="size-3.5" />
                        {b.name}
                      </span>
                    ))}
                  </div>
                )}
                {c.upcoming.map((u) => (
                  <div key={u.id} className="mt-1 text-xs text-zinc-600">
                    Next: {fmtDay(u.startsAt)} {fmtTime(u.startsAt)} · {u.service} with {u.barber} at {u.shop}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              <button
                className="underline"
                onClick={() => {
                  setDraft(draftOf(c));
                  setEditing(c.id);
                }}
              >
                Edit
              </button>
              {c.canSplit && (
                <button className="underline" onClick={() => setSplitting(c.id)}>
                  Give {c.firstName} their own account
                </button>
              )}
              <button
                className="text-zinc-500 underline hover:text-red-600"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Take ${c.firstName} off your account? Their visit history stays with the shop.`)) act(() => api(`/account/family/children/${c.id}/remove`, { ...BASE, method: "POST" }));
                }}
              >
                Remove
              </button>
            </div>
            {editing === c.id && <div className="mt-2">{form}</div>}
            {splitting === c.id && (
              <div className="mt-2 space-y-2 rounded-lg bg-zinc-50 p-3">
                <p className="text-xs text-zinc-600">
                  {c.firstName} signs in with their own phone or email from now on. Every visit, badge and note stays with them; rewards already earned stay with {parentName}.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Their phone">
                    <Input inputMode="tel" value={split.phone} onChange={(e) => setSplit({ ...split, phone: e.target.value })} />
                  </Field>
                  <Field label="Or their email">
                    <Input type="email" value={split.email} onChange={(e) => setSplit({ ...split, email: e.target.value })} />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={split.smsOptIn} onChange={(e) => setSplit({ ...split, smsOptIn: e.target.checked })} />
                  Text {c.firstName} appointment reminders
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || (!split.phone.trim() && !split.email.trim())}
                    onClick={() =>
                      act(() =>
                        api(`/account/family/children/${c.id}/split`, {
                          ...BASE,
                          method: "POST",
                          body: JSON.stringify({ phone: split.phone || undefined, email: split.email || undefined, smsOptIn: split.smsOptIn && !!split.phone, emailOptIn: false }),
                        }),
                      )
                    }
                  >
                    Create their account
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSplitting(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing === "new" ? (
        form
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={full}
          title={full ? `Up to ${family.settings.maxChildren} children` : undefined}
          onClick={() => {
            setDraft(empty);
            setEditing("new");
          }}
        >
          Add a child
        </Button>
      )}
    </section>
  );
}
