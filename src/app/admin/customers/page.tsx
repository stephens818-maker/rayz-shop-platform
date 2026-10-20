import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, loyaltyAccounts, shops } from "@/db/schema";
import { Card, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { formatDate } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";

export const metadata: Metadata = { title: "Clients" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const phone = normalizePhone(q);
  const [first, ...rest] = q.split(/\s+/);
  const where = q
    ? phone
      ? eq(customers.phone, phone)
      : rest.length
        ? and(ilike(customers.firstName, `${first}%`), ilike(customers.lastName, `${rest.join(" ")}%`))
        : or(ilike(customers.firstName, `${q}%`), ilike(customers.lastName, `${q}%`), ilike(customers.email, `%${q}%`), ilike(customers.phone, `%${q.replace(/\D/g, "") || "x"}%`))
    : ctx.currentShopId
      ? eq(customers.homeShopId, ctx.currentShopId)
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
    .where(where)
    .orderBy(desc(customers.createdAt))
    .limit(50)
    .offset((page - 1) * 50);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Clients" subtitle="Clients and loyalty are shared across all Ray'z shops." />
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
                <Th>Email</Th>
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
                  <Td>{formatPhone(c.phone) || "—"}</Td>
                  <Td className="text-zinc-600">{c.email ?? "—"}</Td>
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
            {rows.length === 50 && <Link href={`/admin/customers?q=${encodeURIComponent(q)}&page=${page + 1}`}>Next ›</Link>}
          </div>
        </Card>
      )}
    </div>
  );
}
