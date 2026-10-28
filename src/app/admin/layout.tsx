import type { Metadata } from "next";
import Link from "next/link";
import { MilestoneToasts } from "@/components/celebration";
import { ThemeController, ThemeSwitch } from "@/components/theme";
import { Toaster } from "@/components/toast";
import { Logo } from "@/components/ui";
import { frontDeskMore, frontDeskTabs } from "@/domain/front-desk";
import { STRIPE_PAYOUT_PAGES, navFor, reportsFor } from "@/domain/navigation";
import { flags } from "@/lib/flags";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { groupReports } from "@/domain/report-groups";
import { GO_TO } from "@/domain/shortcuts";
import { THEME_SCRIPT } from "@/domain/theme";
import { assistantAccess } from "@/server/assistant";
import { requireStaff } from "@/server/auth/staff";
import { stepUpFactor } from "@/server/auth/sign-in-guard";
import { milestoneSettingsAt } from "@/server/milestones/engine";
import { logout } from "../login/actions";
import { AssistantPanel } from "./assistant/panel";
import { BfcacheGuard } from "./bfcache-guard";
import { StepUpHost } from "./step-up";
import { ClientQuickSearch } from "./client-quick-search";
import { CommandPalette, CommandPaletteButton } from "./command-palette";
import { FrontDeskBar } from "./front-desk-bar";
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
  const [assistant, milestones, factor] = await Promise.all([
    assistantAccess(ctx),
    milestoneSettingsAt(ctx.currentShopId ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null)),
    stepUpFactor(ctx.staff.id),
  ]);
  const here = ctx.shops.find((s) => s.id === ctx.currentShopId) ?? null;
  const address = here
    ? [here.address, here.city].filter(Boolean).join(", ")
    : "";
  const sections = navFor(ctx.permissions, { hide: stripePayoutsOn() && flags.tipToBarber() ? [] : STRIPE_PAYOUT_PAGES });
  const hrefs = new Set(sections.flatMap((s) => s.items.map((i) => i.href)));
  const reports = groupReports(reportsFor(ctx.permissions)).flatMap((g) => g.reports.map((r) => ({ label: r.label, href: r.href, group: g.label })));
  const extras = (
    <>
      <Toaster />
      <StepUpHost factor={factor} />
      {milestones.enabled && milestones.liveToast && <MilestoneToasts since={new Date().toISOString()} />}
      {assistant.on && <AssistantPanel firstName={ctx.staff.kind === "shop" ? ctx.staff.displayLabel : ctx.staff.firstName} />}
    </>
  );
  if (ctx.staff.kind === "shop") {
    const tabs = frontDeskTabs(ctx.permissions).map(({ href, label }) => ({ href, label }));
    return (
      <div className="touch-ui min-h-dvh bg-zinc-50 text-zinc-900" data-testid="front-desk-shell">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <ThemeController />
        <a href="#main" className="sr-only z-[70] rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>
        <BfcacheGuard />
        <header className="theme-fixed no-print sticky top-0 z-40 bg-ink-900 text-zinc-300">
          <div className="flex items-center gap-3 px-3 py-2">
            <Link href="/admin" className="hidden shrink-0 sm:block" aria-label="Front desk">
              <Logo dark />
            </Link>
            <div className="shrink-0 leading-tight" data-testid="workspace">
              <div className="text-base font-semibold text-white">{here?.name ?? ctx.assignedShops[0]?.name ?? "Shop"}</div>
              <div className="text-xs text-zinc-400">{ctx.staff.displayLabel}</div>
            </div>
            <FrontDeskBar tabs={tabs} more={frontDeskMore(sections)} />
            <form action={logout} className="shrink-0">
              <button className="h-12 rounded-xl px-4 text-base text-zinc-300 ring-1 ring-white/15 hover:bg-white/10 hover:text-white">Sign out</button>
            </form>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 px-3 py-4 focus:outline-none sm:px-5">
          {children}
        </main>
        {extras}
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900 lg:flex">
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <ThemeController />
      <a href="#main" className="sr-only z-[70] rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <BfcacheGuard />
      <aside className="theme-fixed no-print bg-ink-900 text-zinc-300 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 lg:block lg:py-4">
          <Link href="/admin">
            <Logo dark />
          </Link>
          <div className="min-w-0 lg:mt-4" data-testid="workspace">
            <div className="hidden text-[11px] font-semibold uppercase tracking-wider text-zinc-400 lg:block">
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
        <div className="px-3 pb-2">
          <CommandPaletteButton />
        </div>
        <ClientQuickSearch />
        <AdminNav sections={sections} />
        <div className="hidden border-t border-white/10 px-4 py-3 text-xs lg:block">
          <div className="font-medium text-white">{ctx.staff.displayLabel}</div>
          <div className="text-zinc-400">{ctx.staff.roleName}</div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <form action={logout}>
                <button className="text-zinc-400 underline hover:text-white">
                  Sign out
                </button>
              </form>
              <Link href="/admin/my-security" className="text-zinc-400 underline hover:text-white">
                Security
              </Link>
            </div>
            <ThemeSwitch />
          </div>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-3 py-4 focus:outline-none sm:px-6 sm:py-6">
        {children}
      </main>
      <CommandPalette
        sections={sections}
        reports={reports}
        shops={ctx.assignedShops}
        currentShopId={ctx.currentShopId}
        combined={ctx.combinedView}
        brandWide={ctx.brandWide}
        findClients
        goTo={GO_TO.filter((g) => hrefs.has(g.href)).map((g) => ({ ...g }))}
      />
      {extras}
    </div>
  );
}
