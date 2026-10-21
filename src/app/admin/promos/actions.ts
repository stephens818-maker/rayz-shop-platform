"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { giftCardLedger, giftCards, promoCodes } from "@/db/schema";
import { giftCardCode } from "@/lib/ids";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";

const Promo = z.object({
  code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9-]+$/, "Letters, numbers and dashes only"),
  description: z.string().trim().nullable(),
  type: z.enum(["percent", "amount"]),
  value: z.number().int().positive(),
  appliesTo: z.enum(["services", "products", "all"]),
  shopId: z.string().uuid().nullable(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  maxRedemptions: z.number().int().positive().nullable(),
});

export async function createPromoAction(raw: z.input<typeof Promo>) {
  return safe(async () => {
    const ctx = await authorize("promos.manage");
    const p = Promo.parse(raw);
    if (p.type === "percent" && p.value > 100) throw new AppError("bad_request", "Percent can't exceed 100");
    if (!p.shopId && !ctx.brandWide) throw forbidden("A promo for every shop needs access to every shop. Pick one of your shops.");
    if (p.shopId) assertShopAccess(ctx, p.shopId);
    const code = p.code.toUpperCase();
    if (await db.query.promoCodes.findFirst({ where: eq(promoCodes.code, code) })) throw new AppError("conflict", "That code already exists");
    const [row] = await db.insert(promoCodes).values({ ...p, code, startsOn: p.startsOn || null, endsOn: p.endsOn || null }).returning();
    await audit(ctx.actor, "promo.create", "promo", row.id, p, p.shopId);
    revalidatePath("/admin/promos");
    return null;
  });
}

export async function togglePromoAction(id: string, active: boolean) {
  return safe(async () => {
    const ctx = await authorize("promos.manage");
    const p = await db.query.promoCodes.findFirst({ where: eq(promoCodes.id, id) });
    if (!p) throw notFound("Promo");
    if (!ctx.brandWide && (!p.shopId || !ctx.shopIds.includes(p.shopId))) throw forbidden("That promo covers shops outside your access");
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
