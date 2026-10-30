"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader } from "@/components/ui";

type Result = { ok: true } | { ok: false; error: string };

/** Drag-free category ordering: move a category up or down, then save. The booking site and checkout follow this order. */
export function CategoryOrder({
  title,
  subtitle,
  initial,
  onSave,
}: {
  title: string;
  subtitle: string;
  initial: { name: string; count: number }[];
  onSave: (names: string[]) => Promise<Result | { ok: true; data: unknown }>;
}) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = list.map((c) => c.name).join("|") !== initial.map((c) => c.name).join("|");
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
    setMsg(null);
  };
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <ol className="divide-y divide-zinc-100" data-testid="category-order">
        {list.map((c, i) => (
          <li key={c.name} className="flex items-center gap-2 px-4 py-1.5 text-sm">
            <span className="w-6 text-right text-xs text-zinc-400">{i + 1}</span>
            <span className="flex-1 font-medium">{c.name}</span>
            <span className="text-xs text-zinc-500">{c.count}</span>
            <button type="button" className="rounded px-2 py-0.5 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:opacity-30" disabled={i === 0} aria-label={`Move ${c.name} up`} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button
              type="button"
              className="rounded px-2 py-0.5 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:opacity-30"
              disabled={i === list.length - 1}
              aria-label={`Move ${c.name} down`}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-2">
        <Button
          size="sm"
          variant="dark"
          disabled={!dirty || pending}
          onClick={() =>
            start(async () => {
              const r = await onSave(list.map((c) => c.name));
              if (!r.ok) return setMsg({ ok: false, text: r.error });
              setMsg({ ok: true, text: "Saved" });
              router.refresh();
            })
          }
        >
          Save order
        </Button>
        {msg && <span className={msg.ok ? "text-xs text-green-700" : "text-xs text-red-600"}>{msg.text}</span>}
      </div>
    </Card>
  );
}
