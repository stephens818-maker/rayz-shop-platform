import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { cashDrawerMoves, cashDrawers, payments, refunds, sales, shops, staff, tipPayouts } from "@/db/schema";
import { DrawerEvent, DrawerLine, drawerTimeline, moveProblem, movesOut, openingProblem } from "@/domain/drawer";
import { LocalDate } from "@/lib/time";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";

/** What a shop's drawer opens with when nobody counts something else. */
export async function defaultOpening(shopId: string, tx: DBorTx = db) {
  const shop = await tx.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { drawerOpeningCents: true } });
  if (!shop) throw notFound("Shop");
  return shop.drawerOpeningCents;
}

/** Opens the day's drawer with what was counted into it. Once per day; a closed drawer stays closed. */
export async function openDrawer(input: { shopId: string; date: LocalDate; openingCents: number; actor: Actor }, now = new Date()) {
  const problem = openingProblem(input.openingCents);
  if (problem) throw new AppError("bad_request", problem);
  const existing = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, input.shopId), eq(cashDrawers.businessDate, input.date)) });
  if (existing?.closedAt) throw new AppError("conflict", "The drawer is already closed for this day");
  if (existing?.openedAt) throw new AppError("conflict", "The drawer is already open for this day");
  const values = { openingFloatCents: input.openingCents, openedBy: input.actor.staffId ?? null, openedAt: now };
  if (existing) await db.update(cashDrawers).set(values).where(eq(cashDrawers.id, existing.id));
  else await db.insert(cashDrawers).values({ shopId: input.shopId, businessDate: input.date, ...values });
  const usual = await defaultOpening(input.shopId);
  await audit(input.actor, "drawer.open", "cash_drawer", `${input.shopId}:${input.date}`, { openingCents: input.openingCents, defaultCents: usual }, input.shopId);
}

/** Cash put in (change from the bank) or taken out (supplies, a delivery) during the day, with what it was for. */
export async function recordDrawerMove(input: { shopId: string; date: LocalDate; kind: "paid_in" | "paid_out"; amountCents: number; reason: string; actor: Actor }, now = new Date()) {
  const problem = moveProblem(input);
  if (problem) throw new AppError("bad_request", problem);
  const drawer = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, input.shopId), eq(cashDrawers.businessDate, input.date)) });
  if (drawer?.closedAt) throw new AppError("conflict", "The drawer is closed for this day");
  const [row] = await db
    .insert(cashDrawerMoves)
    .values({ shopId: input.shopId, businessDate: input.date, kind: input.kind, amountCents: input.amountCents, reason: input.reason.trim(), staffId: input.actor.staffId ?? null, createdAt: now })
    .returning({ id: cashDrawerMoves.id });
  await audit(input.actor, `drawer.${input.kind}`, "cash_drawer", `${input.shopId}:${input.date}`, { amountCents: input.amountCents, reason: input.reason.trim() }, input.shopId);
  return row.id;
}

/** The drawer opened with no sale (to make change): nothing moves, but who opened it and when is kept. */
export async function openDrawerNoSale(input: { shopId: string; date: LocalDate; reason?: string | null; actor: Actor }, now = new Date()) {
  const drawer = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, input.shopId), eq(cashDrawers.businessDate, input.date)) });
  if (!drawer?.openedAt) throw new AppError("conflict", "Open the drawer for the day first");
  if (drawer.closedAt) throw new AppError("conflict", "The drawer is closed for this day");
  const reason = input.reason?.trim().slice(0, 200) || "No sale";
  const [row] = await db
    .insert(cashDrawerMoves)
    .values({ shopId: input.shopId, businessDate: input.date, kind: "no_sale", amountCents: 0, reason, staffId: input.actor.staffId ?? null, createdAt: now })
    .returning({ id: cashDrawerMoves.id });
  await audit(input.actor, "drawer.no_sale", "cash_drawer", `${input.shopId}:${input.date}`, { reason }, input.shopId);
  return row.id;
}

