"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { cx } from "@/components/ui";
import { switchShop } from "./actions";

type Role = "brand_admin" | "shop_manager" | "barber";
const ALL: Role[] = ["brand_admin", "shop_manager", "barber"];
const MGR: Role[] = ["brand_admin", "shop_manager"];

const SECTIONS: { title: string; items: { href: string; label: string; roles: Role[] }[] }[] = [
  {
    title: "Front desk",
    items: [
      { href: "/admin", label: "Today", roles: ALL },
      { href: "/admin/calendar", label: "Calendar", roles: ALL },
      { href: "/admin/walk-ins", label: "Walk-ins & waitlist", roles: MGR },
      { href: "/admin/sales", label: "Sales & checkout", roles: MGR },
      { href: "/admin/drawer", label: "Cash drawer", roles: MGR },
      { href: "/admin/customers", label: "Clients", roles: ALL },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/admin/reports", label: "Reports", roles: ALL },
      { href: "/admin/reports/ratings", label: "Client ratings", roles: MGR },
      { href: "/admin/payroll", label: "Payroll tips", roles: MGR },
    ],
  },
  {
    title: "Setup",
    items: [
      { href: "/admin/staff", label: "Staff & schedules", roles: MGR },
      { href: "/admin/services", label: "Services", roles: MGR },
      { href: "/admin/inventory", label: "Inventory", roles: MGR },
      { href: "/admin/promos", label: "Promos & gift cards", roles: MGR },
      { href: "/admin/settings", label: "Shop settings", roles: MGR },
      { href: "/admin/import", label: "Squire import", roles: ["brand_admin"] },
      { href: "/admin/notifications", label: "Notifications", roles: MGR },
      { href: "/admin/audit", label: "Audit log", roles: MGR },
    ],
  },
];

export function AdminNav({ role }: { role: Role }) {
  const path = usePathname();
  const matches = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  const best = SECTIONS.flatMap((s) => s.items.map((i) => i.href))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const active = (href: string) => href === best;
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 text-sm lg:block lg:flex-1 lg:overflow-y-auto lg:pb-4">
      {SECTIONS.map((s) => {
        const items = s.items.filter((i) => i.roles.includes(role));
        if (!items.length) return null;
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

export function ShopSwitcher({ shops, current, isAdmin }: { shops: { id: string; name: string }[]; current: string | null; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  if (shops.length <= 1 && !isAdmin) return <div className="text-sm font-medium text-white">{shops[0]?.name ?? "No shop"}</div>;
  return (
    <select
      aria-label="Shop"
      value={current ?? "all"}
      disabled={pending}
      onChange={(e) => start(() => switchShop(e.target.value))}
      className="w-full rounded-md border-0 bg-white/10 py-1.5 pl-2 pr-7 text-sm font-medium text-white ring-1 ring-white/15 focus:ring-2 focus:ring-brand-600 [&>option]:text-zinc-900"
    >
      {isAdmin && <option value="all">All shops (brand)</option>}
      {shops.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
