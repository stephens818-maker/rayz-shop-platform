import { eq, inArray, ne } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { bookingGroups, brandSettings, shops } from "@/db/schema";
import {
  BULK_FEE_ACTION_LABEL,
  BulkFeeAction,
  CardFeeOverride,
  CardFeePolicy,
  FeeChannel,
  ShopFeeState,
  brandCardFeePolicy,
  bulkOverride,
  cleanOverride,
  effectiveShopPolicy,
  feeAppliesToShop,
  feeConfigFor,
  policyDiff,
  policyProblem,
  shopCardFeePolicy,
  shopFeeFingerprint,
  shopFeeState,
  withShopsApplied,
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
  /** What the shop charges: off where the brand doesn't apply the fee. */
  policy: CardFeePolicy;
  /** The brand's settings with the shop's own on top, whether or not the brand applies the fee here. */
  configured: CardFeePolicy;
  override: CardFeeOverride | null;
  state: string;
  applied: boolean;
}

export async function shopFeePolicy(shopId: string, tx: DBorTx = db, brand?: CardFeePolicy): Promise<ShopFeePolicy> {
  const [shop] = await tx.select({ o: shops.cardFeeOverride, state: shops.state }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const b = brand ?? (await brandFeePolicy(tx));
  return {
    brand: b,
    policy: effectiveShopPolicy(b, shop.o, shopId),
    configured: shopCardFeePolicy(b, shop.o),
    override: cleanOverride(b, shop.o),
    state: shop.state,
    applied: feeAppliesToShop(b, shopId),
  };
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

/** One shop's surcharge as the audit log records it, before and after a change. */
type FeeSnapshot = Pick<ShopFeeState, "on" | "off" | "fee" | "inherits" | "appliesToTip"> & { override: CardFeeOverride | null };
export interface ShopFeeChange {
  shopId: string;
  name: string;
  from: FeeSnapshot;
  to: FeeSnapshot;
}

const snapshot = (brand: CardFeePolicy, o: unknown, shopId: string, state: string): FeeSnapshot => {
  const s = shopFeeState(brand, o, shopId, state);
  return { on: s.on, off: s.off, fee: s.fee, inherits: s.inherits, appliesToTip: s.appliesToTip, override: cleanOverride(brand, o) };
};

/**
 * Writes a change to the brand policy and any shops' overrides, refusing it if a shop's own setting
 * would break a guardrail on top of the new brand policy. Each shop whose charge changed gets its
 * change date set, and shops.card_fee_enabled / _rate / _applies_to_tip are kept in step for the tax
 * and fee summary and older readers. Returns what changed at each shop, for the audit log.
 */
async function commitFeeChange(tx: DBorTx, before: CardFeePolicy, after: CardFeePolicy, overrides: ReadonlyMap<string, CardFeeOverride | null>): Promise<ShopFeeChange[]> {
  const rows = await tx
    .select({ id: shops.id, name: shops.name, state: shops.state, o: shops.cardFeeOverride, en: shops.cardFeeEnabled, rate: shops.cardFeeRate, tip: shops.cardFeeAppliesToTip })
    .from(shops);
  const out: ShopFeeChange[] = [];
  const now = new Date();
  for (const r of rows) {
    const touched = overrides.has(r.id);
    const next = touched ? overrides.get(r.id)! : r.o;
    if (touched || next) {
      const problem = policyProblem(shopCardFeePolicy(after, next));
      if (problem) throw new AppError("bad_request", touched ? `${r.name}: ${problem}` : `${r.name}'s own card fee setting doesn't work with this: ${problem}`, { shopId: r.id });
    }
    const p0 = effectiveShopPolicy(before, r.o, r.id);
    const p1 = effectiveShopPolicy(after, next, r.id);
    const ownChanged = touched && JSON.stringify(cleanOverride(before, r.o)) !== JSON.stringify(next);
    const changed = ownChanged || shopFeeFingerprint(p0, r.state) !== shopFeeFingerprint(p1, r.state);
    const mirror = { cardFeeEnabled: p1.enabled, cardFeeRate: (p1.type === "flat" ? 0 : p1.rate).toFixed(5), cardFeeAppliesToTip: p1.appliesToTip };
    const mirrorStale = mirror.cardFeeEnabled !== r.en || Number(mirror.cardFeeRate) !== Number(r.rate) || mirror.cardFeeAppliesToTip !== r.tip;
    if (!touched && !changed && !mirrorStale) continue;
    await tx
      .update(shops)
      .set({ ...mirror, ...(touched ? { cardFeeOverride: next as Record<string, unknown> | null } : {}), ...(changed ? { cardFeeChangedAt: now } : {}) })
      .where(eq(shops.id, r.id));
    if (changed) out.push({ shopId: r.id, name: r.name, from: snapshot(before, r.o, r.id, r.state), to: snapshot(after, next, r.id, r.state) });
  }
  return out;
}

async function saveBrandRow(tx: DBorTx, p: CardFeePolicy) {
  await tx
    .insert(brandSettings)
    .values({ id: 1, loyalty: {}, cardFee: p as unknown as Record<string, unknown> })
    .onConflictDoUpdate({ target: brandSettings.id, set: { cardFee: p as unknown as Record<string, unknown>, updatedAt: new Date() } });
}

/** Each shop's own audit trail gets the change too, so a shop's history shows brand and bulk changes that reached it. */
async function auditShops(tx: DBorTx, actor: Actor, via: string, changes: ShopFeeChange[]) {
  for (const c of changes) await audit(actor, "card_fee.shop", "shop", c.shopId, { via, from: c.from, to: c.to, override: c.to.override }, c.shopId, tx);
}

/**
 * Saves the brand's policy (brand-level people only; the caller checks), including which shops use
 * it and whether shop managers may change their own. Refused when it breaks a guardrail, or when a
 * shop's override would no longer make sense on top of it. Audited with what changed and which shops it reached.
 */
export async function saveBrandFeePolicy(actor: Actor, next: Partial<CardFeePolicy>, tx0: DBorTx = db): Promise<CardFeePolicy> {
  const run = async (tx: DBorTx) => {
    const before = await brandFeePolicy(tx);
    const clean = brandCardFeePolicy({ ...before, ...next });
    const problem = policyProblem(clean);
    if (problem) throw new AppError("bad_request", problem);
    if (clean.appliesTo === "selected") {
      const known = new Set((await tx.select({ id: shops.id }).from(shops)).map((s) => s.id));
      const unknown = clean.shopIds.find((id) => !known.has(id));
      if (unknown) throw new AppError("bad_request", "One of the selected shops no longer exists", { shopId: unknown });
    }
    const shopChanges = await commitFeeChange(tx, before, clean, new Map());
    await saveBrandRow(tx, clean);
    await audit(actor, "card_fee.brand", "brand_settings", null, { changes: policyDiff(before, clean), after: clean, shopIds: shopChanges.map((c) => c.shopId), shops: shopChanges }, null, tx);
    await auditShops(tx, actor, "brand", shopChanges);
    return clean;
  };
  return tx0.transaction(run);
}

/** A shop's override, or null to follow the brand. Only keys that differ from the brand are kept. Audited. */
export async function saveShopFeeOverride(actor: Actor, shopId: string, raw: CardFeeOverride | null, tx0: DBorTx = db) {
  const run = async (tx: DBorTx) => {
    const cur = await shopFeePolicy(shopId, tx);
    const next = raw ? cleanOverride(cur.brand, raw) : null;
    const merged = shopCardFeePolicy(cur.brand, next);
    const problem = policyProblem(merged);
    if (problem) throw new AppError("bad_request", problem);
    const [c] = await commitFeeChange(tx, cur.brand, cur.brand, new Map([[shopId, next]]));
    await audit(
      actor,
      "card_fee.shop",
      "shop",
      shopId,
      { changes: policyDiff(cur.override ?? {}, next ?? {}), override: next, effective: merged, ...(c ? { from: c.from, to: c.to } : {}) },
      shopId,
      tx,
    );
    return { override: next, policy: merged };
  };
  return tx0.transaction(run);
}

/**
 * One action on many shops at once, from the brand's shop table:
 * - enable: the brand applies the fee there, and a shop's own "off" is turned back on;
 * - disable: the brand stops applying it there (their own settings are kept for later);
 * - brand_rate: the shops drop their own fee type, rate and flat amount and use the brand's;
 * - reset: the shops drop their own settings and follow the brand;
 * - push: reset, and the brand applies the fee there, so one rule set rolls out to them all.
 * Audited once for the action, with every shop's old and new surcharge, and on each shop.
 */
export async function bulkShopFee(actor: Actor, action: BulkFeeAction, shopIds: string[], tx0: DBorTx = db): Promise<ShopFeeChange[]> {
  const ids = [...new Set(shopIds)];
  if (!ids.length) throw new AppError("bad_request", "Pick at least one shop");
  const run = async (tx: DBorTx) => {
    const before = await brandFeePolicy(tx);
    const rows = await tx.select({ id: shops.id, o: shops.cardFeeOverride, status: shops.status }).from(shops);
    const picked = rows.filter((r) => ids.includes(r.id));
    if (picked.length !== ids.length) throw new AppError("bad_request", "One of the shops no longer exists");
    const scope =
      action === "enable" || action === "push" || action === "disable"
        ? withShopsApplied(
            before,
            ids,
            action !== "disable",
            rows.filter((r) => r.status !== "archived").map((r) => r.id),
          )
        : { appliesTo: before.appliesTo, shopIds: before.shopIds };
    const after: CardFeePolicy = { ...before, ...scope };
    const overrides = new Map(picked.map((r) => [r.id, bulkOverride(action, before, r.o)]));
    const changes = await commitFeeChange(tx, before, after, overrides);
    const scopeChanged = after.appliesTo !== before.appliesTo || JSON.stringify(after.shopIds) !== JSON.stringify(before.shopIds);
    if (scopeChanged) await saveBrandRow(tx, after);
    if (changes.length || scopeChanged) {
      await audit(
        actor,
        "card_fee.shops",
        "brand_settings",
        null,
        {
          action,
          label: BULK_FEE_ACTION_LABEL[action],
          shopIds: ids,
          ...(scopeChanged ? { appliesTo: { from: { appliesTo: before.appliesTo, shopIds: before.shopIds }, to: scope } } : {}),
          shops: changes,
        },
        null,
        tx,
      );
      await auditShops(tx, actor, action, changes);
    }
    return changes;
  };
  return tx0.transaction(run);
}

export interface ShopFeeRow extends ShopFeeState {
  shopId: string;
  name: string;
  state: string;
  status: string;
  changedAt: Date | null;
}

/** Every shop that isn't archived with its surcharge as it stands, for the brand's shop table and the report filter. */
export async function shopFeeRows(tx: DBorTx = db, brand?: CardFeePolicy): Promise<ShopFeeRow[]> {
  const b = brand ?? (await brandFeePolicy(tx));
  const rows = await tx
    .select({ id: shops.id, name: shops.name, state: shops.state, status: shops.status, o: shops.cardFeeOverride, at: shops.cardFeeChangedAt })
    .from(shops)
    .where(ne(shops.status, "archived"))
    .orderBy(shops.name);
  return rows.map((r) => ({ shopId: r.id, name: r.name, state: r.state, status: r.status, changedAt: r.at, ...shopFeeState(b, r.o, r.id, r.state) }));
}

/** The card fee report's shop filter: which of these shops are on, off, following the brand, or set their own. */
export const SHOP_FEE_FILTERS = { on: "Surcharge on", off: "Surcharge off", brand: "Following the brand", own: "Their own setting" } as const;
export type ShopFeeFilter = keyof typeof SHOP_FEE_FILTERS;

export async function shopsMatchingFee(shopIds: string[], filter: ShopFeeFilter, tx: DBorTx = db): Promise<string[]> {
  if (!shopIds.length) return [];
  const b = await brandFeePolicy(tx);
  const rows = await tx.select({ id: shops.id, state: shops.state, o: shops.cardFeeOverride }).from(shops).where(inArray(shops.id, shopIds));
  const keep = new Set(
    rows
      .filter((r) => {
        const s = shopFeeState(b, r.o, r.id, r.state);
        return filter === "on" ? s.on : filter === "off" ? !s.on : filter === "brand" ? s.inherits : !s.inherits;
      })
      .map((r) => r.id),
  );
  return shopIds.filter((id) => keep.has(id));
}

/**
 * Whether this person may change this shop's own surcharge: brand admins always; people who edit
 * the shop's checkout settings only when the brand lets shop managers. Otherwise they see it only.
 */
export function canEditShopFee(perms: ReadonlySet<string>, brand: Pick<CardFeePolicy, "shopsCanEdit">) {
  return perms.has("settings.card_fee") || (brand.shopsCanEdit && (perms.has("settings.shop") || perms.has("settings.shop_checkout")));
}
