import type { Metadata } from "next";
import Link from "next/link";
import { MilestoneToasts } from "@/components/celebration";
import { Logo } from "@/components/ui";
import { navFor } from "@/domain/navigation";
import { assistantAccess } from "@/server/assistant";
import { requireStaff } from "@/server/auth/staff";
import { milestoneSettingsAt } from "@/server/milestones/engine";
import { logout } from "../login/actions";
import { AssistantPanel } from "./assistant/panel";
import { BfcacheGuard } from "./bfcache-guard";
import { ClientQuickSearch } from "./client-quick-search";
import { AdminNav, BackToBrand, ShopSwitcher } from "./nav";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Ray'z Admin" },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireStaff();
  const [assistant, milestones] = await Promise.all([
    assistantAccess(ctx),
    milestoneSettingsAt(ctx.currentShopId ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null)),
  ]);
  const here = ctx.shops.find((s) => s.id === ctx.currentShopId) ?? null;
  const address = here
    ? [here.address, here.city].filter(Boolean).join(", ")
    : "";
  return (
    <div className="min-h-dvh bg-zinc-50 lg:flex">
      <BfcacheGuard />
      <aside className="no-print bg-ink-900 text-zinc-300 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 lg:block lg:py-4">
          <Link href="/admin">
            <Logo dark />
          </Link>
          <div className="min-w-0 lg:mt-4" data-testid="workspace">
            <div className="hidden text-[11px] font-semibold uppercase tracking-wider text-zinc-500 lg:block">
              {ctx.brandWide
                ? here
                  ? "Brand · viewing one shop"
                  : "Brand · every shop"
                : ctx.assignedShops.length > 1
                  ? "Your shops"
                  : "Shop workspace"}
            </div>
            <div className="lg:mt-1">
              <ShopSwitcher
                shops={ctx.assignedShops}
                current={ctx.currentShopId}
                brandWide={ctx.brandWide}
                combined={ctx.combinedView}
              />
            </div>
            {here && address && (
              <div className="mt-1 hidden truncate text-xs text-zinc-400 lg:block">
                {address}
              </div>
            )}
            {ctx.brandWide && here && ctx.assignedShops.length > 1 && (
              <div className="mt-1 hidden lg:block">
                <BackToBrand />
              </div>
            )}
          </div>
        </div>
        {ctx.staff.kind !== "shop" && <ClientQuickSearch />}
        <AdminNav sections={navFor(ctx.permissions)} />
        <div className="hidden border-t border-white/10 px-4 py-3 text-xs lg:block">
          <div className="font-medium text-white">{ctx.staff.displayLabel}</div>
          <div className="text-zinc-400">
            {ctx.staff.kind === "shop"
              ? `${ctx.staff.roleName} · shared shop login`
              : ctx.staff.roleName}
          </div>
          <form action={logout} className="mt-2">
            <button className="text-zinc-400 underline hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-3 py-4 sm:px-6 sm:py-6">
        {children}
      </main>
      {milestones.enabled && milestones.liveToast && (
        <MilestoneToasts since={new Date().toISOString()} />
      )}
      {assistant.on && (
        <AssistantPanel
          firstName={
            ctx.staff.kind === "shop"
              ? ctx.staff.displayLabel
              : ctx.staff.firstName
          }
        />
      )}
    </div>
  );
}
