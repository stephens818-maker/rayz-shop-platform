import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientRatings, customers, loyaltyAccounts, shops } from "@/db/schema";
import { ClientBadges } from "@/components/client-badges";
import { Badge, Card, Empty, LinkButton, Notice, PageHeader, StarBadge, Table, Td, Th } from "@/components/ui";
import { EMPTY_SEGMENT } from "@/domain/marketing";
import { parseClientSort, parseRatingFilter } from "@/domain/ratings";
import { VISIT_STATUS_LABEL, VISIT_STATUS_TONE, cadenceLabel } from "@/domain/visit-cadence";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { shownBadges } from "@/server/badges";
import { filterOptions, panelSees } from "@/server/client-filters";
import { clientListQuery } from "@/server/client-list";
import { PAUSED_MESSAGE, clientListDenied, clientPolicy, isPaused, recordClientAccess } from "@/server/client-privacy";
import { listSavedSearches } from "@/server/saved-searches";
import { cadenceFor } from "@/server/visit-cadence";
import { ClientListControls } from "./list-controls";
import { NoCopy } from "./privacy";

export const metadata: Metadata = { title: "Clients" };

const PAGE = 50;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; f?: string; page?: string; rating?: string; sort?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/customers");
  const full = can(ctx, "clients.view_all");
  const q = (sp.q ?? "").trim().slice(0, 120);
  const page = Math.max(1, Number(sp.page) || 1);
  const scoped = !ctx.brandWide;
  const policy = await clientPolicy(ctx);
  const filters = can(ctx, "clients.filters");
  let paused = false;
  try {
    await recordClientAccess(ctx, {
      kind: q ? "search" : "list",
      detail: { page, via: "clients", ...(q ? { q: q.replace(/\d/g, "#").replace(/@.*/, "@…") } : {}), ...(sp.f && filters ? { filtered: true } : {}) },
    });
  } catch (e) {
    if (!isPaused(e)) throw e;
    paused = true;
  }
  const showEmail = policy.level("email") !== "hidden";
  const showPhone = policy.level("phone") !== "hidden";
  const showRating = policy.level("ratings") !== "hidden";
  const list = paused ? null : await clientListQuery(ctx, policy, { q, f: sp.f });
  const seg = list?.seg ?? EMPTY_SEGMENT;
  const sees = panelSees(ctx, policy);
  const [options, saved] = await Promise.all([filters ? filterOptions(ctx, policy) : null, can(ctx, "clients.saved_searches") || filters ? listSavedSearches(ctx) : []]);
  const ratingFilter = parseRatingFilter(sp.rating);
  const sort = parseClientSort(sp.sort);
  const r = db
    .select({ customerId: clientRatings.customerId, avg: sql<number>`avg(${clientRatings.stars})::float8`.as("rating_avg"), count: sql<number>`count(*)::int`.as("rating_count") })
    .from(clientRatings)
    .groupBy(clientRatings.customerId)
    .as("r");
  const byRating = { rated: isNotNull(r.count), low: lt(r.avg, 3), high: gte(r.avg, 4), unrated: isNull(r.count) };
  const order = {
    recent: list?.relevance ? [sql`${list.relevance} asc nulls last`, desc(customers.createdAt)] : [desc(customers.createdAt)],
    rating_desc: [sql`${r.avg} desc nulls last`, desc(r.count), desc(customers.createdAt)],
    rating_asc: [sql`${r.avg} asc nulls last`, desc(r.count), asc(customers.createdAt)],
  }[sort];
  const rows = !list
    ? []
    : await db
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
        .where(and(list.where, ratingFilter ? byRating[ratingFilter] : undefined))
        .orderBy(...order)
        .limit(PAGE)
        .offset((page - 1) * PAGE);
  const [cadence, badges] = await Promise.all([
    cadenceFor(
      rows.map((r) => r.c.id),
      new Date(),
    ),
    shownBadges(
      policy,
      rows.map((r) => r.c.id),
    ),
  ]);
  const pageHref = (n: number) => {
    const qs = new URLSearchParams({ page: String(n) });
    if (q) qs.set("q", q);
    if (sp.f && seg !== EMPTY_SEGMENT) qs.set("f", sp.f);
    if (ratingFilter) qs.set("rating", ratingFilter);
    if (sort !== "recent") qs.set("sort", sort);
    return `/admin/customers?${qs}`;
  };
  const matched = (id: string) =>
    list?.matched
      .get(id)
      ?.filter((m) => m !== "Name")
      .join(", ") || null;
  const shopName = ctx.shops.find((s) => s.id === ctx.currentShopId)?.name;
  const yours = shopName ?? (ctx.shops.length === 1 ? ctx.shops[0].name : "Your shops'");
  const subtitle = !full
    ? "Clients you've had in your chair."
    : scoped
      ? q
        ? `${yours} clients matching your search, plus any Ray'z client whose exact phone, email, full name, card or code you entered. Visits count every Ray'z shop.`
        : `${yours} clients (home shop or a visit here). To book a client from another Ray'z shop, search their exact phone, email or full name.`
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
              {can(ctx, "clients.merge") && (
                <LinkButton variant="secondary" href="/admin/customers/duplicates">
                  Duplicates
                </LinkButton>
              )}
              {can(ctx, "clients.edit") && <LinkButton href="/admin/customers/new">New client</LinkButton>}
            </div>
          )
        }
      />
      <ClientListControls
        q={q}
        seg={seg}
        rating={ratingFilter}
        sort={sort}
        options={options}
        sees={sees}
        saved={saved}
        maySave={can(ctx, "clients.saved_searches")}
        share={{ shop: !!(ctx.currentShopId ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null)), brand: ctx.brandWide }}
        mayExport={full && can(ctx, "clients.export") && !clientListDenied(ctx)}
        mayBlast={can(ctx, "campaign_center.create")}
      />
      {list?.problem && <Notice tone="amber">{list.problem}. Showing the list without filters.</Notice>}
      {paused ? (
        <Notice>{PAUSED_MESSAGE}</Notice>
      ) : rows.length === 0 ? (
        <Empty title="No clients found" />
      ) : (
        <NoCopy what="the client list">
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  {showPhone && <Th>Phone</Th>}
                  {showEmail && <Th>Email</Th>}
                  <Th>Home shop</Th>
                  <Th right>Visits</Th>
                  <Th>Last visit</Th>
                  <Th>Comes in</Th>
                  <Th right>Loyalty progress</Th>
                  {showRating && <Th>Rating</Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, shop, progress, lastVisit, visits, ratingAvg, ratingCount }) => (
                  <tr key={c.id} className="hover:bg-zinc-50">
                    <Td>
                      <Link className="font-medium hover:underline" href={`/admin/customers/${c.id}`}>
                        {c.firstName} {c.lastName}
                      </Link>
                      {c.nickname && <span className="ml-1.5 text-zinc-500">&ldquo;{c.nickname}&rdquo;</span>}
                      <span className="ml-1.5 font-mono text-[11px] text-zinc-400">C{c.number}</span>
                      {matched(c.id) && <div className="text-[11px] text-brand-700">Matched {matched(c.id)}</div>}
                      <ClientBadges badges={badges.get(c.id)} max={4} className="mt-0.5 flex" />
                    </Td>
                    {showPhone && <Td className="whitespace-nowrap">{policy.show("phone", c.phone) ?? "—"}</Td>}
                    {showEmail && <Td className="text-zinc-600">{policy.show("email", c.email) ?? "—"}</Td>}
                    <Td>{shop ?? "—"}</Td>
                    <Td right>{visits}</Td>
                    <Td>{lastVisit ? formatDate(new Date(lastVisit), "MMM d, yyyy") : "—"}</Td>
                    <Td className="whitespace-nowrap">
                      <CadenceCell c={cadence.get(c.id)} />
                    </Td>
                    <Td right>{formatCents(progress ?? 0)}</Td>
                    {showRating && <Td>{ratingCount ? <StarBadge rating={{ avg: ratingAvg, count: ratingCount }} /> : <span className="text-xs text-zinc-400">—</span>}</Td>}
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex justify-between px-4 py-3 text-sm">
              {page > 1 ? <Link href={pageHref(page - 1)}>‹ Previous</Link> : <span />}
              {rows.length === PAGE && <Link href={pageHref(page + 1)}>Next ›</Link>}
            </div>
          </Card>
        </NoCopy>
      )}
    </div>
  );
}

function CadenceCell({ c }: { c: { cadenceDays: number | null; status: keyof typeof VISIT_STATUS_LABEL | null; nextExpected: string | null } | undefined }) {
  if (!c || c.cadenceDays === null || !c.status) return <span className="text-xs text-zinc-400">—</span>;
  return (
    <span title={c.nextExpected ? `Next expected ${formatDate(c.nextExpected, "MMM d, yyyy")}` : undefined}>
      {cadenceLabel(c.cadenceDays)} <Badge tone={VISIT_STATUS_TONE[c.status]}>{VISIT_STATUS_LABEL[c.status]}</Badge>
    </span>
  );
}
