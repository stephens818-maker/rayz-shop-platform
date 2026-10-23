import type { AdjustmentRecord, HourEntry, PeriodMeta, SaleRecord, ShopRecord, StaffRecord } from "./engine";

export const TODAY = "2026-10-23";

export const SHOP_CORALVILLE = "11111111-1111-4111-8111-111111111101";
export const SHOP_MOLINE = "11111111-1111-4111-8111-111111111102";
export const SHOP_KIMBERLY = "11111111-1111-4111-8111-111111111103";

export const STAFF_MAKENNA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const STAFF_KAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const STAFF_CASEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
export const STAFF_RILEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

const tip = (
  status: NonNullable<SaleRecord["transfer"]>["status"],
  payout: NonNullable<SaleRecord["payout"]>["status"],
  amount: number,
  arrival: string | null,
  failure: string | null = null,
): Pick<SaleRecord, "transfer" | "payout"> => ({
  transfer: { status, amountCents: amount, arrivalDate: arrival },
  payout: { status: payout, amountCents: amount, arrivalDate: arrival, bankLast4: "6789", failureMessage: failure },
});

export function seedShops(): ShopRecord[] {
  return [
    { id: SHOP_CORALVILLE, slug: "coralville", name: "Coralville", tipTransfers: true, serviceTaxRate: 0.07, cardFeeEnabled: true, cardFeeRate: 0.03, cardFeeAppliesToTip: false, payments: true, booking: "native", clockIn: true },
    { id: SHOP_MOLINE, slug: "moline", name: "Moline", tipTransfers: false, serviceTaxRate: 0, cardFeeEnabled: true, cardFeeRate: 0.03, cardFeeAppliesToTip: false, payments: true, booking: "native", clockIn: true },
    { id: SHOP_KIMBERLY, slug: "kimberly", name: "Kimberly", tipTransfers: false, serviceTaxRate: 0.07, cardFeeEnabled: false, cardFeeRate: 0, cardFeeAppliesToTip: false, payments: false, booking: "external", clockIn: false },
  ];
}

export function seedStaff(): StaffRecord[] {
  const rates = { hourlyRateCents: 1500, trainingRateCents: 1200, serviceCommissionRate: 0.5, productCommissionRate: 0.1, bankLast4: "6789" as string | null };
  return [
    { id: STAFF_MAKENNA, ...rates },
    { id: STAFF_KAT, ...rates, bankLast4: null },
    { id: STAFF_CASEY, ...rates, bankLast4: "4242" },
    { id: STAFF_RILEY, ...rates, bankLast4: null },
  ];
}

function hours(staffId: string, shopId: string, date: string, productionHours: number, trainingHours = 0): HourEntry {
  return { staffId, shopId, date, productionMinutes: productionHours * 60, trainingMinutes: trainingHours * 60 };
}

export function seedHours(): HourEntry[] {
  const mk = STAFF_MAKENNA;
  const shop = SHOP_CORALVILLE;
  return [
    hours(mk, shop, "2026-09-21", 8),
    hours(mk, shop, "2026-09-22", 8),
    hours(mk, shop, "2026-09-23", 8),
    hours(mk, shop, "2026-09-24", 8),
    hours(mk, shop, "2026-09-25", 8),
    hours(mk, shop, "2026-10-12", 8),
    hours(mk, shop, "2026-10-13", 8),
    hours(mk, shop, "2026-10-14", 8),
    hours(mk, shop, "2026-10-15", 8),
    hours(mk, shop, "2026-10-16", 6),
    hours(mk, shop, "2026-10-18", 0, 4),
    hours(mk, shop, "2026-10-19", 8),
    hours(mk, shop, "2026-10-20", 8),
    hours(mk, shop, "2026-10-21", 4),
    hours(STAFF_CASEY, SHOP_CORALVILLE, "2026-10-21", 4),
    hours(STAFF_CASEY, SHOP_MOLINE, "2026-10-21", 4),
  ];
}

function sale(partial: Omit<SaleRecord, "transfer" | "payout"> & Partial<Pick<SaleRecord, "transfer" | "payout">>): SaleRecord {
  return { transfer: null, payout: null, ...partial };
}

