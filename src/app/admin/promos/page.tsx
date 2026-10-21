import type { Metadata } from "next";
import { asc, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, giftCardLedger, giftCards, promoCodes, shops } from "@/db/schema";
import { Badge, Card, CardHeader, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { GiftCardTools, PromoForm, PromoToggle, VoidGiftCard } from "./editors";

export const metadata: Metadata = { title: "Promos & gift cards" };

export default async function PromosPage({ searchParams }: { searchParams: Promise<{ gc?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/promos");
  const managesPromos = can(ctx, "promos.manage");
  const canVoid = can(ctx, "giftcards.void");
  const today = todayLocal();
  const [promos, shopRows, cards, [liability]] = await Promise.all([
    db.select().from(promoCodes).orderBy(desc(promoCodes.active), desc(promoCodes.createdAt)),
    db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name)),
    db
      .select({ g: giftCards, shop: shops.name, first: customers.firstName, last: customers.lastName })
      .from(giftCards)
      .leftJoin(shops, eq(shops.id, giftCards.issuedShopId))
      .leftJoin(customers, eq(customers.id, giftCards.customerId))
      .where(sp.gc ? ilike(giftCards.code, `%${sp.gc.trim().toUpperCase()}%`) : undefined)
      .orderBy(desc(giftCards.createdAt))
      .limit(40),
    db
      .select({ n: sql<number>`count(*) filter (where ${giftCards.status} = 'active' and ${giftCards.balanceCents} > 0)::int`, cents: sql<number>`coalesce(sum(${giftCards.balanceCents}) filter (where ${giftCards.status} = 'active'), 0)::int` })
      .from(giftCards),
  ]);
  const visible = promos.filter((p) => ctx.brandWide || !p.shopId || ctx.shopIds.includes(p.shopId));
  const single = cards.length === 1 ? cards[0] : null;
  const ledger = single ? await db.select().from(giftCardLedger).where(eq(giftCardLedger.giftCardId, single.g.id)).orderBy(asc(giftCardLedger.createdAt)) : [];
  const shopId = ctx.currentShopId ?? ctx.shopIds[0];

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Promos & gift cards" />
      <Card>
        <CardHeader title="Promo codes" subtitle="Applied at checkout. Percent discounts apply before fixed amounts. Discounts reduce loyalty earnings." />
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Discount</Th>
              <Th>On</Th>
              <Th>Shop</Th>
              <Th>Dates</Th>
              <Th right>Used</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const expired = p.endsOn && p.endsOn < today;
              const editable = managesPromos && (ctx.brandWide || (!!p.shopId && ctx.shopIds.includes(p.shopId)));
              return (
                <tr key={p.id}>
                  <Td className="font-mono font-semibold">{p.code}</Td>
                  <Td>
                    {p.type === "percent" ? `${p.value}% off` : `${formatCents(p.value)} off`}
                    {p.description && <div className="text-xs text-zinc-500">{p.description}</div>}
                  </Td>
                  <Td className="capitalize">{p.appliesTo}</Td>
                  <Td>{p.shopId ? shopRows.find((s) => s.id === p.shopId)?.name : "All shops"}</Td>
                  <Td className="text-xs">{p.startsOn || p.endsOn ? `${p.startsOn ?? "…"} → ${p.endsOn ?? "…"}` : "Always"}</Td>
                  <Td right>
                    {p.redemptions}
                    {p.maxRedemptions ? ` / ${p.maxRedemptions}` : ""}
                  </Td>
                  <Td>{!p.active ? <Badge>Off</Badge> : expired ? <Badge tone="amber">Expired</Badge> : <Badge tone="green">Active</Badge>}</Td>
                  <Td>{editable && <PromoToggle id={p.id} active={p.active} />}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {managesPromos && <PromoForm shops={shopRows.filter((s) => ctx.shopIds.includes(s.id))} allShops={ctx.brandWide} />}
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active gift cards" value={liability.n} />
        <Stat label="Outstanding balance" value={formatCents(liability.cents)} hint="Gift card liability, brand-wide" />
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
                <Td>{shop ?? "—"}</Td>
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
                    {l.kind} <span className="text-xs text-zinc-500">{formatDateTime(l.createdAt)}</span>
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
