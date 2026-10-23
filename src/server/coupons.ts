/**
 * Coupons at checkout and online booking: finding a code (a shared promo code or a client's
 * single-use code), checking it against the coupon's limits, the coupons a ticket starts with (held
 * from the online booking, or applied automatically because the client has one), and recording each
 * redemption so limits, the report and refunds all read the same rows.
 */
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, DBorTx, Tx } from "@/db";
import { appointmentCoupons, appointments, couponCodes, couponRedemptions, marketingCampaigns, marketingSends, products, promoCodes, services, shops } from "@/db/schema";
import { CouponRule, couponProblem, couponSummary, type CodeMode, type CouponType, type FreeItemKind } from "@/domain/coupons";
import type { DiscountTarget } from "@/domain/checkout";
import { formatDate, todayLocal } from "@/lib/time";
import { AppError } from "./errors";
import { loadMarketingSettings } from "./marketing/settings";

type Promo = typeof promoCodes.$inferSelect;
type Issued = typeof couponCodes.$inferSelect;

const norm = (code: string) => code.trim().toUpperCase();

/** The coupon behind a code: a shared code, or a client's single-use code and its coupon. */
export async function findCoupon(code: string, tx: DBorTx = db): Promise<{ promo: Promo; issued: Issued | null } | null> {
  const c = norm(code);
  if (!c) return null;
  const [shared] = await tx.select().from(promoCodes).where(and(eq(promoCodes.code, c), eq(promoCodes.codeMode, "shared")));
  if (shared) return { promo: shared, issued: null };
  const [hit] = await tx.select({ promo: promoCodes, issued: couponCodes }).from(couponCodes).innerJoin(promoCodes, eq(promoCodes.id, couponCodes.promoId)).where(eq(couponCodes.code, c));
  return hit ?? null;
}

async function freeItemName(p: Pick<Promo, "freeItemKind" | "freeItemId">, tx: DBorTx): Promise<string> {
  if (!p.freeItemId) return "item";
  if (p.freeItemKind === "product") {
    const [r] = await tx.select({ name: products.name, brand: products.brand }).from(products).where(eq(products.id, p.freeItemId));
    return r ? `${r.brand} ${r.name}` : "product";
  }
  const [r] = await tx.select({ name: services.name }).from(services).where(eq(services.id, p.freeItemId));
  return r?.name ?? "add-on";
}

export async function ruleOf(p: Promo, code: string, via: CouponRule["via"], tx: DBorTx = db): Promise<CouponRule> {
  const freeItem = p.type === "free_item" && p.freeItemId && p.freeItemKind ? { kind: p.freeItemKind as FreeItemKind, id: p.freeItemId, name: await freeItemName(p, tx) } : null;
  const rule: CouponRule = {
    promoId: p.id,
    code: norm(code),
    label: "",
    type: p.type as CouponType,
    value: p.value,
    appliesTo: (p.appliesTo as DiscountTarget) ?? "services",
    serviceIds: p.serviceIds ?? [],
    productIds: p.productIds ?? [],
    freeItem,
    minSpendCents: p.minSpendCents,
    stackable: p.stackable,
    via,
  };
  rule.label = `Coupon ${rule.code}: ${couponSummary(rule)}`;
  return rule;
}

