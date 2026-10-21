"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, cx } from "@/components/ui";
import { deleteLocationGroupAction, saveLocationGroupAction } from "./actions";

type Shop = { id: string; name: string; state: string };

/** Create or edit one group: a name and two or more shops. */
export function GroupEditor({ shops, group, onDone }: { shops: Shop[]; group: { id: string; name: string; shopIds: string[] } | null; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(group?.name ?? "");
  const [picked, setPicked] = useState<string[]>(group?.shopIds ?? []);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const states = [...new Set(shops.map((s) => s.state))].sort();
  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveLocationGroupAction(group?.id ?? null, { name, shopIds: picked });
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
        <Input value={name} maxLength={60} placeholder="e.g. Quad Cities" onChange={(e) => setName(e.target.value)} />
      </Field>
      <div>
        <div className="mb-1 flex items-center gap-3 text-xs text-zinc-500">
          <span>Shops ({picked.length})</span>
          {states.map((st) => (
            <button key={st} type="button" className="underline" onClick={() => setPicked(shops.filter((s) => s.state === st).map((s) => s.id))}>
              All in {st}
            </button>
          ))}
          <button type="button" className="underline" onClick={() => setPicked([])}>
            Clear
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {shops.map((s) => (
            <label key={s.id} className={cx("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ring-1", picked.includes(s.id) ? "bg-zinc-50 ring-zinc-400" : "ring-zinc-200")}>
              <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
              {s.name}
              <span className="ml-auto text-xs text-zinc-400">{s.state}</span>
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
export function GroupItem({ shops, group, editable }: { shops: Shop[]; group: { id: string; name: string; shopIds: string[] }; editable: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const names = shops.filter((s) => group.shopIds.includes(s.id)).map((s) => s.name);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium">{group.name}</div>
          <div className="text-sm text-zinc-600">{names.join(", ")}</div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <a className="underline" href={`/admin/reports/sales?shop=group:${group.id}&view=shops`}>
            Sales by location
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
                    const r = await deleteLocationGroupAction(group.id);
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
          <GroupEditor shops={shops} group={group} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}