export async function drawerMoves(shopId: string, date: LocalDate, tx: DBorTx = db) {
  return tx
    .select({ m: cashDrawerMoves, by: staff.displayLabel })
    .from(cashDrawerMoves)
    .leftJoin(staff, eq(staff.id, cashDrawerMoves.staffId))
    .where(and(eq(cashDrawerMoves.shopId, shopId), eq(cashDrawerMoves.businessDate, date)))
    .orderBy(asc(cashDrawerMoves.createdAt));
}

/** Paid-outs less paid-ins for the day. */
export async function movesOutCents(shopId: string, date: LocalDate, tx: DBorTx = db) {
  return movesOut((await drawerMoves(shopId, date, tx)).map((r) => r.m));
}

/**
 * The drawer's balance through the day: opened, every cash sale, refund, tip payout and paid
 * in or out, and the close. Card payments never touch the drawer, so they aren't here.
 */
export async function drawerBalanceHistory(shopId: string, date: LocalDate): Promise<DrawerLine[]> {
  const [drawer, cash, cashRefunds, tips, moves] = await Promise.all([
    db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, shopId), eq(cashDrawers.businessDate, date)) }),
    db
      .select({ at: payments.createdAt, cents: payments.amountCents, number: sales.number, by: staff.displayLabel })
      .from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId))
      .leftJoin(staff, eq(staff.id, sales.staffId))
      .where(and(eq(payments.shopId, shopId), eq(payments.businessDate, date), eq(payments.method, "cash"), sql`${sales.status} <> 'voided'`, eq(sales.isImported, false))),
    db
      .select({ at: refunds.createdAt, cents: refunds.amountCents, number: sales.number })
      .from(refunds)
      .innerJoin(sales, eq(sales.id, refunds.saleId))
      .where(and(eq(refunds.shopId, shopId), eq(refunds.businessDate, date), eq(refunds.method, "cash"), eq(refunds.kind, "refund"))),
    db
      .select({ at: tipPayouts.acknowledgedAt, cents: tipPayouts.netCents, name: staff.displayLabel })
      .from(tipPayouts)
      .innerJoin(staff, eq(staff.id, tipPayouts.staffId))
      .where(and(eq(tipPayouts.shopId, shopId), eq(tipPayouts.method, "cash"), eq(tipPayouts.status, "paid"), eq(tipPayouts.drawerDate, date))),
    drawerMoves(shopId, date),
  ]);
  const names = drawer ? await labels([drawer.openedBy, drawer.closedBy]) : new Map<string, string>();
  const events: DrawerEvent[] = [
    ...(drawer?.openedAt ? [{ kind: "open" as const, at: drawer.openedAt, cents: drawer.openingFloatCents, by: names.get(drawer.openedBy ?? "") ?? null }] : []),
    ...cash.map((c) => ({ kind: "sale" as const, at: c.at, cents: c.cents, label: `Ticket #${c.number}`, by: c.by })),
    ...cashRefunds.map((r) => ({ kind: "refund" as const, at: r.at, cents: r.cents, label: `Ticket #${r.number}` })),
    ...tips.map((t) => ({ kind: "tip_payout" as const, at: t.at ?? new Date(`${date}T23:59:00`), cents: t.cents, label: t.name })),
    ...moves.map(({ m, by }) => ({ kind: m.kind, at: m.createdAt, cents: m.amountCents, label: m.reason, by })),
    ...(drawer?.closedAt ? [{ kind: "close" as const, at: drawer.closedAt, cents: drawer.countedCents ?? 0, by: names.get(drawer.closedBy ?? "") ?? null }] : []),
  ];
  const start = drawer?.openingFloatCents ?? (await defaultOpening(shopId));
  return drawerTimeline(events, start);
}

async function labels(ids: (string | null)[]) {
  const want = ids.filter((x): x is string => !!x);
  if (!want.length) return new Map<string, string>();
  const rows = await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, want));
  return new Map(rows.map((r) => [r.id, r.label]));
}

export async function saveDrawerOpening(shopId: string, cents: number, actor: Actor) {
  const problem = openingProblem(cents);
  if (problem) throw new AppError("bad_request", problem);
  const before = await defaultOpening(shopId);
  await db.update(shops).set({ drawerOpeningCents: cents }).where(eq(shops.id, shopId));
  await audit(actor, "shop.drawer_opening", "shop", shopId, { before, after: cents }, shopId);
}
