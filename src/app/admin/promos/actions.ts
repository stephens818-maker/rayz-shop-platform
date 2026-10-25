"use server";

import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { couponCodes, giftCardLedger, giftCards, products, promoCodes, services } from "@/db/schema";
import { CouponInput } from "@/domain/coupons";
import { giftCardCode } from "@/lib/ids";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { scopeOf } from "./coupon-input";

type Promo = typeof promoCodes.$inferSelect;

function assertMayManage(ctx: StaffContext, p: Pick<Promo, "shopId" | "shopIds">) {
  const scope = scopeOf(p);
  if (!ctx.brandWide && (!scope.length || scope.some((s) => !ctx.shopIds.includes(s)))) throw forbidden("That promo covers shops outside your access");
}

/** Creates a coupon (id null) or changes one. A code that's been redeemed or issued keeps its code and kind of codes. */
export async function saveCouponAction(id: string | null, raw: unknown) {
  return safe(async () => {
    const ctx = await authorize("promos.manage");
    const r = CouponInput.safeParse(raw);
    if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the coupon");
    const c = r.data;
    if (!c.shopIds.length && !ctx.brandWide) throw forbidden("A coupon for every shop needs access to every shop. Pick your shops.");
    for (const s of c.shopIds) assertShopAccess(ctx, s);
    const before = id ? await db.query.promoCodes.findFirst({ where: eq(promoCodes.id, id) }) : null;
    if (id && !before) throw notFound("Promo");
    if (before) assertMayManage(ctx, before);
    const clash = await db.query.promoCodes.findFirst({ where: eq(promoCodes.code, c.code) });
    if (clash && clash.id !== id) throw new AppError("conflict", "That code already exists");
    if (before && (before.code !== c.code || before.codeMode !== c.codeMode)) {
      const [issued] = await db.select({ n: count() }).from(couponCodes).where(eq(couponCodes.promoId, before.id));
      if (before.redemptions > 0 || issued.n > 0) throw new AppError("conflict", "This coupon has been used or sent, so its code and kind of codes stay as they are. Make a new coupon instead.");
    }
    if (c.type === "free_item") {
      const ok =
        c.freeItemKind === "product"
          ? await db.query.products.findFirst({ where: eq(products.id, c.freeItemId!) })
          : await db.query.services.findFirst({ where: and(eq(services.id, c.freeItemId!), eq(services.kind, c.freeItemKind === "addon" ? "addon" : "service")) });
      if (!ok) throw notFound("Free item");
    }
    const row = {
      code: c.code,
      description: c.description || null,
      type: c.type,
      value: c.type === "free_item" ? 0 : c.value,
      appliesTo: c.appliesTo,
      serviceIds: c.serviceIds,
      productIds: c.productIds,
      freeItemKind: c.type === "free_item" ? (c.freeItemKind ?? null) : null,
      freeItemId: c.type === "free_item" ? (c.freeItemId ?? null) : null,
      shopIds: c.shopIds,
      shopId: c.shopIds.length === 1 ? c.shopIds[0] : null,
      minSpendCents: c.minSpendCents || null,
      startsOn: c.startsOn || null,
      endsOn: c.endsOn || null,
      maxRedemptions: c.maxRedemptions ?? null,
      maxPerCustomer: c.maxPerCustomer ?? null,
      codeMode: c.codeMode,
      validDays: c.codeMode === "unique" ? (c.validDays ?? null) : null,
      firstVisitOnly: c.firstVisitOnly,
      stackable: c.stackable,
      autoApply: c.autoApply,
      daysOfWeek: [...new Set(c.daysOfWeek)].sort((a, b) => a - b),
      timeFrom: c.timeFrom || null,
      timeTo: c.timeTo || null,
    };
    const shopId = c.shopIds.length === 1 ? c.shopIds[0] : null;
    if (before) {
      await db.update(promoCodes).set(row).where(eq(promoCodes.id, before.id));
      await audit(ctx.actor, "promo.update", "promo", before.id, row, shopId);
    } else {
      const [p] = await db.insert(promoCodes).values(row).returning({ id: promoCodes.id });
      await audit(ctx.actor, "promo.create", "promo", p.id, row, shopId);
    }
    revalidatePath("/admin/promos");
    return null;
  });
}

export async function togglePromoAction(id: string, active: boolean) {
  return safe(async () => {
    const ctx = await authorize("promos.manage");
    const p = await db.query.promoCodes.findFirst({ where: eq(promoCodes.id, id) });
    if (!p) throw notFound("Promo");
    assertMayManage(ctx, p);
    await db.update(promoCodes).set({ active }).where(eq(promoCodes.id, id));
    await audit(ctx.actor, active ? "promo.enable" : "promo.disable", "promo", id, {}, p.shopId);
    revalidatePath("/admin/promos");
    return null;
  });
}

/** Comp / promotional gift card issued without a sale (e.g. service recovery). */
export async function issueGiftCardAction(shopId: string, amountCents: number, note: string) {
  return safe(async () => {
    const ctx = await authorize("giftcards.issue");
    assertShopAccess(ctx, shopId);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError("bad_request", "Enter an amount");
    if (!note.trim()) throw new AppError("bad_request", "Add a reason");
    const code = giftCardCode();
    const g = await db.transaction(async (tx) => {
      const [g] = await tx.insert(giftCards).values({ code, initialCents: amountCents, balanceCents: amountCents, issuedShopId: shopId, source: "promo" }).returning();
      await tx.insert(giftCardLedger).values({ giftCardId: g.id, deltaCents: amountCents, kind: "issue", staffId: ctx.staff.id });
      await audit(ctx.actor, "giftcard.issue_comp", "gift_card", g.id, { amountCents, note }, shopId, tx);
      return g;
    });
    revalidatePath("/admin/promos");
    return { code: g.code };
  });
}

export async function voidGiftCardAction(id: string, reason: string) {
  return safe(async () => {
    const ctx = await authorize("giftcards.void");
    if (!reason.trim()) throw new AppError("bad_request", "Add a reason");
    const g = await db.query.giftCards.findFirst({ where: eq(giftCards.id, id) });
    if (!g) throw notFound("Gift card");
    if (!ctx.brandWide && (!g.issuedShopId || !ctx.shopIds.includes(g.issuedShopId))) throw forbidden("That gift card was issued outside your shops");
    await db.transaction(async (tx) => {
      await tx.update(giftCards).set({ status: "void", balanceCents: 0 }).where(eq(giftCards.id, id));
      await tx.insert(giftCardLedger).values({ giftCardId: id, deltaCents: -g.balanceCents, kind: "void", staffId: ctx.staff.id });
      await audit(ctx.actor, "giftcard.void", "gift_card", id, { reason, balanceCents: g.balanceCents }, g.issuedShopId, tx);
    });
    revalidatePath("/admin/promos");
    return null;
  });
}
