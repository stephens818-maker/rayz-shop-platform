import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientRatings, customers, loyaltyAccounts, shops } from "@/db/schema";
import { Card, Empty, LinkButton, PageHeader, StarBadge, Table, Td, Th } from "@/components/ui";
import { CLIENT_SORTS, RATING_FILTERS, parseClientSort, parseRatingFilter } from "@/domain/ratings";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { formatDate } from "@/lib/time";
import { canManage, requireStaff } from "@/server/auth/staff";
import { customerSearchWhere, maskPhone, visitedScope } from "@/server/customers";

export const metadata: Metadata = { title: "Clients" };

const PAGE = 50;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; rating?: string; sort?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const full = canManage(ctx);
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const search = customerSearchWhere(q);
  const ratingFilter = parseRatingFilter(sp.rating);
  const sort = parseClientSort(sp.sort);
  const r = db
    .select({ customerId: clientRatings.customerId, avg: sql<number>`avg(${clientRatings.stars})::float8`.as("rating_avg"), count: sql<number>`count(*)::int`.as("rating_count") })
    .from(clientRatings)
    .groupBy(clientRatings.customerId)
    .as("r");
  const byRating = {
    rated: isNotNull(r.count),
    low: lt(r.avg, 3),
    high: gte(r.avg, 4),
    unrated: isNull(r.count),
  };
  const order = {
    recent: [desc(customers.createdAt)],
    rating_desc: [sql`${r.avg} desc nulls last`, desc(r.count), desc(customers.createdAt)],
    rating_asc: [sql`${r.avg} asc nulls last`, desc(r.count), asc(customers.createdAt)],
  }[sort];
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
      ratingAvg: r.avg,
      ratingCount: r.count,
    })
    .from(customers)
    .leftJoin(shops, eq(shops.id, customers.homeShopId))
    .leftJoin(loyaltyAccounts, eq(loyaltyAccounts.customerId, customers.id))
    .leftJoin(r, eq(r.customerId, customers.id))
    .where(and(search, scope, ratingFilter ? byRating[ratingFilter] : undefined))
    .orderBy(...order)
    .limit(PAGE)
    .offset((page - 1) * PAGE);
  const pageHref = (n: number) => {
    const qs = new URLSearchParams({ page: String(n) });
    if (q) qs.set("q", q);
    if (ratingFilter) qs.set("rating", ratingFilter);
    if (sort !== "recent") qs.set("sort", sort);
    return `/admin/customers?${qs}`;
  };
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
      <form className="mb-4 flex flex-wrap gap-2" action="/admin/customers">
        <input name="q" defaultValue={q} placeholder="Search name, phone or email" className="h-10 w-full max-w-md rounded-lg px-3 text-sm ring-1 ring-zinc-300" autoFocus />
        <select name="rating" defaultValue={ratingFilter ?? ""} aria-label="Filter by staff rating" className="h-10 rounded-lg px-2 text-sm ring-1 ring-zinc-300">
          <option value="">Any rating</option>
          {Object.entries(RATING_FILTERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select name="sort" defaultValue={sort} aria-label="Sort" className="h-10 rounded-lg px-2 text-sm ring-1 ring-zinc-300">
          {Object.entries(CLIENT_SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
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
                <Th>Rating</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, shop, progress, lastVisit, visits, ratingAvg, ratingCount }) => (
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
                  <Td>{ratingCount ? <StarBadge rating={{ avg: ratingAvg, count: ratingCount }} /> : <span className="text-xs text-zinc-400">—</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex justify-between px-4 py-3 text-sm">
            {page > 1 ? <Link href={pageHref(page - 1)}>‹ Previous</Link> : <span />}
            {rows.length === PAGE && <Link href={pageHref(page + 1)}>Next ›</Link>}
          </div>
        </Card>
      )}
    </div>
  );
}
