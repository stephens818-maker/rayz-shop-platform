"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";

type Shop = { id: string; name: string };
type Group = { id: string; name: string; shopIds: string[] };

/**
 * One shop, any set of shops, a saved group, or all of them. Writes the canonical `shop` value into
 * a hidden input, so the surrounding GET form carries it.
 */
export function LocationPicker({ shops, groups, value, selected, allLabel }: { shops: Shop[]; groups: Group[]; value: string | null; selected: string[]; allLabel: string }) {
  const [mode, setMode] = useState<string>(value === "all" || value?.startsWith("group:") ? value : "custom");
  const [checked, setChecked] = useState<string[]>(selected);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const ordered = shops.filter((s) => checked.includes(s.id)).map((s) => s.id);
  const param = mode === "custom" ? ordered.join(",") : mode;
  const group = mode.startsWith("group:") ? groups.find((g) => `group:${g.id}` === mode) : null;
  const label =
    mode === "all"
      ? allLabel
      : group
        ? `${group.name} (${group.shopIds.length})`
        : ordered.length === 1
          ? shops.find((s) => s.id === ordered[0])?.name
          : ordered.length === shops.length
            ? allLabel
            : ordered.length === 0
              ? "Pick shops"
              : `${ordered.length} shops`;
  const toggle = (id: string) => {
    setMode("custom");
    setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };
  const pickGroup = (g: Group) => {
    setMode(`group:${g.id}`);
    setChecked(g.shopIds);
  };

  return (
    <div className="relative" ref={box}>
      <span className="block text-xs text-zinc-500">Locations</span>
      <input type="hidden" name="shop" value={param} />
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-44 items-center justify-between gap-2 rounded-lg bg-white px-2 text-left ring-1 ring-zinc-300"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-zinc-400">
          ▾
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Choose locations" className="absolute z-20 mt-1 w-72 rounded-lg bg-white p-2 text-sm shadow-lg ring-1 ring-zinc-200">
          <label className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50">
            <input
              type="radio"
              name="_loc_mode"
              checked={mode === "all"}
              onChange={() => {
                setMode("all");
                setChecked(shops.map((s) => s.id));
              }}
            />
            <span className="font-medium">{allLabel}</span>
          </label>
          {groups.length > 0 && (
            <div className="mt-1 border-t border-zinc-100 pt-1">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Saved groups</div>
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50">
                  <input type="radio" name="_loc_mode" checked={mode === `group:${g.id}`} onChange={() => pickGroup(g)} />
                  <span>{g.name}</span>
                  <span className="ml-auto text-xs text-zinc-400">{g.shopIds.length} shops</span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-1 border-t border-zinc-100 pt-1">
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              <span>Pick shops</span>
              <span className="flex gap-2 normal-case">
                <button type="button" className="underline" onClick={() => (setMode("custom"), setChecked(shops.map((s) => s.id)))}>
                  All
                </button>
                <button type="button" className="underline" onClick={() => (setMode("custom"), setChecked([]))}>
                  None
                </button>
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {shops.map((s) => (
                <label key={s.id} className={cx("flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50", mode !== "custom" && "text-zinc-500")}>
                  <input type="checkbox" checked={checked.includes(s.id)} onChange={() => toggle(s.id)} />
                  <span>{s.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="mt-2 flex justify-end border-t border-zinc-100 pt-2">
            <button type="button" className="rounded-md px-2 py-1 text-xs ring-1 ring-zinc-300" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
