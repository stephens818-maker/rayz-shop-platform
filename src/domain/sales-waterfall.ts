/**
 * The sales waterfall: from gross sales to the money actually collected, one step at a time, so
 * every line adds up. Refunds and discounts come off gross to give net sales; tax, tips, card fees
 * (the surcharge clients paid, never a tax) and gift cards sold go on top; what clients paid from
 * gift card balances they already had comes off, leaving the card and cash collected.
 */
export interface WaterfallInput {
  grossSalesCents: number;
  refundCents: number;
  discountCents: number;
  taxCents: number;
  tipsCents: number;
  cardFeeCents: number;
  giftCardsSoldCents: number;
  giftCardCents: number;
  cardCents: number;
  cashCents: number;
}

export interface WaterfallStep {
  label: string;
  style?: "subtotal" | "total";
  value: (x: WaterfallInput) => number;
}

const net = (x: WaterfallInput) => x.grossSalesCents - x.refundCents - x.discountCents;
const due = (x: WaterfallInput) => net(x) + x.taxCents + x.tipsCents + x.cardFeeCents + x.giftCardsSoldCents;

export const WATERFALL: WaterfallStep[] = [
  { label: "Gross sales", value: (x) => x.grossSalesCents },
  { label: "− Refunds", value: (x) => -x.refundCents },
  { label: "− Discounts", value: (x) => -x.discountCents },
  { label: "= Net sales", style: "subtotal", value: net },
  { label: "+ Taxes", value: (x) => x.taxCents },
  { label: "+ Tips", value: (x) => x.tipsCents },
  { label: "+ Card fees paid by clients", value: (x) => x.cardFeeCents },
  { label: "+ Gift cards sold", value: (x) => x.giftCardsSoldCents },
  { label: "= Total paid", style: "subtotal", value: due },
  { label: "− Paid from gift card balances", value: (x) => -x.giftCardCents },
  { label: "= Collected", style: "total", value: (x) => due(x) - x.giftCardCents },
  { label: "Card", value: (x) => x.cardCents },
  { label: "Cash", value: (x) => x.cashCents },
];

/**
 * Card and cash taken against the waterfall's collected line. Nonzero when a ticket was paid on a
 * different day than it was rung up or a refund went back on a different tender.
 */
export const waterfallGap = (x: WaterfallInput) => x.cardCents + x.cashCents - (due(x) - x.giftCardCents);
