import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, loyaltyAccounts, shops } from "@/db/schema";
import { Card, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { formatDate } from "@/lib/time";
import { canManage, requireStaff } from "@/server/auth/staff";
import { customerSearchWhere, maskPhone, visitedScope } from "@/server/customers";

export const metadata: Metadata = { title: "Clients" };

const PAGE = 50;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const full = canManage(ctx);
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const search = customerSearchWhere(q);
  // Barbers: clients they've cut. Managers: the shared book when searching; otherwise this shop's
  // clients, meaning home shop here or any visit here.
  const scope = !full
    ? visitedScope({ staffId: ctx.staff.id })
    : search
      ? undefined
      : ctx.currentShopId
        ? or(eq(customers.homeShopId, ctx.currentShopId), visitedScope({ shopIds: [ctx.currentShopId] }))
        : undefined;
  const rows = await db
    .select({
      c: customers,
      shop: shops.name,
      progress: loyaltyAccounts.progressCents,
      lastVisit: sql<string | null>`(select max(starts_at) from appointments a where a.customer_id = ${customers.id} and a.status = 'completed')`,
      visits: sql<number>`(select count(*)::int from appointments a where a.customer_id = ${customers.id} and a.status = 'completed')`,
    })
    .from(customers)
    .leftJoin(shops, eq(shops.id, customers.homeShopId))
    .leftJoin(loyaltyAccounts, eq(loyaltyAccounts.customerId, customers.id))
    .where(and(search, scope))
    .orderBy(desc(customers.createdAt))
    .limit(PAGE)
    .offset((page - 1) * PAGE);
  const shopName = ctx.shops.find((s) => s.id === ctx.currentShopId)?.name;
  const subtitle = !full
    ? "Clients you've had in your chair."
    : q
      ? "Searching every Ray'z shop. Clients and loyalty are shared across shops."
      : shopName
        ? `${shopName} clients (home shop or a visit here). Search to find anyone at any shop.`
        : "All Ray'z clients.";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={full ? "Clients" : "My clients"}
        subtitle={subtitle}
        actions={
          full && (
            <div className="flex gap-2">
              <LinkButton variant="secondary" href="/admin/customers/duplicates">
                Duplicates
              </LinkButton>
              <LinkButton href="/admin/customers/new">New client</LinkButton>
            </div>
          )
        }
      />
      <form className="mb-4 flex gap-2" action="/admin/customers">
        <input name="q" defaultValue={q} placeholder="Search name, phone or email" className="h-10 w-full max-w-md rounded-lg px-3 text-sm ring-1 ring-zinc-300" autoFocus />
        <button className="h-10 rounded-lg bg-ink-900 px-4 text-sm font-medium text-white">Search</button>
      </form>
      {rows.length === 0 ? (
        <Empty title="No clients found" />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Phone</Th>
                {full && <Th>Email</Th>}
                <Th>Home shop</Th>
                <Th right>Visits</Th>
                <Th>Last visit</Th>
                <Th right>Loyalty progress</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, shop, progress, lastVisit, visits }) => (
                <tr key={c.id} className="hover:bg-zinc-50">
                  <Td>
                    <Link className="font-medium hover:underline" href={`/admin/customers/${c.id}`}>
                      {c.firstName} {c.lastName}
                    </Link>
                  </Td>
                  <Td>{full ? formatPhone(c.phone) || "—" : (maskPhone(c.phone) ?? "—")}</Td>
                  {full && <Td className="text-zinc-600">{c.email ?? "—"}</Td>}
                  <Td>{shop ?? "—"}</Td>
                  <Td right>{visits}</Td>
                  <Td>{lastVisit ? formatDate(new Date(lastVisit), "MMM d, yyyy") : "—"}</Td>
                  <Td right>{formatCents(progress ?? 0)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex justify-between px-4 py-3 text-sm">
            {page > 1 ? <Link href={`/admin/customers?q=${encodeURIComponent(q)}&page=${page - 1}`}>‹ Previous</Link> : <span />}
            {rows.length === PAGE && <Link href={`/admin/customers?q=${encodeURIComponent(q)}&page=${page + 1}`}>Next ›</Link>}
          </div>
        </Card>
      )}
    </div>
  );
}
