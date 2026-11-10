"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, cx } from "@/components/ui";
import { deleteBarberGroupAction, saveBarberGroupAction } from "./actions";

/** `shops`: names of the shops they work at. */
type Barber = { id: string; name: string; shops: string[]; active: boolean };
type Group = { id: string; name: string; staffIds: string[] };

/** Create or edit one group: a name and two or more barbers, from any shops. */
export function BarberGroupEditor({ barbers, shops, group, onDone }: { barbers: Barber[]; shops: string[]; group: Group | null; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(group?.name ?? "");
  const [picked, setPicked] = useState<string[]>(group?.staffIds ?? []);
  const [q, setQ] = useState("");
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const add = (ids: string[]) => setPicked((p) => [...new Set([...p, ...ids])]);
  const shown = barbers.filter((b) => (b.active || picked.includes(b.id)) && (!q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase())));
  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveBarberGroupAction(group?.id ?? null, { name, staffIds: picked });
      if (!r.ok) return setError(r.error);
      if (!group) {
        setName("");
        setPicked([]);
      }
      onDone?.();
      router.refresh();
    });
  return (
    <div className="space-y-3">
      <Field label="Name">
        <Input value={name} maxLength={60} placeholder="e.g. Senior barbers" onChange={(e) => setName(e.target.value)} />
      </Field>
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          <span>Barbers ({picked.length})</span>
          <button type="button" className="underline" onClick={() => add(barbers.filter((b) => b.active && b.shops.length > 1).map((b) => b.id))}>
            Add everyone at 2+ shops
          </button>
          <select
            aria-label="Add everyone at a shop"
            className="h-7 rounded-md px-1 ring-1 ring-zinc-200"
            value=""
            onChange={(e) => e.target.value && add(barbers.filter((b) => b.active && b.shops.includes(e.target.value)).map((b) => b.id))}
          >
            <option value="">Add everyone at…</option>
            {shops.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button type="button" className="underline" onClick={() => setPicked([])}>
            Clear
          </button>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a barber" aria-label="Find a barber" className="ml-auto h-7 rounded-md px-2 ring-1 ring-zinc-200" />
        </div>
        <div className="grid max-h-80 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((b) => (
            <label key={b.id} className={cx("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ring-1", picked.includes(b.id) ? "bg-zinc-50 ring-zinc-400" : "ring-zinc-200")}>
              <input type="checkbox" checked={picked.includes(b.id)} onChange={() => toggle(b.id)} />
              <span>{b.name}</span>
              <span className="ml-auto truncate text-xs text-zinc-400">{b.active ? b.shops.join(", ") : "former"}</span>
            </label>
          ))}
        </div>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          {group ? "Save changes" : "Create group"}
        </Button>
        {onDone && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/** One saved group in the list, with edit and delete for people who can change groups. */
export function BarberGroupItem({ barbers, shops, group, editable }: { barbers: Barber[]; shops: string[]; group: Group; editable: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const names = group.staffIds.map((id) => barbers.find((b) => b.id === id)?.name ?? "Unknown");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium">{group.name}</div>
          <div className="text-sm text-zinc-600">{names.join(", ")}</div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <a className="underline" href={`/admin/reports/barbers?shop=all&staff=group:${group.id}&view=shops_barbers`}>
            Barber performance
          </a>
          {editable && !editing && (
            <>
              <button className="underline" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                className="text-red-700 underline"
                disabled={pending}
                onClick={() => {
                  if (!confirm(`Delete "${group.name}"? Saved report links that use it will stop working.`)) return;
                  start(async () => {
                    const r = await deleteBarberGroupAction(group.id);
                    if (!r.ok) setError(r.error);
                    else router.refresh();
                  });
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-2">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
      {editing && (
        <div className="mt-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
          <BarberGroupEditor barbers={barbers} shops={shops} group={group} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}
