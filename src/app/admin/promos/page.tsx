import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { couponCodes, customers, giftCardLedger, giftCards, products, promoCodes, sales, services, shops } from "@/db/schema";
import { couponSummary, couponWhenLabel } from "@/domain/coupons";
import { Badge, Card, CardHeader, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { ruleOf } from "@/server/coupons";
import { OTHER_SHOP, hasShop, inShops } from "@/server/tenant";
import { CouponForm, GiftCardTools, PromoToggle, VoidGiftCard } from "./editors";
import { couponInputOf, scopeOf } from "./coupon-input";

export const metadata: Metadata = { title: "Promos & gift cards" };

export default async function PromosPage({ searchParams }: { searchParams: Promise<{ gc?: string; edit?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/promos");
  const managesPromos = can(ctx, "promos.manage");
  const canVoid = can(ctx, "giftcards.void");
  const today = todayLocal();
  // Cards work at every shop, so any card can be looked up by its exact code; a shop workspace
  // lists only the cards issued at its shops.
  const term = sp.gc?.trim().toUpperCase();
  const issuedHere = ctx.brandWide ? undefined : inShops(ctx, giftCards.issuedShopId);
  const cardWhere = term ? (ctx.brandWide ? ilike(giftCards.code, `%${term}%`) : or(and(ilike(giftCards.code, `%${term}%`), issuedHere), eq(giftCards.code, term))) : issuedHere;
  const [promos, shopRows, cards, [liability]] = await Promise.all([
    db
      .select()
      .from(promoCodes)
      .orderBy(desc(promoCodes.active), desc(promoCodes.createdAt)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name)),
    db
      .select({ g: giftCards, shop: shops.name, first: customers.firstName, last: customers.lastName })
      .from(giftCards)
      .leftJoin(shops, eq(shops.id, giftCards.issuedShopId))
      .leftJoin(customers, eq(customers.id, giftCards.customerId))
      .where(cardWhere)
      .orderBy(desc(giftCards.createdAt))
      .limit(40),
    db
      .select({ n: sql<number>`count(*) filter (where ${giftCards.status} = 'active' and ${giftCards.balanceCents} > 0)::int`, cents: sql<number>`coalesce(sum(${giftCards.balanceCents}) filter (where ${giftCards.status} = 'active'), 0)::int` })
      .from(giftCards)
      .where(issuedHere),
  ]);
  const shown = promos.filter((p) => ctx.brandWide || !scopeOf(p).length || scopeOf(p).some((s) => ctx.shopIds.includes(s)));
  const visible = await Promise.all(shown.map(async (p) => ({ p, summary: couponSummary(await ruleOf(p, p.code, "code")) })));
  // Redemptions that weren't reversed and what those tickets brought in, at the person's shops.
  const used = (await db.execute(sql`
    select r.promo_id, count(*)::int n, coalesce(sum(case when s.status in ('paid', 'partially_refunded') then s.service_net_cents + s.product_net_cents else 0 end), 0)::bigint cents
    from coupon_redemptions r join sales s on s.id = r.sale_id
    where r.reversed_at is null ${ctx.brandWide ? sql`` : ctx.shopIds.length ? sql`and r.shop_id in (${sql.join(ctx.shopIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql`and false`}
    group by r.promo_id`)) as unknown as { promo_id: string; n: number; cents: string | number }[];
  const usedBy = new Map(used.map((u) => [u.promo_id, { n: Number(u.n), cents: Number(u.cents) }]));
  const editing = managesPromos && sp.edit ? (shown.find((p) => p.id === sp.edit) ?? null) : null;
  const [serviceRows, productRows, issued] = managesPromos
    ? await Promise.all([
        db.select({ id: services.id, name: services.name, kind: services.kind }).from(services).where(eq(services.active, true)).orderBy(asc(services.name)),
        db.select({ id: products.id, name: sql<string>`${products.brand} || ' ' || ${products.name}` }).from(products).where(eq(products.active, true)).orderBy(asc(products.brand), asc(products.name)).limit(500),
        editing ? db.select({ id: couponCodes.promoId }).from(couponCodes).where(eq(couponCodes.promoId, editing.id)).limit(1) : [],
      ])
    : [[], [], []];
  const issuedFor = new Set(issued.map((x) => x.id));
  const single = cards.length === 1 ? cards[0] : null;
  const ledger = single
    ? (
        await db
          .select({ l: giftCardLedger, saleShopId: sales.shopId })
          .from(giftCardLedger)
          .leftJoin(sales, eq(sales.id, giftCardLedger.saleId))
          .where(eq(giftCardLedger.giftCardId, single.g.id))
          .orderBy(asc(giftCardLedger.createdAt))
      ).map(({ l, saleShopId }) => ({ ...l, away: !ctx.brandWide && !!saleShopId && !hasShop(ctx, saleShopId) }))
    : [];
  const shopId = ctx.currentShopId ?? ctx.shopIds[0];

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Promos & gift cards" />
      <Card>
        <CardHeader title="Coupons and promo codes" subtitle="Applied at checkout and when booking online, by code or automatically. Percent discounts apply before fixed amounts. Coupons reduce the net service spend that earns loyalty." />
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Discount</Th>
              <Th>Rules</Th>
              <Th>Locations</Th>
              <Th>Dates</Th>
              <Th right>Used</Th>
              <Th right>Revenue</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ p, summary }) => {
              const expired = p.endsOn && p.endsOn < today;
              const scope = scopeOf(p);
              const editable = managesPromos && (ctx.brandWide || (scope.length > 0 && scope.every((s) => ctx.shopIds.includes(s))));
              return (
                <tr key={p.id} className={p.id === sp.edit ? "bg-amber-50" : undefined}>
                  <Td className="font-mono font-semibold">{p.codeMode === "unique" ? `${p.code}-…` : p.code}</Td>
                  <Td className="whitespace-normal">
                    {summary}
                    {p.description && <div className="text-xs text-zinc-500">{p.description}</div>}
                  </Td>
                  <Td className="whitespace-normal">
                    <div className="flex max-w-64 flex-wrap gap-1">
                      {p.codeMode === "unique" && <Badge tone="violet">{p.validDays ? `Single-use, ${p.validDays} days` : "Single-use codes"}</Badge>}
                      {p.autoApply && <Badge tone="blue">Applies itself</Badge>}
                      {p.firstVisitOnly && <Badge>First visit</Badge>}
                      {p.maxPerCustomer ? <Badge>{p.maxPerCustomer === 1 ? "One time per client" : `Up to ${p.maxPerCustomer} per client`}</Badge> : <Badge>Recurring</Badge>}
                      {couponWhenLabel(p) && <Badge tone="amber">{couponWhenLabel(p)}</Badge>}
                      {p.stackable && <Badge>Stacks</Badge>}
                    </div>
                  </Td>
                  <Td className="whitespace-normal text-xs">{scope.length ? [...new Set(scope.map((id) => ((ctx.brandWide || ctx.shopIds.includes(id)) && shopRows.find((s) => s.id === id)?.name) || OTHER_SHOP))].join(", ") : "All shops"}</Td>
                  <Td className="text-xs">{p.startsOn || p.endsOn ? `${p.startsOn ?? "…"} → ${p.endsOn ?? "…"}` : "Always"}</Td>
                  <Td right>
                    {usedBy.get(p.id)?.n ?? 0}
                    {p.maxRedemptions ? ` / ${p.maxRedemptions}` : ""}
                  </Td>
                  <Td right>{formatCents(usedBy.get(p.id)?.cents ?? 0)}</Td>
                  <Td>{!p.active ? <Badge>Off</Badge> : expired ? <Badge tone="amber">Expired</Badge> : <Badge tone="green">Active</Badge>}</Td>
                  <Td>
                    {editable && (
                      <span className="flex gap-3">
                        <Link className="text-xs underline" href={`/admin/promos?edit=${p.id}`}>
                          Edit
                        </Link>
                        <PromoToggle id={p.id} active={p.active} />
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {managesPromos && (
          <CouponForm
            key={editing?.id ?? "new"}
            initial={editing ? couponInputOf(editing) : null}
            editingId={editing?.id ?? null}
            locked={!!editing && (editing.redemptions > 0 || issuedFor.has(editing.id))}
            shops={shopRows.filter((s) => ctx.shopIds.includes(s.id))}
            allShops={ctx.brandWide}
            services={serviceRows}
            products={productRows}
          />
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active gift cards" value={liability.n} />
        <Stat label="Outstanding balance" value={formatCents(liability.cents)} hint={ctx.brandWide ? "Gift card liability, brand-wide" : "Cards issued at your shops"} />
      </div>

      <Card>
        <CardHeader title="Gift cards" subtitle="Sell gift cards from checkout. Balances work at every shop." />
        <GiftCardTools shopId={shopId} initialQuery={sp.gc ?? ""} canIssue={can(ctx, "giftcards.issue")} />
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th right>Initial</Th>
              <Th right>Balance</Th>
              <Th>Source</Th>
              <Th>Issued at</Th>
              <Th>Client</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              {canVoid && <Th />}
            </tr>
          </thead>
          <tbody>
            {cards.map(({ g, shop, first, last }) => (
              <tr key={g.id}>
                <Td className="font-mono">{g.code}</Td>
                <Td right>{formatCents(g.initialCents)}</Td>
                <Td right className="font-semibold">
                  {formatCents(g.balanceCents)}
                </Td>
                <Td className="capitalize">{g.source}</Td>
                <Td>{g.issuedShopId && !ctx.brandWide && !hasShop(ctx, g.issuedShopId) ? OTHER_SHOP : (shop ?? "—")}</Td>
                <Td>{first ? `${first} ${last ?? ""}` : "—"}</Td>
                <Td>
                  <Badge tone={g.status === "active" ? "green" : "gray"}>{g.status}</Badge>
                </Td>
                <Td className="text-xs">{formatDateTime(g.createdAt)}</Td>
                {canVoid && <Td>{g.status === "active" && (ctx.brandWide || (g.issuedShopId && ctx.shopIds.includes(g.issuedShopId))) && <VoidGiftCard id={g.id} />}</Td>}
              </tr>
            ))}
          </tbody>
        </Table>
        {single && (
          <div className="border-t border-zinc-100 p-4">
            <div className="mb-2 text-sm font-semibold">History for {single.g.code}</div>
            <ul className="space-y-1 text-sm">
              {ledger.map((l) => (
                <li key={l.id} className="flex justify-between">
                  <span className="capitalize">
                    {l.kind} <span className="text-xs text-zinc-500">{l.away ? "at another Ray'z shop" : formatDateTime(l.createdAt)}</span>
                  </span>
                  <span className={l.deltaCents < 0 ? "text-red-600" : "text-emerald-700"}>{formatCents(l.deltaCents, { sign: true })}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
