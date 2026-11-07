"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { cx } from "@/components/ui";
import type { NavItem } from "@/domain/navigation";
import { switchShop } from "./actions";

const OPEN_KEY = "rayz-nav-open";

/** The sections arrive already filtered by the server, from the signed-in person's permissions. */
export function AdminNav({ sections }: { sections: { title: string; items: NavItem[] }[] }) {
  const path = usePathname();
  const matches = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  const best = sections.flatMap((s) => s.items.map((i) => i.href))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const active = (href: string) => href === best;
  const current = sections.find((s) => s.items.some((i) => i.href === best))?.title ?? null;
  const [remembered, setRemembered] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      if (raw) setRemembered(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* a bad saved value just leaves groups at their default */
    }
  }, []);
  const isOpen = (title: string) => title === current || remembered[title] === true;
  const toggle = (title: string) => {
    if (title === current) return;
    const next = { ...remembered, [title]: !isOpen(title) };
    setRemembered(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* private mode can refuse storage; the click still opens the group */
    }
  };
  return (
    <nav className="flex flex-col gap-0.5 px-2 pb-3 text-sm lg:flex-1 lg:overflow-y-auto lg:pb-4" aria-label="Admin">
      {sections.map((s) => {
        const open = isOpen(s.title);
        return (
          <div key={s.title}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(s.title)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              {s.title}
              <span aria-hidden>{open ? "–" : "+"}</span>
            </button>
            {open && (
              <div className="mb-1">
                {s.items.map((i) => (
                  <Link
                    key={i.href}
                    href={i.href}
                    className={cx(
                      "block rounded-md px-2.5 py-1.5",
                      active(i.href) ? "bg-white/10 font-medium text-white" : "hover:bg-white/5 hover:text-white",
                    )}
                  >
                    {i.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function ShopSwitcher({ shops, current, brandWide, combined }: { shops: { id: string; name: string }[]; current: string | null; brandWide: boolean; combined: boolean }) {
  const [pending, start] = useTransition();
  if (shops.length <= 1) return <div className="text-sm font-medium text-white">{shops[0]?.name ?? "No shop"}</div>;
  return (
    <select
      aria-label="Shop"
      value={current ?? "all"}
      disabled={pending}
      onChange={(e) => start(() => switchShop(e.target.value))}
      className="w-full rounded-md border-0 bg-white/10 py-1.5 pl-2 pr-7 text-sm font-medium text-white ring-1 ring-white/15 focus:ring-2 focus:ring-brand-600 [&>option]:text-zinc-900"
    >
      {combined && <option value="all">{brandWide ? "All shops (brand)" : `All my shops (${shops.length})`}</option>}
      {shops.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

/** Brand-wide staff looking at one shop can step back out to every shop. */
export function BackToBrand() {
  const [pending, start] = useTransition();
  return (
    <button className="text-[11px] text-zinc-400 underline hover:text-white disabled:opacity-50" disabled={pending} onClick={() => start(() => switchShop("all"))}>
      Back to all shops
    </button>
  );
}
