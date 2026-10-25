import { and, asc, desc, eq, gt, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { customers, giftCardLedger, giftCards, saleItems, sales, shops } from "@/db/schema";
import { CompReloadInput, GiftCardSearch, IssueCompInput, VoidInput, reloadProblem } from "@/domain/gift-cards";
import { giftCardCode } from "@/lib/ids";
import { formatCents } from "@/lib/money";
import { Actor, audit } from "./audit";
import { openBlankSale } from "./checkout";
import { AppError, forbidden, notFound } from "./errors";
import { OTHER_SHOP, hasShop, inShops } from "./tenant";

export interface GiftCardViewer {
  brandWide: boolean;
  shopIds: string[];
}

type Card = typeof giftCards.$inferSelect;

/** Cards work at every shop; who manages one is whoever covers the shop that issued it. */
const manages = (v: GiftCardViewer, g: Pick<Card, "issuedShopId">) => v.brandWide || hasShop(v, g.issuedShopId);
const issuedHere = (v: GiftCardViewer): SQL | undefined => (v.brandWide ? undefined : inShops(v, giftCards.issuedShopId));

export async function giftCardStats(v: GiftCardViewer, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [card] = await db
    .select({
      active: sql<number>`count(*) filter (where ${giftCards.status} = 'active' and ${giftCards.balanceCents} > 0)::int`,
      outstanding: sql<number>`coalesce(sum(${giftCards.balanceCents}) filter (where ${giftCards.status} = 'active'), 0)::int`,
    })
    .from(giftCards)
    .where(issuedHere(v));
  const [moves] = await db
    .select({
      sold: sql<number>`coalesce(sum(${giftCardLedger.deltaCents}) filter (where ${giftCardLedger.kind} in ('issue', 'reload') and ${giftCardLedger.saleId} is not null), 0)::int`,
      reloaded: sql<number>`coalesce(sum(${giftCardLedger.deltaCents}) filter (where ${giftCardLedger.kind} = 'reload'), 0)::int`,
      comped: sql<number>`coalesce(sum(${giftCardLedger.deltaCents}) filter (where ${giftCardLedger.kind} in ('issue', 'comp') and ${giftCardLedger.saleId} is null), 0)::int`,
      redeemed: sql<number>`coalesce(-sum(${giftCardLedger.deltaCents}) filter (where ${giftCardLedger.kind} = 'redeem'), 0)::int`,
    })
    .from(giftCardLedger)
    .innerJoin(giftCards, eq(giftCards.id, giftCardLedger.giftCardId))
    .where(and(gt(giftCardLedger.createdAt, since), issuedHere(v)));
  return { ...card, ...moves };
}

/** Cards issued at the person's shops (every card brand-wide), newest first. An exact code finds any card. */
export async function searchGiftCards(v: GiftCardViewer, raw: z.input<typeof GiftCardSearch>) {
  const s = GiftCardSearch.parse(raw);
  const term = s.q.toUpperCase();
  const status =
    s.status === "active"
      ? and(eq(giftCards.status, "active"), gt(giftCards.balanceCents, 0))
      : s.status === "spent"
        ? and(eq(giftCards.status, "active"), eq(giftCards.balanceCents, 0))
        : s.status === "void"
          ? eq(giftCards.status, "void")
          : undefined;
  const words = s.q.split(/\s+/).filter(Boolean);
  const match = term
    ? or(
        ilike(giftCards.code, `%${term}%`),
        words.length ? and(...words.map((w) => or(ilike(customers.firstName, `${w}%`), ilike(customers.lastName, `${w}%`)))) : undefined,
      )
    : undefined;
  const where = and(status, term ? or(and(match, issuedHere(v)), eq(giftCards.code, term)) : issuedHere(v));
  const rows = await db
    .select({ g: giftCards, shop: shops.name, first: customers.firstName, last: customers.lastName })
    .from(giftCards)
    .leftJoin(shops, eq(shops.id, giftCards.issuedShopId))
    .leftJoin(customers, eq(customers.id, giftCards.customerId))
    .where(where)
    .orderBy(desc(giftCards.createdAt))
    .limit(60);
  const last = rows.length
    ? await db
        .select({ id: giftCardLedger.giftCardId, at: sql<Date>`max(${giftCardLedger.createdAt})` })
        .from(giftCardLedger)
        .where(and(inArray(giftCardLedger.giftCardId, rows.map((r) => r.g.id)), eq(giftCardLedger.kind, "redeem")))
        .groupBy(giftCardLedger.giftCardId)
    : [];
  return rows.map(({ g, shop, first, last: lastName }) => {
    const mine = manages(v, g);
    return {
      id: g.id,
      code: g.code,
      initialCents: g.initialCents,
      balanceCents: g.balanceCents,
      status: g.status,
      source: g.source,
      issuedAt: mine ? (shop ?? "—") : OTHER_SHOP,
      client: mine && first ? `${first} ${lastName ?? ""}`.trim() : null,
      lastUsedAt: last.find((l) => l.id === g.id)?.at ?? null,
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
      manageable: mine,
    };
  });
}

/** One card and its history. A card issued elsewhere shows only where it was used at the person's own shops. */
export async function giftCardDetail(v: GiftCardViewer, by: { id?: string; code?: string }) {
  const g = by.code
    ? await db.query.giftCards.findFirst({ where: eq(giftCards.code, by.code.trim().toUpperCase()) })
    : by.id
      ? await db.query.giftCards.findFirst({ where: eq(giftCards.id, by.id) })
      : undefined;
  if (!g) return null;
  const mine = manages(v, g);
  if (!mine && !by.code) return null;
  const [shop] = g.issuedShopId ? await db.select({ name: shops.name }).from(shops).where(eq(shops.id, g.issuedShopId)) : [];
  const [client] = mine && g.customerId ? await db.select({ id: customers.id, first: customers.firstName, last: customers.lastName }).from(customers).where(eq(customers.id, g.customerId)) : [];
  const ledger = await db
    .select({ l: giftCardLedger, saleShopId: sales.shopId, saleNumber: sales.number, shop: shops.name })
    .from(giftCardLedger)
    .leftJoin(sales, eq(sales.id, giftCardLedger.saleId))
    .leftJoin(shops, eq(shops.id, sales.shopId))
    .where(eq(giftCardLedger.giftCardId, g.id))
    .orderBy(asc(giftCardLedger.createdAt));
  return {
    id: g.id,
    code: g.code,
    status: g.status,
    source: g.source,
    initialCents: g.initialCents,
    balanceCents: g.balanceCents,
    expiresAt: g.expiresAt,
    createdAt: g.createdAt,
    issuedAt: mine ? (shop?.name ?? "—") : OTHER_SHOP,
    client: client ? { id: client.id, name: `${client.first} ${client.last ?? ""}`.trim() } : null,
    manageable: mine,
    ledger: ledger.map(({ l, saleShopId, saleNumber, shop: at }) => {
      const here = v.brandWide || !saleShopId || hasShop(v, saleShopId);
      return { id: l.id, kind: l.kind, deltaCents: l.deltaCents, at: l.createdAt, saleId: here ? l.saleId : null, saleNumber: here ? saleNumber : null, shop: saleShopId ? (here ? at : OTHER_SHOP) : null };
    }),
  };
}

/** A comp or promotional card issued without a sale, e.g. service recovery. */
export async function issueCompCard(actor: Actor, v: GiftCardViewer, raw: z.input<typeof IssueCompInput>) {
  const c = IssueCompInput.parse(raw);
  if (!hasShop(v, c.shopId)) throw forbidden("That shop is outside your access");
  return db.transaction(async (tx) => {
    const [g] = await tx
      .insert(giftCards)
      .values({ code: giftCardCode(), initialCents: c.amountCents, balanceCents: c.amountCents, issuedShopId: c.shopId, customerId: c.customerId ?? null, source: "promo" })
      .returning();
    await tx.insert(giftCardLedger).values({ giftCardId: g.id, deltaCents: c.amountCents, kind: "issue", staffId: actor.staffId ?? null });
    await audit(actor, "giftcard.issue_comp", "gift_card", g.id, { amountCents: c.amountCents, note: c.reason }, c.shopId, tx);
    return { id: g.id, code: g.code };
  });
}

/** Comp value added to a live card without a sale. A paid reload goes through checkout. */
export async function compReload(actor: Actor, v: GiftCardViewer, raw: z.input<typeof CompReloadInput>) {
  const c = CompReloadInput.parse(raw);
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(giftCards).where(eq(giftCards.id, c.id)).for("update");
    if (!g) throw notFound("Gift card");
    if (!manages(v, g)) throw forbidden("That gift card was issued outside your shops");
    const problem = reloadProblem(g, { qty: 1, now: new Date(), payingWith: null, amountCents: c.amountCents });
    if (problem) throw new AppError("bad_request", problem);
    const balanceCents = g.balanceCents + c.amountCents;
    await tx.update(giftCards).set({ balanceCents }).where(eq(giftCards.id, g.id));
    await tx.insert(giftCardLedger).values({ giftCardId: g.id, deltaCents: c.amountCents, kind: "comp", staffId: actor.staffId ?? null });
    await audit(actor, "giftcard.comp_reload", "gift_card", g.id, { amountCents: c.amountCents, balanceCents, note: c.reason }, g.issuedShopId, tx);
    return { balanceCents };
  });
}

