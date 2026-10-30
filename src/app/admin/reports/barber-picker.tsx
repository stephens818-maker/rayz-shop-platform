"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";

/** `here`: works at one of the selected shops. */
type Barber = { id: string; name: string; active: boolean; here: boolean };
type Group = { id: string; name: string; staffIds: string[] };

/**
 * One barber, any set of barbers, a saved group, or all of them. Writes the canonical `staff` value
 * into a hidden input, so the surrounding GET form carries it.
 */
export function BarberPicker({ barbers, groups, value, selected }: { barbers: Barber[]; groups: Group[]; value: string | null; selected: string[] }) {
  const [mode, setMode] = useState<string>(!value ? "all" : value.startsWith("group:") ? value : "custom");
  const [checked, setChecked] = useState<string[]>(selected);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const ordered = barbers.filter((b) => checked.includes(b.id)).map((b) => b.id);
  const param = mode === "custom" ? (ordered.length ? ordered.join(",") : "all") : mode;
  const group = mode.startsWith("group:") ? groups.find((g) => `group:${g.id}` === mode) : null;
  const name = (id: string) => barbers.find((b) => b.id === id)?.name ?? "";
  const label =
    mode === "all" || (mode === "custom" && ordered.length === 0)
      ? "All barbers"
      : group
        ? `${group.name} (${group.staffIds.length})`
        : ordered.length <= 2
          ? ordered.map(name).join(", ")
          : `${ordered.length} barbers`;
  const toggle = (id: string) => {
    setMode("custom");
    setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };
  const match = (b: Barber) => !q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase());
  const sections: [string, Barber[]][] = [
    ["At these shops", barbers.filter((b) => b.active && b.here)],
    ["At your other shops", barbers.filter((b) => b.active && !b.here)],
    ["Former barbers", barbers.filter((b) => !b.active)],
  ];

  return (
    <div className="relative" ref={box}>
      <span className="block text-xs text-zinc-500">Barbers</span>
      <input type="hidden" name="staff" value={param} />
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
        <div role="dialog" aria-label="Choose barbers" className="absolute z-20 mt-1 w-72 rounded-lg bg-white p-2 text-sm shadow-lg ring-1 ring-zinc-200">
          <label className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50">
            <input
              type="radio"
              name="_staff_mode"
              checked={mode === "all"}
              onChange={() => {
                setMode("all");
                setChecked([]);
              }}
            />
            <span className="font-medium">All barbers</span>
          </label>
          {groups.length > 0 && (
            <div className="mt-1 border-t border-zinc-100 pt-1">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Saved groups</div>
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50">
                  <input
                    type="radio"
                    name="_staff_mode"
                    checked={mode === `group:${g.id}`}
                    onChange={() => {
                      setMode(`group:${g.id}`);
                      setChecked(g.staffIds);
                    }}
                  />
                  <span>{g.name}</span>
                  <span className="ml-auto text-xs text-zinc-400">{g.staffIds.length} barbers</span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-1 border-t border-zinc-100 pt-1">
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              <span>Pick barbers</span>
              <span className="flex gap-2 normal-case">
                <button type="button" className="underline" onClick={() => (setMode("custom"), setChecked(barbers.filter((b) => b.active && b.here).map((b) => b.id)))}>
                  Everyone here
                </button>
                <button type="button" className="underline" onClick={() => (setMode("custom"), setChecked([]))}>
                  None
                </button>
              </span>
            </div>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a barber"
              aria-label="Find a barber"
              className="mx-2 mb-1 h-8 w-[calc(100%-1rem)] rounded-md px-2 ring-1 ring-zinc-200"
            />
            <div className="max-h-64 overflow-y-auto">
              {sections.map(([title, list]) =>
                list.filter(match).length ? (
                  <div key={title}>
                    <div className="px-2 pb-0.5 pt-1.5 text-[11px] text-zinc-400">{title}</div>
                    {list.filter(match).map((b) => (
                      <label key={b.id} className={cx("flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50", mode !== "custom" && "text-zinc-500")}>
                        <input type="checkbox" checked={checked.includes(b.id)} onChange={() => toggle(b.id)} />
                        <span>{b.name}</span>
                      </label>
                    ))}
                  </div>
                ) : null,
              )}
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
