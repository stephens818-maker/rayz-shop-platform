import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { guardPage, openShops, staffGrantor } from "@/server/auth/staff";
import { listShopLogins, shopLoginRoles } from "@/server/shop-logins";
import { LoginActions, NewShopLoginForm } from "./forms";

export const metadata: Metadata = { title: "Shop logins" };

export default async function ShopLoginsPage() {
  const ctx = await guardPage("/admin/shop-logins");
  const shopList = ctx.currentShopId ? openShops(ctx).filter((s) => s.id === ctx.currentShopId) : openShops(ctx);
  const [logins, roleRows] = await Promise.all([listShopLogins(shopList.map((s) => s.id)), db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name))]);
  const choices = shopLoginRoles(staffGrantor(ctx), roleRows).map((r) => ({ id: r.id, name: r.name, key: r.key }));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Shop logins"
        subtitle="Shared sign-ins for one shop, like the front-desk computer. A shop login sees only its shop: its calendar, sales, drawer, stock, staff and reports. Personal logins for managers and barbers are under Staff."
      />
      {shopList.length === 0 && <Empty title="No shops in your access" />}
      {shopList.map((shop) => {
        const rows = logins.filter((l) => l.shopId === shop.id);
        return (
          <Card key={shop.id}>
            <CardHeader title={shop.name} subtitle={[shop.address, shop.city].filter(Boolean).join(", ") || undefined} />
            {rows.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Sign-in email</Th>
                    <Th>Role</Th>
                    <Th>Last sign-in</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <Td className="font-medium">{l.label}</Td>
                      <Td className="font-mono text-xs">{l.email}</Td>
                      <Td>{l.role}</Td>
                      <Td className="text-xs text-zinc-600">{l.lastSignInAt ? formatDateTime(l.lastSignInAt) : "Never"}</Td>
                      <Td>{l.active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>}</Td>
                      <Td right>
                        <LoginActions id={l.id} label={l.label} active={l.active} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <NewShopLoginForm shop={{ id: shop.id, name: shop.name, slug: shop.slug }} roles={choices} first={rows.length === 0} />
          </Card>
        );
      })}
    </div>
  );
}
