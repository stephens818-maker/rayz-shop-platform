/**
 * Mirrors the shop platform's `cardFeeFor` (src/domain/checkout.ts).
 * The server is the source of truth at pay time. This copy lets the app
 * show the same fee line the preview endpoint returns, and lets tests lock the math.
 */

import { applyRate } from "./money";

export const MAX_CARD_FEE_RATE = 0.03;

export type CardFunding = "credit" | "debit" | "prepaid" | "unknown";

export interface CardFeeConfig {
  enabled: boolean;
  rate: number;
  appliesToTip: boolean;
}

export interface CardFeeResult {
  feeCents: number;
  rate: number;
  basis: "charge_excluding_tip" | "charge_including_tip";
  basisCents: number;
  waivable: boolean;
  reason: "applies" | "disabled" | "not_credit" | "wallet_fee_off" | "zero_amount";
  label: string | null;
  disclosure: string | null;
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`.replace(/\.0%$/, "%");
}

export function feeDisclosure(cfg: Pick<CardFeeConfig, "rate" | "enabled">): string | null {
  if (!cfg.enabled || cfg.rate <= 0) return null;
  const r = formatRate(Math.min(cfg.rate, MAX_CARD_FEE_RATE));
  return `A ${r} surcharge applies to credit card payments only. It does not exceed our cost of acceptance. No surcharge on debit, prepaid, gift card, or cash.`;
}

export function cardFeeFor(
  cfg: CardFeeConfig,
  funding: CardFunding | null | undefined,
  amounts: { chargeCents: number; tipCents?: number },
  opts: { wallet?: boolean; walletFeeOn?: boolean } = {},
): CardFeeResult {
  const rate = Math.min(Math.max(cfg.rate, 0), MAX_CARD_FEE_RATE);
  const basis = cfg.appliesToTip ? "charge_including_tip" : "charge_excluding_tip";
  const charge = Math.max(0, Math.round(amounts.chargeCents));
  const tipOnCharge = Math.min(Math.max(0, Math.round(amounts.tipCents ?? 0)), charge);
  const basisCents = charge - (cfg.appliesToTip ? 0 : tipOnCharge);
  const disclosure = feeDisclosure({ ...cfg, rate });
  const none = (reason: CardFeeResult["reason"]): CardFeeResult => ({
    feeCents: 0,
    rate: 0,
    basis,
    basisCents: 0,
    waivable: false,
    reason,
    label: null,
    disclosure,
  });
  if (!cfg.enabled || rate <= 0) return { ...none("disabled"), disclosure: null };
  if (funding !== "credit") return none("not_credit");
  if (opts.wallet && !opts.walletFeeOn) return none("wallet_fee_off");
  const feeCents = applyRate(basisCents, rate);
  if (feeCents <= 0) return none("zero_amount");
  return {
    feeCents,
    rate,
    basis,
    basisCents,
    waivable: true,
    reason: "applies",
    label: `Credit card surcharge (${formatRate(rate)})`,
    disclosure,
  };
}
