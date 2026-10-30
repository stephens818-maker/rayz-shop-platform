import type { Metadata } from "next";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { services, shopServices, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatCents, formatRate } from "@/lib/money";
import { guardPage } from "@/server/auth/staff";
import { listCategories } from "@/server/catalog-categories";

export const metadata: Metadata = { title: "Service menu" };

/**
 * The shop's menu as the desk rings it up: name, length, price, tax and category, and whether each
 * item is on here. Read-only; the brand's catalog and each shop's prices are edited under Services.
 */
export default async function ServiceMenuPage() {
  const ctx = await guardPage("/admin/services/menu");
  const shopId = ctx.currentShopId;
  if (!shopId) return <Empty title="Pick a shop">The menu is per shop. Pick one in the switcher.</Empty>;
  const [shop, rows, categories] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, shopId) }),
    db
      .select({ s: services, o: shopServices })
      .from(services)
      .leftJoin(shopServices, and(eq(shopServices.serviceId, services.id), eq(shopServices.shopId, shopId)))
      .where(eq(services.active, true))
      .orderBy(asc(services.kind), asc(services.sortOrder), asc(services.name)),
    listCategories("service"),
  ]);
  if (!shop) return <Empty title="Shop not found" />;
  const rank = new Map(categories.map((c, i) => [c.name.toLowerCase(), i]));
  const sorted = [...rows].sort((a, b) => a.s.kind.localeCompare(b.s.kind) || (rank.get(a.s.category.toLowerCase()) ?? 1e6) - (rank.get(b.s.category.toLowerCase()) ?? 1e6));
  const taxOf = (c: string) => (c === "exempt" ? null : Number(c === "product" ? shop.productTaxRate : shop.serviceTaxRate));
  const on = sorted.filter((r) => r.o?.enabled).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Service menu"
        subtitle={`${shop.name}: ${on} of ${sorted.length} on here. Prices and lengths are this shop's; the brand sets the catalog.`}
      />
      <Card>
        <CardHeader
          title="Services and add-ons"
          subtitle={
            shop.cardFeeEnabled
              ? `Card payments add a ${formatRate(Number(shop.cardFeeRate))} card fee at checkout. It shows on the ticket as a fee, not as tax.`
              : "No card fee at this shop."
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Service</Th>
              <Th>Category</Th>
              <Th right>Length</Th>
              <Th right>Price</Th>
              <Th right>Tax</Th>
              <Th>Here</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ s, o }) => {
              const tax = taxOf(s.taxCategory);
              return (
                <tr key={s.id} className={o?.enabled ? "" : "text-zinc-400"}>
                  <Td>
                    {s.kind === "addon" && <span className="text-zinc-400">+ </span>}
                    {o?.nameOverride ?? s.name}
                  </Td>
                  <Td>{s.category}</Td>
                  <Td right>{o?.durationMin ?? s.defaultDurationMin} min</Td>
                  <Td right>{formatCents(o?.priceCents ?? s.defaultPriceCents)}</Td>
                  <Td right>{tax === null ? "Exempt" : tax > 0 ? formatRate(tax) : "None"}</Td>
                  <Td>
                    {o?.enabled ? (
                      <Badge tone="green">{o.bookableOnline ? "On" : "On, not online"}</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
