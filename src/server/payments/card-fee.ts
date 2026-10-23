import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { type CardFeeConfig, type CardFeeResult, type CardFunding, cardFeeFor } from "@/domain/checkout";
import { flags } from "@/lib/flags";
import { notFound } from "@/server/errors";

export type { CardFeeBasis, CardFeeResult, CardFunding } from "@/domain/checkout";

export function shopCardFeeConfig(shop: { cardFeeEnabled: boolean; cardFeeRate: string | number; cardFeeAppliesToTip: boolean }): CardFeeConfig {
  return { enabled: shop.cardFeeEnabled, rate: Number(shop.cardFeeRate), appliesToTip: shop.cardFeeAppliesToTip };
}

/**
 * The credit-card surcharge a shop adds to one card charge: the shop's card fee settings applied
 * to the amount going on the card (tip included in `chargeCents`). Read-only; the POS uses the
 * same calculation through computeCheckout.
 */
export async function computeCardFee(
  shopId: string,
  funding: CardFunding | null,
  amounts: { chargeCents: number; tipCents?: number },
  opts: { wallet?: boolean } = {},
): Promise<CardFeeResult> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { cardFeeEnabled: true, cardFeeRate: true, cardFeeAppliesToTip: true } });
  if (!shop) throw notFound("Shop");
  return cardFeeFor(shopCardFeeConfig(shop), funding, amounts, { wallet: opts.wallet, walletFeeOn: flags.walletFee() });
}
