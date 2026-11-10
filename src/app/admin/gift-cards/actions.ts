"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CompReloadInput, IssueCompInput } from "@/domain/gift-cards";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { StartReloadInput, compReload, issueCompCard, startReloadTicket, voidGiftCard } from "@/server/gift-cards";

const refresh = () => {
  revalidatePath("/admin/gift-cards");
  revalidatePath("/admin/promos");
};

export async function issueCompCardAction(raw: z.input<typeof IssueCompInput>) {
  return safe(async () => {
    const ctx = await authorize("giftcards.issue");
    assertShopAccess(ctx, raw.shopId);
    const r = await issueCompCard(ctx.actor, ctx, raw);
    refresh();
    return r;
  });
}

export async function compReloadAction(raw: z.input<typeof CompReloadInput>) {
  return safe(async () => {
    const ctx = await authorize("giftcards.issue");
    const r = await compReload(ctx.actor, ctx, raw);
    refresh();
    return r;
  });
}

export async function voidGiftCardAction(id: string, reason: string) {
  return safe(async () => {
    const ctx = await authorize("giftcards.void");
    await voidGiftCard(ctx.actor, ctx, { id, reason });
    refresh();
    return null;
  });
}

/** Opens a ticket at the person's shop with the reload on it; the page then goes to checkout. */
export async function startReloadAction(raw: z.input<typeof StartReloadInput>) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    assertShopAccess(ctx, raw.shopId);
    return startReloadTicket(ctx.actor, ctx, raw);
  });
}
