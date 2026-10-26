import { eq, inArray } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { bookingGroups, brandSettings, shops } from "@/db/schema";
import {
  CardFeeOverride,
  CardFeePolicy,
  FeeChannel,
  brandCardFeePolicy,
  cleanOverride,
  feeConfigFor,
  policyDiff,
  policyProblem,
  shopCardFeePolicy,
} from "@/domain/card-fee-policy";
import { type CardFeeConfig, type CardFeeResult, type CardFunding, cardFeeFor } from "@/domain/checkout";
import { flags } from "@/lib/flags";
import { Actor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";

export type { CardFeeBasis, CardFeeResult, CardFunding } from "@/domain/checkout";

/** The legacy columns alone, for rows that predate the policy (tests and old snapshots). */
export function shopCardFeeConfig(shop: { cardFeeEnabled: boolean; cardFeeRate: string | number; cardFeeAppliesToTip: boolean }): CardFeeConfig {
  return { enabled: shop.cardFeeEnabled, rate: Number(shop.cardFeeRate), appliesToTip: shop.cardFeeAppliesToTip };
}

export async function brandFeePolicy(tx: DBorTx = db): Promise<CardFeePolicy> {
  const [row] = await tx.select({ f: brandSettings.cardFee }).from(brandSettings).where(eq(brandSettings.id, 1));
  return brandCardFeePolicy(row?.f ?? {});
}

export interface ShopFeePolicy {
  brand: CardFeePolicy;
  policy: CardFeePolicy;
  override: CardFeeOverride | null;
  state: string;
}

export async function shopFeePolicy(shopId: string, tx: DBorTx = db, brand?: CardFeePolicy): Promise<ShopFeePolicy> {
  const [shop] = await tx.select({ o: shops.cardFeeOverride, state: shops.state }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const b = brand ?? (await brandFeePolicy(tx));
  return { brand: b, policy: shopCardFeePolicy(b, shop.o), override: cleanOverride(b, shop.o), state: shop.state };
}

/** A booking deposit's ticket is always the deposit channel, wherever it's paid. */
export async function saleFeeChannel(saleId: string, fallback: FeeChannel, tx: DBorTx = db): Promise<FeeChannel> {
  const [g] = await tx.select({ id: bookingGroups.id }).from(bookingGroups).where(eq(bookingGroups.depositSaleId, saleId)).limit(1);
  return g ? "deposit" : fallback;
}

/** The fee config for a charge at this shop on this channel. */
export async function cardFeeConfigFor(shopId: string, channel: FeeChannel, tx: DBorTx = db): Promise<CardFeeConfig> {
  const p = await shopFeePolicy(shopId, tx);
  return feeConfigFor(p.policy, p.state, channel);
}

/**
 * The credit-card surcharge a shop adds to one card charge: the shop's card fee policy applied
 * to the amount going on the card (tip included in `chargeCents`). Read-only; the POS uses the
 * same calculation through computeCheckout.
 */
export async function computeCardFee(
  shopId: string,
  funding: CardFunding | null,
  amounts: { chargeCents: number; tipCents?: number },
  opts: { wallet?: boolean | string | null; channel?: FeeChannel } = {},
): Promise<CardFeeResult> {
  return cardFeeFor(await cardFeeConfigFor(shopId, opts.channel ?? "pos"), funding, amounts, { wallet: opts.wallet, walletFeeOn: flags.walletFee() });
}

/** Keeps shops.card_fee_enabled / _rate / _applies_to_tip in step with the policy, for the tax and fee summary and older readers. */
async function syncMirror(tx: DBorTx, brand: CardFeePolicy, shopIds?: string[]) {
  const rows = await tx
    .select({ id: shops.id, o: shops.cardFeeOverride })
    .from(shops)
    .where(shopIds ? inArray(shops.id, shopIds) : undefined);
  for (const r of rows) {
    const p = shopCardFeePolicy(brand, r.o);
    await tx
      .update(shops)
      .set({ cardFeeEnabled: p.enabled, cardFeeRate: (p.type === "flat" ? 0 : p.rate).toFixed(5), cardFeeAppliesToTip: p.appliesToTip })
      .where(eq(shops.id, r.id));
  }
}

/**
 * Saves the brand's policy (brand-level people only; the caller checks). Refused when it breaks a
 * guardrail, or when a shop's override would no longer make sense on top of it. Audited with what changed.
 */
export async function saveBrandFeePolicy(actor: Actor, next: CardFeePolicy, tx0: DBorTx = db): Promise<CardFeePolicy> {
  const clean = brandCardFeePolicy(next);
  const problem = policyProblem(clean);
  if (problem) throw new AppError("bad_request", problem);
  const run = async (tx: DBorTx) => {
    const before = await brandFeePolicy(tx);
    const overridden = await tx.select({ id: shops.id, name: shops.name, o: shops.cardFeeOverride }).from(shops);
    for (const s of overridden) {
      if (!s.o) continue;
      const p = policyProblem(shopCardFeePolicy(clean, s.o));
      if (p) throw new AppError("bad_request", `${s.name}'s own card fee setting doesn't work with this: ${p}`, { shopId: s.id });
    }
    await tx
      .insert(brandSettings)
      .values({ id: 1, loyalty: {}, cardFee: clean as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: brandSettings.id, set: { cardFee: clean as unknown as Record<string, unknown>, updatedAt: new Date() } });
    await syncMirror(tx, clean);
    await audit(actor, "card_fee.brand", "brand_settings", null, { changes: policyDiff(before, clean), after: clean }, null, tx);
  };
  await tx0.transaction(run);
  return clean;
}

/** A shop's override, or null to follow the brand. Only keys that differ from the brand are kept. Audited. */
export async function saveShopFeeOverride(actor: Actor, shopId: string, raw: CardFeeOverride | null, tx0: DBorTx = db) {
  const run = async (tx: DBorTx) => {
    const cur = await shopFeePolicy(shopId, tx);
    const next = raw ? cleanOverride(cur.brand, raw) : null;
    const merged = shopCardFeePolicy(cur.brand, next);
    const problem = policyProblem(merged);
    if (problem) throw new AppError("bad_request", problem);
    await tx
      .update(shops)
      .set({ cardFeeOverride: next as Record<string, unknown> | null })
      .where(eq(shops.id, shopId));
    await syncMirror(tx, cur.brand, [shopId]);
    await audit(actor, "card_fee.shop", "shop", shopId, { changes: policyDiff(cur.override ?? {}, next ?? {}), override: next, effective: merged }, shopId, tx);
    return { override: next, policy: merged };
  };
  return tx0.transaction(run);
}
