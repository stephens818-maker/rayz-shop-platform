"use client";

import { useState } from "react";
import { Input, cx } from "@/components/ui";

type Option = { id: string; name: string };

/** Toggle buttons for a short list. */
export function Chips({ options, selected, onToggle, disabled }: { options: Option[]; selected: string[]; onToggle: (id: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={disabled}
          aria-pressed={selected.includes(o.id)}
          onClick={() => onToggle(o.id)}
          className={cx("rounded-full px-2.5 py-1 text-xs ring-1 disabled:cursor-not-allowed", selected.includes(o.id) ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-300 hover:ring-zinc-500")}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

/** Search-and-add for a long list. */
export function ItemPicker({ options, selected, onChange, disabled, placeholder = "Search" }: { options: Option[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; placeholder?: string }) {
  const [q, setQ] = useState("");
  const hits = q.trim() ? options.filter((o) => !selected.includes(o.id) && o.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <button key={id} type="button" disabled={disabled} onClick={() => onChange(selected.filter((x) => x !== id))} className="rounded-full bg-zinc-900 px-2.5 py-1 text-xs text-white">
              {options.find((o) => o.id === id)?.name ?? "Removed item"} ×
            </button>
          ))}
        </div>
      )}
      {!disabled && (
        <>
          <Input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {hits.map((o) => (
                <button key={o.id} type="button" onClick={() => (onChange([...selected, o.id]), setQ(""))} className="rounded-full px-2.5 py-1 text-xs ring-1 ring-zinc-300 hover:ring-zinc-500">
                  + {o.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const toggle = <T,>(list: readonly T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