/** Earlier visits by the client (each location and day once), not counting this ticket or its appointment. */
export async function priorVisits(customerId: string, o: { saleId?: string | null; appointmentId?: string | null } = {}, tx: DBorTx = db): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select shop_id, business_date as d from sales
        where customer_id = ${customerId} and status in ('paid', 'partially_refunded', 'refunded') and id is distinct from ${o.saleId ?? null}::uuid
          and appointment_id is distinct from ${o.appointmentId ?? null}::uuid
      union
      select shop_id, (starts_at at time zone 'America/Chicago')::date from appointments
        where customer_id = ${customerId} and status = 'completed' and id is distinct from ${o.appointmentId ?? null}::uuid
    ) v`);
  return Number(r[0]?.n ?? 0);
}

export async function customerUses(customerId: string, promoId: string, tx: DBorTx = db, excludeSaleId?: string | null): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(couponRedemptions)
    .where(and(eq(couponRedemptions.customerId, customerId), eq(couponRedemptions.promoId, promoId), isNull(couponRedemptions.reversedAt), excludeSaleId ? sql`${couponRedemptions.saleId} <> ${excludeSaleId}` : undefined));
  return r?.n ?? 0;
}

const limitsOf = (p: Promo) => ({ ...p, codeMode: p.codeMode as CodeMode, shopIds: p.shopIds ?? [] });

export interface CouponWhere {
  shopId: string;
  /** Undefined: not known yet (online booking). Null: no client on the ticket. */
  customerId?: string | null;
  saleId?: string | null;
  appointmentId?: string | null;
  today?: string;
}

/** Why this coupon can't be used here, or null. */
export async function problemFor(found: { promo: Promo; issued: Issued | null }, w: CouponWhere, tx: DBorTx = db): Promise<string | null> {
  const known = typeof w.customerId === "string";
  const p = found.promo;
  const needsHistory = known && (p.firstVisitOnly || p.maxPerCustomer !== null);
  return couponProblem(limitsOf(p), {
    today: w.today ?? todayLocal(),
    shopId: w.shopId,
    customerId: w.customerId,
    priorVisits: needsHistory && p.firstVisitOnly ? await priorVisits(w.customerId!, w, tx) : 0,
    customerUses: needsHistory && p.maxPerCustomer !== null ? await customerUses(w.customerId!, p.id, tx, w.saleId) : 0,
    issued: found.issued ? { customerId: found.issued.customerId, expiresOn: found.issued.expiresOn, redeemed: !!found.issued.redeemedAt && found.issued.saleId !== w.saleId } : null,
  });
}

/** A code typed at the POS or on the booking page, checked and turned into its rule. */
export async function resolveCoupon(code: string, w: CouponWhere, via: CouponRule["via"] = "code", tx: DBorTx = db): Promise<CouponRule> {
  const found = await findCoupon(code, tx);
  if (!found) throw new AppError("bad_request", "Coupon code not found");
  const problem = await problemFor(found, w, tx);
  if (problem) throw new AppError("bad_request", problem);
  return ruleOf(found.promo, code, via, tx);
}

/** Coupons set to apply automatically that this client can use here today. */
export async function autoCoupons(w: CouponWhere & { customerId: string }, tx: DBorTx = db): Promise<CouponRule[]> {
  const list = await tx.select().from(promoCodes).where(and(eq(promoCodes.active, true), eq(promoCodes.autoApply, true), eq(promoCodes.codeMode, "shared")));
  const out: CouponRule[] = [];
  for (const p of list) if (!(await problemFor({ promo: p, issued: null }, w, tx))) out.push(await ruleOf(p, p.code, "auto", tx));
  return out;
}

/** What a ticket starts with: the coupon held from its online booking, and the ones that apply automatically. Problems with the held one are shown, not thrown. */
export async function ticketCoupons(sale: { id: string; shopId: string; customerId: string | null; appointmentId: string | null }, tx: DBorTx = db) {
  const w: CouponWhere = { shopId: sale.shopId, customerId: sale.customerId, saleId: sale.id, appointmentId: sale.appointmentId };
  let held: { rule: CouponRule | null; code: string; problem: string | null } | null = null;
  if (sale.appointmentId) {
    const [h] = await tx.select().from(appointmentCoupons).where(eq(appointmentCoupons.appointmentId, sale.appointmentId));
    if (h) {
      try {
        held = { rule: await resolveCoupon(h.code, w, "booking", tx), code: h.code, problem: null };
      } catch (e) {
        held = { rule: null, code: h.code, problem: (e as Error).message };
      }
    }
  }
  const auto = sale.customerId ? (await autoCoupons({ ...w, customerId: sale.customerId }, tx)).filter((r) => r.promoId !== held?.rule?.promoId) : [];
  return { held, auto };
}

/** The campaign a redemption counts toward: the one that issued the code, or the latest send of a campaign with this coupon to this client within the attribution window. */
async function campaignFor(tx: DBorTx, promoId: string, customerId: string | null, issued: Issued | null, now: Date): Promise<string | null> {
  if (issued?.campaignId) return issued.campaignId;
  if (!customerId) return null;
  const s = await loadMarketingSettings(tx);
  const [r] = await tx
    .select({ id: marketingSends.campaignId })
    .from(marketingSends)
    .innerJoin(marketingCampaigns, eq(marketingCampaigns.id, marketingSends.campaignId))
    .where(and(eq(marketingCampaigns.promoId, promoId), eq(marketingSends.customerId, customerId), eq(marketingSends.status, "queued"), gte(marketingSends.createdAt, new Date(now.getTime() - s.attributionDays * 86_400_000))))
    .orderBy(desc(marketingSends.createdAt))
    .limit(1);
  return r?.id ?? null;
}

/**
 * Inside checkout's transaction: lock each coupon, check its limits again (another ticket may have
 * used the last one), and record the redemption. The hold from the online booking is used up.
 */
export async function redeemCoupons(
  tx: Tx,
  used: { rule: CouponRule; discountCents: number }[],
  sale: { id: string; shopId: string; customerId: string | null; staffId: string | null; appointmentId: string | null },
  now: Date,
) {
  for (const u of used) {
    const [p] = await tx.select().from(promoCodes).where(eq(promoCodes.id, u.rule.promoId)).for("update");
    let issued: Issued | null = null;
    if (p.codeMode === "unique") {
      [issued] = await tx.select().from(couponCodes).where(eq(couponCodes.code, u.rule.code)).for("update");
    }
    const problem = await problemFor({ promo: p, issued }, { shopId: sale.shopId, customerId: sale.customerId, saleId: sale.id, appointmentId: sale.appointmentId, today: todayLocal(now) }, tx);
    if (problem) throw new AppError("conflict", `${u.rule.code}: ${problem}`);
    await tx.update(promoCodes).set({ redemptions: p.redemptions + 1 }).where(eq(promoCodes.id, p.id));
    if (issued) await tx.update(couponCodes).set({ redeemedAt: now, saleId: sale.id }).where(eq(couponCodes.id, issued.id));
    await tx.insert(couponRedemptions).values({
      promoId: p.id,
      couponCodeId: issued?.id ?? null,
      saleId: sale.id,
      customerId: sale.customerId,
      shopId: sale.shopId,
      staffId: sale.staffId,
      campaignId: await campaignFor(tx, p.id, sale.customerId, issued, now),
      discountCents: u.discountCents,
      via: u.rule.via,
      createdAt: now,
    });
  }
  if (sale.appointmentId) await tx.delete(appointmentCoupons).where(eq(appointmentCoupons.appointmentId, sale.appointmentId));
}

/** A full refund or a void gives the coupons back: the count goes down and a single-use code works again. Returns how many were reversed. */
export async function reverseCoupons(tx: Tx, saleId: string, now: Date): Promise<number> {
  const rows = await tx.select().from(couponRedemptions).where(and(eq(couponRedemptions.saleId, saleId), isNull(couponRedemptions.reversedAt)));
  for (const r of rows) {
    await tx.update(couponRedemptions).set({ reversedAt: now }).where(eq(couponRedemptions.id, r.id));
    await tx.update(promoCodes).set({ redemptions: sql`greatest(${promoCodes.redemptions} - 1, 0)` }).where(eq(promoCodes.id, r.promoId));
    if (r.couponCodeId) await tx.update(couponCodes).set({ redeemedAt: null, saleId: null }).where(eq(couponCodes.id, r.couponCodeId));
  }
  return rows.length;
}

// ───────────────────────────── Online booking ─────────────────────────────

export interface BookingCouponView {
  code: string;
  summary: string;
  /** Free add-ons are added to the booking for the client. */
  freeAddonId: string | null;
  note: string | null;
}

async function bookingView(rule: CouponRule, found: { promo: Promo; issued: Issued | null }): Promise<BookingCouponView> {
  const notes: string[] = [];
  const ends = found.issued?.expiresOn ?? found.promo.endsOn;
  if (ends) notes.push(`Good through ${formatDate(ends, "MMM d")}.`);
  if (found.promo.firstVisitOnly) notes.push("For first visits.");
  if (found.promo.minSpendCents) notes.push("Minimum spend applies.");
  notes.push("Taken off at checkout.");
  return { code: rule.code, summary: couponSummary(rule), freeAddonId: rule.freeItem?.kind === "addon" ? rule.freeItem.id : null, note: notes.join(" ") };
}

/** The booking page checks a code before booking. The client isn't known yet, so their limits are checked again at checkout. */
export async function checkBookingCoupon(shopSlug: string, code: string): Promise<BookingCouponView> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.slug, shopSlug), columns: { id: true } });
  if (!shop) throw new AppError("not_found", "Shop not found");
  const found = await findCoupon(code);
  if (!found) throw new AppError("bad_request", "That coupon code wasn't found");
  const problem = await problemFor(found, { shopId: shop.id });
  if (problem) throw new AppError("bad_request", problem);
  return bookingView(await ruleOf(found.promo, code, "booking"), found);
}

/** How long after booking the confirmation page may attach a coupon. */
const HOLD_WINDOW_MS = 30 * 60_000;

/**
 * Attach a coupon to a booking that was just made, by its appointment code (the client's only
 * credential). Checked with the booked client now; checkout checks again and applies it.
 */
export async function holdBookingCoupon(appointmentCode: string, code: string, now = new Date()): Promise<BookingCouponView> {
  const [a] = await db.select().from(appointments).where(eq(appointments.code, appointmentCode.trim().toUpperCase()));
  if (!a || !["booked", "confirmed"].includes(a.status) || now.getTime() - a.createdAt.getTime() > HOLD_WINDOW_MS) throw new AppError("bad_request", "Add the coupon when you book, or show it at checkout");
  const found = await findCoupon(code);
  if (!found) throw new AppError("bad_request", "That coupon code wasn't found");
  const problem = await problemFor(found, { shopId: a.shopId, customerId: a.customerId, appointmentId: a.id });
  if (problem) throw new AppError("bad_request", problem);
  const c = norm(code);
  await db.insert(appointmentCoupons).values({ appointmentId: a.id, promoId: found.promo.id, code: c }).onConflictDoUpdate({ target: appointmentCoupons.appointmentId, set: { promoId: found.promo.id, code: c, createdAt: now } });
  return bookingView(await ruleOf(found.promo, code, "booking"), found);
}

/** Held coupons for these appointments, for the calendar and the ticket. */
export async function heldCoupons(appointmentIds: string[]) {
  if (!appointmentIds.length) return new Map<string, string>();
  const rows = await db.select({ id: appointmentCoupons.appointmentId, code: appointmentCoupons.code }).from(appointmentCoupons).where(inArray(appointmentCoupons.appointmentId, appointmentIds));
  return new Map(rows.map((r) => [r.id, r.code]));
}
