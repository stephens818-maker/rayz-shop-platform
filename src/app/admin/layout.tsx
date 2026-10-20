import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/ui";
import { requireStaff } from "@/server/auth/staff";
import { logout } from "../login/actions";
import { AdminNav, ShopSwitcher } from "./nav";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Ray'z Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaff();
  const role = ctx.staff.role;
  return (
    <div className="min-h-dvh bg-zinc-50 lg:flex">
      <aside className="no-print bg-ink-900 text-zinc-300 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 lg:block lg:py-4">
          <Link href="/admin">
            <Logo dark />
          </Link>
          <div className="lg:mt-4">
            <ShopSwitcher shops={ctx.shops} current={ctx.currentShopId} isAdmin={ctx.isAdmin} />
          </div>
        </div>
        <AdminNav role={role} />
        <div className="hidden border-t border-white/10 px-4 py-3 text-xs lg:block">
          <div className="font-medium text-white">{ctx.staff.displayLabel}</div>
          <div className="text-zinc-400">{role === "brand_admin" ? "Brand admin" : role === "shop_manager" ? "Shop manager" : "Barber"}</div>
          <form action={logout} className="mt-2">
            <button className="text-zinc-400 underline hover:text-white">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-3 py-4 sm:px-6 sm:py-6">{children}</main>
    </div>
  );
}