export function seedSales(): SaleRecord[] {
  const mk = STAFF_MAKENNA;
  const shop = SHOP_CORALVILLE;
  return [
    sale({
      id: "sale_sep22",
      staffId: mk,
      shopId: shop,
      date: "2026-09-22",
      startedAt: "2026-09-22T15:00:00.000Z",
      clientFirstName: "Sam",
      serviceName: "Ray'z Cut",
      serviceCents: 4000,
      productCents: 0,
      cardTipCents: 800,
      cashTipCents: 0,
      ...tip("paid", "paid", 800, "2026-09-24"),
    }),
    sale({
      id: "sale_sep24",
      staffId: mk,
      shopId: shop,
      date: "2026-09-24",
      startedAt: "2026-09-24T16:30:00.000Z",
      clientFirstName: "Riley",
      serviceName: "Kids Cut",
      serviceCents: 3000,
      productCents: 1000,
      cardTipCents: 500,
      cashTipCents: 200,
      ...tip("paid", "paid", 500, "2026-09-26"),
    }),
    sale({
      id: "sale_pending",
      staffId: mk,
      shopId: shop,
      date: "2026-10-20",
      startedAt: "2026-10-20T14:00:00.000Z",
      clientFirstName: "Alex",
      serviceName: "Ray'z Cut",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 100,
      cashTipCents: 0,
      ...tip("pending", "pending", 100, "2026-10-22"),
    }),
    sale({
      id: "sale_transit",
      staffId: mk,
      shopId: shop,
      date: "2026-10-20",
      startedAt: "2026-10-20T16:00:00.000Z",
      clientFirstName: "Jordan",
      serviceName: "Ray'z Cut",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 200,
      cashTipCents: 0,
      ...tip("paid", "in_transit", 200, "2026-10-22"),
    }),
    sale({
      id: "sale_paid",
      staffId: mk,
      shopId: shop,
      date: "2026-10-21",
      startedAt: "2026-10-21T15:00:00.000Z",
      clientFirstName: "Sam",
      serviceName: "Beard Trim",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 300,
      cashTipCents: 0,
      ...tip("paid", "paid", 300, "2026-10-23"),
    }),
    sale({
      id: "sale_failed",
      staffId: mk,
      shopId: shop,
      date: "2026-10-21",
      startedAt: "2026-10-21T18:00:00.000Z",
      clientFirstName: "Noah",
      serviceName: "Ray'z Cut",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 400,
      cashTipCents: 0,
      ...tip("paid", "failed", 400, "2026-10-23", "The bank could not accept this payout. Your tips are safe and Stripe will retry."),
    }),
    sale({
      id: "sale_canceled",
      staffId: mk,
      shopId: shop,
      date: "2026-10-22",
      startedAt: "2026-10-22T15:00:00.000Z",
      clientFirstName: "Mia",
      serviceName: "Ray'z Cut",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 500,
      cashTipCents: 0,
      ...tip("paid", "canceled", 500, null),
    }),
    sale({
      id: "sale_reversed",
      staffId: mk,
      shopId: shop,
      date: "2026-10-22",
      startedAt: "2026-10-22T17:00:00.000Z",
      clientFirstName: "Lou",
      serviceName: "Ray'z Cut",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 150,
      cashTipCents: 0,
      ...tip("reversed", "failed", 150, "2026-10-23", "Returned by bank"),
    }),
    sale({
      id: "sale_cash",
      staffId: mk,
      shopId: shop,
      date: "2026-10-22",
      startedAt: "2026-10-22T19:00:00.000Z",
      clientFirstName: "Ada",
      serviceName: "Kids Cut",
      serviceCents: 1000,
      productCents: 0,
      cardTipCents: 0,
      cashTipCents: 50,
    }),
    sale({
      id: "sale_casey_coral",
      staffId: STAFF_CASEY,
      shopId: SHOP_CORALVILLE,
      date: "2026-10-21",
      startedAt: "2026-10-21T15:30:00.000Z",
      clientFirstName: "Evan",
      serviceName: "Ray'z Cut",
      serviceCents: 2200,
      productCents: 0,
      cardTipCents: 440,
      cashTipCents: 0,
      ...tip("paid", "paid", 440, "2026-10-23"),
    }),
    sale({
      id: "sale_casey_moline",
      staffId: STAFF_CASEY,
      shopId: SHOP_MOLINE,
      date: "2026-10-21",
      startedAt: "2026-10-21T20:00:00.000Z",
      clientFirstName: "Chris",
      serviceName: "Ray'z Cut",
      serviceCents: 1800,
      productCents: 0,
      cardTipCents: 360,
      cashTipCents: 0,
      ...tip("paid", "paid", 360, "2026-10-23"),
    }),
    sale({
      id: "sale_kat",
      staffId: STAFF_KAT,
      shopId: SHOP_MOLINE,
      date: "2026-10-21",
      startedAt: "2026-10-21T16:00:00.000Z",
      clientFirstName: "Pat",
      serviceName: "Ray'z Cut",
      serviceCents: 2400,
      productCents: 0,
      cardTipCents: 480,
      cashTipCents: 0,
      ...tip("paid", "paid", 480, "2026-10-23"),
    }),
  ];
}

export function seedAdjustments(): AdjustmentRecord[] {
  return [
    {
      id: "adj_late_cash",
      staffId: STAFF_MAKENNA,
      shopId: SHOP_CORALVILLE,
      kind: "late_cash_tip",
      amountCents: 1500,
      originalDate: "2026-10-12",
      postedDate: "2026-10-23",
      lateDeclaration: true,
      reducesPay: false,
      copy: "Declared after payroll closed; will appear on your next paycheck.",
    },
    {
      id: "adj_late_refund",
      staffId: STAFF_MAKENNA,
      shopId: SHOP_CORALVILLE,
      kind: "card_tip_refund",
      amountCents: 300,
      originalDate: "2026-09-22",
      postedDate: "2026-10-23",
      lateDeclaration: true,
      reducesPay: false,
      copy: "Declared after payroll closed; will appear on your next paycheck.",
    },
  ];
}

export function seedPeriods(): PeriodMeta[] {
  return [
    { id: "2026-09-20", start: "2026-09-20", end: "2026-10-03", periodStatus: "locked", payrollStatus: "paid_in_paycheck", snapshotId: "snap_2026-09-20", computedAt: "2026-10-06T15:00:00.000Z" },
    { id: "2026-10-04", start: "2026-10-04", end: "2026-10-17", periodStatus: "locked", payrollStatus: "sent_to_payroll", snapshotId: "snap_2026-10-04", computedAt: "2026-10-19T15:00:00.000Z" },
    { id: "2026-10-18", start: "2026-10-18", end: "2026-10-31", periodStatus: "draft", payrollStatus: "not_yet_processed", snapshotId: null, computedAt: null },
  ];
}
