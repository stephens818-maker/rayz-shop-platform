"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { cx } from "@/components/ui";
import type { NavItem } from "@/domain/navigation";
import { switchShop } from "./actions";

/** The sections arrive already filtered by the server, from the signed-in person's permissions. */
export function AdminNav({ sections }: { sections: { title: string; items: NavItem[] }[] }) {
  const path = usePathname();
  const matches = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  const best = sections.flatMap((s) => s.items.map((i) => i.href))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const active = (href: string) => href === best;
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 text-sm lg:block lg:flex-1 lg:overflow-y-auto lg:pb-4">
      {sections.map((s) => {
        const items = s.items;
        return (
          <div key={s.title} className="flex gap-1 lg:mb-4 lg:block">
            <div className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 lg:block">{s.title}</div>
            {items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                className={cx(
                  "block shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5",
                  active(i.href) ? "bg-white/10 font-medium text-white" : "hover:bg-white/5 hover:text-white",
                )}
              >
                {i.label}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

export function ShopSwitcher({ shops, current, brandWide }: { shops: { id: string; name: string }[]; current: string | null; brandWide: boolean }) {
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
      <option value="all">{brandWide ? "All shops (brand)" : `All my shops (${shops.length})`}</option>
      {shops.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
