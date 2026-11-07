import { allocateProportionally } from "@/lib/money";
import type { LineKind } from "./checkout";

export interface RefundComponents {
  serviceNetCents: number;
  productNetCents: number;
  giftCardSalesCents: number;
  taxCents: number;
  tipCents: number;
  cardFeeCents: number;
}

export const ZERO: RefundComponents = { serviceNetCents: 0, productNetCents: 0, giftCardSalesCents: 0, taxCents: 0, tipCents: 0, cardFeeCents: 0 };

export const componentsTotal = (c: RefundComponents) =>
  c.serviceNetCents + c.productNetCents + c.giftCardSalesCents + c.taxCents + c.tipCents + c.cardFeeCents;

export function addComponents(a: RefundComponents, b: RefundComponents): RefundComponents {
  return {
    serviceNetCents: a.serviceNetCents + b.serviceNetCents,
    productNetCents: a.productNetCents + b.productNetCents,
    giftCardSalesCents: a.giftCardSalesCents + b.giftCardSalesCents,
    taxCents: a.taxCents + b.taxCents,
    tipCents: a.tipCents + b.tipCents,
    cardFeeCents: a.cardFeeCents + b.cardFeeCents,
  };
}

export interface RefundableLine {
  id: string;
  kind: LineKind;
  name: string;
  qty: number;
  refundedQty: number;
  netCents: number;
  taxCents: number;
}

/**
 * The slice of a line total that belongs to units [from, from + k). Rounds on cumulative
 * boundaries so refunding every unit, in any number of steps, returns exactly the line total.
 */
export function unitsShare(totalCents: number, qty: number, from: number, k: number): number {
  return Math.round((totalCents * (from + k)) / qty) - Math.round((totalCents * from) / qty);
}

export interface LineRefund {
  itemId: string;
  kind: LineKind;
  name: string;
  qty: number;
  fromQty: number;
  netCents: number;
  taxCents: number;
}

/** What refunding `qty` more units of each chosen line is worth, net and tax, before tender allocation. */
export function lineRefunds(lines: RefundableLine[], requested: { saleItemId: string; qty: number }[]): LineRefund[] {
  const out: LineRefund[] = [];
  for (const r of requested) {
    if (!Number.isInteger(r.qty) || r.qty <= 0) throw new RangeError("Refund quantities must be whole numbers");
    const l = lines.find((x) => x.id === r.saleItemId);
    if (!l) throw new RangeError("That item isn't on this ticket");
    if (out.some((o) => o.itemId === l.id)) throw new RangeError(`${l.name} is listed twice`);
    const left = l.qty - l.refundedQty;
    if (r.qty > left) throw new RangeError(left ? `Only ${left} of ${l.name} can still be refunded` : `${l.name} was already refunded`);
    out.push({
      itemId: l.id,
      kind: l.kind,
      name: l.name,
      qty: r.qty,
      fromQty: l.refundedQty,
      netCents: unitsShare(l.netCents, l.qty, l.refundedQty, r.qty),
      taxCents: unitsShare(l.taxCents, l.qty, l.refundedQty, r.qty),
    });
  }
  return out;
}

/**
 * The card surcharge that goes back with a partial refund: its share of what's left, in proportion
 * to the part of the surcharged amount refunded. Refunding the rest of it returns the rest of the fee.
 */
export function proportionalCardFee(o: { feeLeftCents: number; refundBaseCents: number; baseLeftCents: number }): number {
  if (o.feeLeftCents <= 0 || o.refundBaseCents <= 0 || o.baseLeftCents <= 0) return 0;
  if (o.refundBaseCents >= o.baseLeftCents) return o.feeLeftCents;
  return Math.min(o.feeLeftCents, Math.round((o.feeLeftCents * o.refundBaseCents) / o.baseLeftCents));
}

