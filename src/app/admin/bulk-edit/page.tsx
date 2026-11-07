import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { services, shopServices, shops, staff, staffSchedules, staffShops } from "@/db/schema";
import { PageHeader, cx } from "@/components/ui";
import { WEEKDAYS } from "@/lib/time";
import { can, canAny, guardPage } from "@/server/auth/staff";
import { listScheduleTemplates } from "@/server/bulk-edit";
import { listCategories } from "@/server/catalog-categories";
import { brandProducts } from "@/server/inventory/brand-stock";
import { ProductsBulk, SchedulesBulk, ServicesBulk, StaffBulk } from "./bulk";

export const metadata: Metadata = { title: "Bulk edit" };

const TABS = [
  { id: "staff", label: "Staff" },
  { id: "services", label: "Services" },
  { id: "products", label: "Products" },
  { id: "schedules", label: "Schedules" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default async function BulkEditPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await guardPage("/admin/bulk-edit");
  const allowed: Record<Tab, boolean> = {
    staff: can(ctx, "staff.manage"),
    services: canAny(ctx, ["catalog.manage", "catalog.prices"]),
    products: can(ctx, "catalog.manage"),
    schedules: can(ctx, "schedules.edit"),
  };
  const want = (await searchParams).tab;
  const tab = TABS.find((t) => t.id === want && allowed[t.id])?.id ?? TABS.find((t) => allowed[t.id])!.id;
  const shop = ctx.currentShopId ? (ctx.shops.find((s) => s.id === ctx.currentShopId) ?? null) : null;
  const here = shop ? { id: shop.id, name: shop.name } : null;
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Bulk edit" subtitle="One change for many staff, services, products or schedules. Every item changed is audited on its own." />
      <nav className="flex gap-1 border-b border-zinc-200" aria-label="Bulk edit">
        {TABS.filter((t) => allowed[t.id]).map((t) => (
          <Link key={t.id} href={`/admin/bulk-edit?tab=${t.id}`} className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.id === tab ? "border-ink-900 text-ink-900" : "border-transparent text-zinc-500 hover:text-zinc-800")}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "services" && <ServicesTab here={here} canBrand={can(ctx, "catalog.manage")} />}
      {tab === "products" && <ProductsTab />}
      {tab === "staff" && <StaffTab shopIds={ctx.shopIds} here={here} />}
      {tab === "schedules" && <SchedulesTab here={here} canEditTemplates={ctx.brandWide} />}
    </div>
  );
}

async function ServicesTab({ here, canBrand }: { here: { id: string; name: string } | null; canBrand: boolean }) {
  const [rows, menu, categories] = await Promise.all([
    db.select().from(services).orderBy(asc(services.kind), asc(services.category), asc(services.sortOrder), asc(services.name)),
    here ? db.select().from(shopServices).where(eq(shopServices.shopId, here.id)) : Promise.resolve([]),
    listCategories("service"),
  ]);
  const rank = new Map(categories.map((c, i) => [c.name.toLowerCase(), i]));
  const sorted = [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || (rank.get(a.category.toLowerCase()) ?? 1e6) - (rank.get(b.category.toLowerCase()) ?? 1e6));
  return (
    <ServicesBulk
      shop={here}
      canBrand={canBrand}
      canShop={!!here}
      categories={categories.map((c) => c.name)}
      rows={sorted.map((s) => {
        const m = menu.find((x) => x.serviceId === s.id);
        return { id: s.id, name: s.name, kind: s.kind, category: s.category, priceCents: s.defaultPriceCents, durationMin: s.defaultDurationMin, active: s.active, enabledHere: here ? (m?.enabled ?? false) : null, onlineHere: m?.bookableOnline ?? null };
      })}
    />
  );
}

async function ProductsTab() {
  const [rows, categories] = await Promise.all([brandProducts(), listCategories("product")]);
  return (
    <ProductsBulk
      categories={categories.map((c) => c.name)}
      rows={rows.map((r) => ({ id: r.id, sku: r.sku, brand: r.brand, name: r.name, category: r.category, costCents: r.costCents, priceCents: r.priceCents, low: r.lowStockThreshold, par: r.parLevel, high: r.highStockThreshold, active: r.active }))}
    />
  );
}

async function StaffTab({ shopIds, here }: { shopIds: string[]; here: { id: string; name: string } | null }) {
  const links = shopIds.length
    ? await db
        .select({ staffId: staffShops.staffId, shopId: staffShops.shopId, visible: staffShops.visibleOnline, shop: shops.name, label: staff.displayLabel })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .innerJoin(shops, eq(shops.id, staffShops.shopId))
        .where(and(inArray(staffShops.shopId, here ? [here.id] : shopIds), eq(staff.kind, "person"), eq(staff.active, true)))
        .orderBy(asc(staff.displayLabel), asc(shops.name))
    : [];
  const people = [...new Map(links.map((l) => [l.staffId, l.label])).entries()].map(([id, label]) => {
    const mine = links.filter((l) => l.staffId === id);
    return { id, label, shops: mine.map((l) => l.shop).join(", "), visibleHere: here ? (mine.find((l) => l.shopId === here.id)?.visible ?? null) : null };
  });
  return <StaffBulk people={people} shop={here} />;
}

async function SchedulesTab({ here, canEditTemplates }: { here: { id: string; name: string } | null; canEditTemplates: boolean }) {
  const templates = await listScheduleTemplates();
  const barbers = here
    ? await db
        .select({ id: staff.id, label: staff.displayLabel })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .where(and(eq(staffShops.shopId, here.id), eq(staff.kind, "person"), eq(staff.active, true), eq(staff.isBookable, true)))
        .orderBy(asc(staff.displayLabel))
    : [];
  const hours = barbers.length ? await db.select().from(staffSchedules).where(and(eq(staffSchedules.shopId, here!.id), inArray(staffSchedules.staffId, barbers.map((b) => b.id)))) : [];
  return (
    <SchedulesBulk
      templates={templates.map((t) => ({ id: t.id, name: t.name, rows: t.rows }))}
      shop={here}
      canEditTemplates={canEditTemplates}
      barbers={barbers.map((b) => {
        const mine = hours.filter((h) => h.staffId === b.id);
        return { ...b, hours: mine.reduce((a, h) => a + h.endMin - h.startMin, 0) / 60, days: [...new Set(mine.sort((x, y) => x.weekday - y.weekday).map((h) => WEEKDAYS[h.weekday]))].join(", ") };
      })}
    />
  );
}
