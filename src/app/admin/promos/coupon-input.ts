import type { promoCodes } from "@/db/schema";
import type { CodeMode, CouponType } from "@/domain/coupons";

type Promo = typeof promoCodes.$inferSelect;

export interface CouponFormValues {
  code: string;
  description: string | null;
  type: CouponType;
  value: number;
  appliesTo: "services" | "products" | "all";
  serviceIds: string[];
  productIds: string[];
  freeItemKind: "service" | "addon" | "product" | null;
  freeItemId: string | null;
  shopIds: string[];
  minSpendCents: number | null;
  startsOn: string | null;
  endsOn: string | null;
  maxRedemptions: number | null;
  maxPerCustomer: number | null;
  codeMode: CodeMode;
  validDays: number | null;
  firstVisitOnly: boolean;
  stackable: boolean;
  autoApply: boolean;
  daysOfWeek: number[];
  timeFrom: string | null;
  timeTo: string | null;
}

/** Where a coupon works: its location list, or the single shop older promo codes were tied to. Empty is every location. */
export const scopeOf = (p: Pick<Promo, "shopId" | "shopIds">) => (p.shopIds?.length ? p.shopIds : p.shopId ? [p.shopId] : []);

export function couponInputOf(p: Promo): CouponFormValues {
  return {
    code: p.code,
    description: p.description,
    type: p.type as CouponType,
    value: p.value,
    appliesTo: (p.appliesTo as CouponFormValues["appliesTo"]) ?? "services",
    serviceIds: p.serviceIds ?? [],
    productIds: p.productIds ?? [],
    freeItemKind: p.freeItemKind ?? null,
    freeItemId: p.freeItemId ?? null,
    shopIds: scopeOf(p),
    minSpendCents: p.minSpendCents,
    startsOn: p.startsOn,
    endsOn: p.endsOn,
    maxRedemptions: p.maxRedemptions,
    maxPerCustomer: p.maxPerCustomer,
    codeMode: p.codeMode,
    validDays: p.validDays,
    firstVisitOnly: p.firstVisitOnly,
    stackable: p.stackable,
    autoApply: p.autoApply,
    daysOfWeek: p.daysOfWeek ?? [],
    timeFrom: p.timeFrom,
    timeTo: p.timeTo,
  };
}