export function componentsFromLines(lines: LineRefund[], tipCents: number, cardFeeCents: number): RefundComponents {
  const c = { ...ZERO, tipCents, cardFeeCents };
  for (const l of lines) {
    if (l.kind === "service" || l.kind === "addon") c.serviceNetCents += l.netCents;
    else if (l.kind === "product") c.productNetCents += l.netCents;
    else c.giftCardSalesCents += l.netCents;
    c.taxCents += l.taxCents;
  }
  return c;
}

export interface TenderState {
  id: string;
  method: "cash" | "card" | "gift_card";
  /** Still refundable on this tender. */
  availableCents: number;
  /** Tip this tender took, less tip already refunded from it. */
  tipAvailableCents: number;
  /** Card fee this tender charged, less fee already refunded from it. */
  feeAvailableCents: number;
}

export interface TenderRefund {
  tenderId: string;
  method: TenderState["method"];
  amountCents: number;
  components: RefundComponents;
}

/**
 * Sends each refunded component back to the tender that took it: the fee to the card that paid it,
 * the tip to the tender that carried it, gift-card sales never onto a gift card, and everything else
 * to the primary tender (cash/card) before any gift card used on the ticket.
 */
export function allocateToTenders(c: RefundComponents, tenders: TenderState[]): TenderRefund[] {
  const order = [...tenders.filter((t) => t.method !== "gift_card"), ...tenders.filter((t) => t.method === "gift_card")];
  const cap = new Map(order.map((t) => [t.id, Math.max(0, t.availableCents)]));
  const parts = new Map(order.map((t) => [t.id, { ...ZERO }]));
  const put = (key: keyof RefundComponents, cents: number, eligible: (t: TenderState) => number) => {
    let left = cents;
    for (const t of order) {
      if (left <= 0) break;
      const take = Math.min(left, cap.get(t.id)!, eligible(t));
      if (take <= 0) continue;
      parts.get(t.id)![key] += take;
      cap.set(t.id, cap.get(t.id)! - take);
      left -= take;
    }
    return left;
  };
  if (put("cardFeeCents", c.cardFeeCents, (t) => t.feeAvailableCents) > 0) throw new RangeError("More card fee than the card paid");
  const tipLeft = put("tipCents", c.tipCents, (t) => t.tipAvailableCents);
  if (put("tipCents", tipLeft, () => Infinity) > 0) throw new RangeError("Refund is more than what was paid");
  if (put("giftCardSalesCents", c.giftCardSalesCents, (t) => (t.method === "gift_card" ? 0 : Infinity)) > 0) {
    throw new RangeError("A gift card bought on this ticket can only be refunded to cash or card, and there isn't enough left on them");
  }
  for (const k of ["serviceNetCents", "productNetCents", "taxCents"] as const) {
    if (put(k, c[k], () => Infinity) > 0) throw new RangeError("Refund is more than what was paid");
  }
  return order
    .map((t) => ({ tenderId: t.id, method: t.method, components: parts.get(t.id)!, amountCents: componentsTotal(parts.get(t.id)!) }))
    .filter((r) => r.amountCents > 0);
}

/**
 * For refunds that arrive as a bare amount (issued in the Stripe dashboard): split across what's
 * left of the sale in proportion, keeping gift cards sold on the ticket last so a dashboard refund
 * only cuts a gift card when nothing else is left.
 */
export function allocateAmount(remaining: RefundComponents, amountCents: number): RefundComponents {
  const keys = ["serviceNetCents", "productNetCents", "taxCents", "tipCents", "cardFeeCents"] as const;
  const rest = keys.map((k) => Math.max(0, remaining[k]));
  const restTotal = rest.reduce((a, b) => a + b, 0);
  const amt = Math.max(0, Math.min(amountCents, restTotal + Math.max(0, remaining.giftCardSalesCents)));
  const first = Math.min(amt, restTotal);
  const split = allocateProportionally(first, rest);
  const out = { ...ZERO, giftCardSalesCents: amt - first };
  keys.forEach((k, i) => (out[k] = split[i]));
  return out;
}
