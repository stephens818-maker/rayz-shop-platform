import type { Metadata } from "next";
import { asc, ne } from "drizzle-orm";
import { db } from "@/db";
import { services, shopServices, shops } from "@/db/schema";
import { Card, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { can, guardPage } from "@/server/auth/staff";
import { lookups } from "@/server/lookups";
import { MasterEditor, ShopOverrides } from "./editors";

export const metadata: Metadata = { title: "Services" };

export default async function ServicesPage() {
  const ctx = await guardPage("/admin/services");
  const [master, overrides, shopRows] = await Promise.all([
    db.select().from(services).orderBy(asc(services.kind), asc(services.sortOrder), asc(services.name)),
    db.select().from(shopServices),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name)),
  ]);
  const visibleShops = shopRows.filter((s) => ctx.shopIds.includes(s.id));
  const shopId = ctx.currentShopId;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Services"
        subtitle="One brand catalog. Each shop can turn items on or off and override price, length and name."
      />
      {shopId ? (
        <ShopOverrides
          shopId={shopId}
          shopName={visibleShops.find((s) => s.id === shopId)?.name ?? ""}
          rows={master.map((m) => {
            const o = overrides.find((x) => x.shopId === shopId && x.serviceId === m.id);
            return {
              id: m.id,
              name: m.name,
              kind: m.kind,
              category: m.category,
              active: m.active,
              defaultPriceCents: m.defaultPriceCents,
              defaultDurationMin: m.defaultDurationMin,
              enabled: o?.enabled ?? false,
              bookableOnline: o?.bookableOnline ?? true,
              priceCents: o?.priceCents ?? null,
              durationMin: o?.durationMin ?? null,
              nameOverride: o?.nameOverride ?? null,
            };
          })}
        />
      ) : (
        <Card>
          <CardHeader title="Price matrix" subtitle="Effective price at each shop. A dash means the service is off at that shop. Pick a shop in the switcher to edit." />
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th right>Default</Th>
                {visibleShops.map((s) => (
                  <Th key={s.id} right>
                    {s.name}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {master
                .filter((m) => m.active)
                .map((m) => (
                  <tr key={m.id}>
                    <Td>
                      {m.kind === "addon" && <span className="text-zinc-400">+ </span>}
                      {m.name}
                    </Td>
                    <Td right className="text-zinc-500">
                      {formatCents(m.defaultPriceCents)}
                    </Td>
                    {visibleShops.map((s) => {
                      const o = overrides.find((x) => x.shopId === s.id && x.serviceId === m.id);
                      const differs = o?.priceCents != null && o.priceCents !== m.defaultPriceCents;
                      return (
                        <Td key={s.id} right className={differs ? "font-medium text-brand-700" : ""}>
                          {o?.enabled ? formatCents(o.priceCents ?? m.defaultPriceCents) : <span className="text-zinc-300">—</span>}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </Table>
        </Card>
      )}
      {can(ctx, "catalog.manage") && (
        <MasterEditor
          categories={(await lookups()).serviceCategories}
          rows={master.map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            category: m.category,
            description: m.description,
            defaultPriceCents: m.defaultPriceCents,
            defaultDurationMin: m.defaultDurationMin,
            active: m.active,
            sortOrder: m.sortOrder,
          }))}
        />
      )}
    </div>
  );
}