export async function voidGiftCard(actor: Actor, v: GiftCardViewer, raw: z.input<typeof VoidInput>) {
  const c = VoidInput.parse(raw);
  await db.transaction(async (tx) => {
    const [g] = await tx.select().from(giftCards).where(eq(giftCards.id, c.id)).for("update");
    if (!g) throw notFound("Gift card");
    if (!manages(v, g)) throw forbidden("That gift card was issued outside your shops");
    if (g.status === "void") throw new AppError("conflict", "That gift card is already voided");
    await tx.update(giftCards).set({ status: "void", balanceCents: 0 }).where(eq(giftCards.id, g.id));
    await tx.insert(giftCardLedger).values({ giftCardId: g.id, deltaCents: -g.balanceCents, kind: "void", staffId: actor.staffId ?? null });
    await audit(actor, "giftcard.void", "gift_card", g.id, { reason: c.reason, balanceCents: g.balanceCents }, g.issuedShopId, tx);
  });
}

export const StartReloadInput = z.object({ shopId: z.uuid(), id: z.uuid(), amountCents: z.number().int().min(500, "Reloads are at least $5").max(50_000, "Reloads are at most $500") });

/** Opens a walk-in ticket at the shop with the reload on it, ready to be paid. Any card can be reloaded anywhere. */
export async function startReloadTicket(actor: Actor, v: GiftCardViewer, raw: z.input<typeof StartReloadInput>) {
  const c = StartReloadInput.parse(raw);
  if (!hasShop(v, c.shopId)) throw forbidden("That shop is outside your access");
  const g = await db.query.giftCards.findFirst({ where: eq(giftCards.id, c.id) });
  const problem = reloadProblem(g, { qty: 1, now: new Date(), payingWith: null, amountCents: c.amountCents });
  if (problem) throw new AppError("bad_request", problem);
  const sale = await openBlankSale(c.shopId, actor);
  await db.insert(saleItems).values({
    saleId: sale.id,
    kind: "gift_card",
    refId: g!.id,
    name: `Gift card reload ${g!.code} ${formatCents(c.amountCents)}`,
    qty: 1,
    unitPriceCents: c.amountCents,
    grossCents: c.amountCents,
    netCents: c.amountCents,
  });
  if (g!.customerId && manages(v, g!)) await db.update(sales).set({ customerId: g!.customerId }).where(eq(sales.id, sale.id));
  return { saleId: sale.id };
}
