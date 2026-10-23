import {
  CASH_TIP_REMINDER,
  GROSS_LABEL,
  OT_PAY_LABEL,
  PARTIAL_WEEK_OT_LABEL,
  PAYROLL_TIPS_COPY,
  applyRate,
  clampRange,
  eachDate,
  payPeriodFor,
  payPeriodsOverlapping,
  weekCovers,
  workweekContaining,
  type EarningsAdjustment,
  type EarningsDay,
  type EarningsResponse,
  type EarningsShopSlice,
  type EarningsTicket,
  type EarningsWorkweek,
  type PayrollStatus,
  type PeriodStatus,
} from "@rayz/api";

export interface ShopRecord {
  id: string;
  slug: string;
  name: string;
  tipTransfers: boolean;
  serviceTaxRate: number;
  cardFeeEnabled: boolean;
  cardFeeRate: number;
  cardFeeAppliesToTip: boolean;
  payments: boolean;
  booking: "native" | "external" | "closed";
  clockIn: boolean;
}

export interface StaffRecord {
  id: string;
  hourlyRateCents: number;
  trainingRateCents: number;
  serviceCommissionRate: number;
  productCommissionRate: number;
  bankLast4: string | null;
}

export interface HourEntry {
  staffId: string;
  shopId: string;
  date: string;
  productionMinutes: number;
  trainingMinutes: number;
}

export interface SaleRecord {
  id: string;
  staffId: string;
  shopId: string;
  date: string;
  startedAt: string;
  clientFirstName: string;
  serviceName: string;
  serviceCents: number;
  productCents: number;
  cardTipCents: number;
  cashTipCents: number;
  transfer: EarningsTicket["transfer"];
  payout: EarningsTicket["payout"];
}

export interface AdjustmentRecord {
  id: string;
  staffId: string;
  shopId: string;
  kind: "late_cash_tip" | "card_tip_refund";
  amountCents: number;
  originalDate: string;
  postedDate: string;
  lateDeclaration: true;
  reducesPay: false;
  copy: string;
}

export interface PeriodMeta {
  id: string;
  start: string;
  end: string;
  periodStatus: PeriodStatus;
  payrollStatus: PayrollStatus;
  snapshotId: string | null;
  computedAt: string | null;
}

export interface EarningsWorld {
  today: string;
  shops: ShopRecord[];
  staff: StaffRecord[];
  hours: HourEntry[];
  sales: SaleRecord[];
  adjustments: AdjustmentRecord[];
  periods: PeriodMeta[];
}

export interface GreaterOfInput {
  productionMinutes: number;
  hourlyRateCents: number;
  serviceSalesCents: number;
  productSalesCents: number;
  serviceCommissionRate: number;
  productCommissionRate: number;
}

export function greaterOf(input: GreaterOfInput) {
  const hourlyPayCents = Math.round((input.productionMinutes * input.hourlyRateCents) / 60);
  const serviceCommissionCents = applyRate(input.serviceSalesCents, input.serviceCommissionRate);
  const productCommissionCents = applyRate(input.productSalesCents, input.productCommissionRate);
  const commissionCents = serviceCommissionCents + productCommissionCents;
  const explanationCode = commissionCents > hourlyPayCents ? "commission_higher" : hourlyPayCents > commissionCents ? "hourly_higher" : "equal";
  const appliedRule = explanationCode === "commission_higher" ? "commission" : "hourly";
  const greaterOfCents = Math.max(hourlyPayCents, commissionCents);
  const topUpCents = appliedRule === "hourly" ? hourlyPayCents - commissionCents : 0;
  const explanation =
    explanationCode === "commission_higher"
      ? "Commission is higher than hourly pay."
      : explanationCode === "equal"
        ? "Hourly pay and commission are equal. Hourly pay is used."
        : "Hourly pay is higher than commission.";
  return {
    hourlyPayCents,
    serviceCommissionCents,
    productCommissionCents,
    commissionCents,
    appliedRule: appliedRule as "hourly" | "commission",
    explanationCode: explanationCode as "hourly_higher" | "commission_higher" | "equal",
    explanation,
    topUpCents,
    greaterOfCents,
  };
}

interface Chunk {
  date: string;
  kind: "production" | "training";
  minutes: number;
  ot: boolean;
}

function hoursOf(minutes: number): number {
  return minutes / 60;
}

function money(minutes: number, rateCents: number): number {
  return Math.round((minutes * rateCents) / 60);
}

function classifyWeek(entries: HourEntry[]): Chunk[] {
  const byDate = new Map<string, { productionMinutes: number; trainingMinutes: number }>();
  for (const entry of entries) {
    const row = byDate.get(entry.date) ?? { productionMinutes: 0, trainingMinutes: 0 };
    row.productionMinutes += entry.productionMinutes;
    row.trainingMinutes += entry.trainingMinutes;
    byDate.set(entry.date, row);
  }
  const dates = [...byDate.keys()].sort();
  const chunks: Chunk[] = [];
  let elapsed = 0;
  const threshold = 40 * 60;
  for (const date of dates) {
    const row = byDate.get(date)!;
    for (const kind of ["production", "training"] as const) {
      const minutes = kind === "production" ? row.productionMinutes : row.trainingMinutes;
      if (minutes <= 0) continue;
      const start = elapsed;
      const end = elapsed + minutes;
      if (end <= threshold) chunks.push({ date, kind, minutes, ot: false });
      else if (start >= threshold) chunks.push({ date, kind, minutes, ot: true });
      else {
        const regular = threshold - start;
        chunks.push({ date, kind, minutes: regular, ot: false });
        chunks.push({ date, kind, minutes: minutes - regular, ot: true });
      }
      elapsed = end;
    }
  }
  return chunks;
}

function shopOf(world: EarningsWorld, shopId: string): ShopRecord {
  const shop = world.shops.find((s) => s.id === shopId);
  if (!shop) throw new Error(`Unknown shop ${shopId}`);
  return shop;
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

export function buildEarnings(world: EarningsWorld, staffId: string, range: { from: string; to: string }, opts?: { snapshot?: boolean }): EarningsResponse {
  const person = world.staff.find((s) => s.id === staffId);
  if (!person) throw new Error("Unknown staff");
  const from = range.from;
  const to = range.to;
  const periods = payPeriodsOverlapping(from, to).map((p) => {
    const meta = world.periods.find((row) => row.id === p.id);
    if (!meta) throw new Error(`Missing period ${p.id}`);
    return meta;
  });

  const ownHours = world.hours.filter((h) => h.staffId === staffId);
  const ownSales = world.sales.filter((s) => s.staffId === staffId && inRange(s.date, from, to));
  const ownAdjustments = world.adjustments.filter((a) => a.staffId === staffId && inRange(a.postedDate, from, to));

  const weekStarts = new Set<string>();
  for (const date of eachDate(from, to)) weekStarts.add(workweekContaining(date).from);
  for (const hour of ownHours) {
    const week = workweekContaining(hour.date);
    if (week.to >= from && week.from <= to) weekStarts.add(week.from);
  }

  const workweeks: EarningsWorkweek[] = [];
  let productionMinutes = 0;
  let trainingMinutes = 0;
  let otPremium = 0;

  for (const start of [...weekStarts].sort()) {
    const week = { from: start, to: workweekContaining(start).to };
    const coverage = weekCovers(week, { from, to });
    if (coverage === "none") continue;
    const fullEntries = ownHours.filter((h) => h.date >= week.from && h.date <= week.to);
    const chunks = classifyWeek(fullEntries);
    if (!chunks.length && coverage === "full") continue;
    if (!chunks.length && coverage === "partial") continue;
    const sum = (pred: (c: Chunk) => boolean) => chunks.filter(pred).reduce((a, c) => a + c.minutes, 0);
    const prod = sum((c) => c.kind === "production");
    const train = sum((c) => c.kind === "training");
    const regular = sum((c) => !c.ot);
    const ot = sum((c) => c.ot);
    const inProd = sum((c) => c.kind === "production" && inRange(c.date, from, to));
    const inTrain = sum((c) => c.kind === "training" && inRange(c.date, from, to));
    productionMinutes += inProd;
    trainingMinutes += inTrain;
    for (const chunk of chunks) {
      if (!chunk.ot || !inRange(chunk.date, from, to)) continue;
      const rate = chunk.kind === "production" ? person.hourlyRateCents : person.trainingRateCents;
      otPremium += money(chunk.minutes, rate * 0.5);
    }
    const postingMap = new Map<string, { production: number; training: number; regular: number; ot: number }>();
    for (const chunk of chunks) {
      const periodId = payPeriodFor(chunk.date).id;
      const row = postingMap.get(periodId) ?? { production: 0, training: 0, regular: 0, ot: 0 };
      if (chunk.kind === "production") row.production += chunk.minutes;
      else row.training += chunk.minutes;
      if (chunk.ot) row.ot += chunk.minutes;
      else row.regular += chunk.minutes;
      postingMap.set(periodId, row);
    }
    const partial = coverage === "partial";
    const otHours = hoursOf(ot);
    workweeks.push({
      weekStart: week.from,
      weekEnd: week.to,
      timezone: "America/Chicago",
      productionHours: hoursOf(prod),
      trainingHours: hoursOf(train),
      regularHours: hoursOf(regular),
      otHours,
      partial,
      otLabelCode: partial ? "partial_week" : otHours > 0 ? "ot_estimated" : null,
      otLabel: partial ? PARTIAL_WEEK_OT_LABEL : otHours > 0 ? OT_PAY_LABEL : null,
      postings: [...postingMap.entries()].map(([periodId, row]) => ({
        periodId,
        productionHours: hoursOf(row.production),
        trainingHours: hoursOf(row.training),
        regularHours: hoursOf(row.regular),
        otHours: hoursOf(row.ot),
      })),
    });
  }

  const serviceSalesCents = ownSales.reduce((a, s) => a + s.serviceCents, 0);
  const productSalesCents = ownSales.reduce((a, s) => a + s.productCents, 0);
  const cardTipsCents = ownSales.reduce((a, s) => a + s.cardTipCents, 0);
  const cashOnTickets = ownSales.reduce((a, s) => a + s.cashTipCents, 0);
  const lateCash = ownAdjustments.filter((a) => a.kind === "late_cash_tip").reduce((a, row) => a + row.amountCents, 0);
  const cashTipsCents = cashOnTickets + lateCash;
  const giftCardTipsCents = 0;
  const pay = greaterOf({
    productionMinutes,
    hourlyRateCents: person.hourlyRateCents,
    serviceSalesCents,
    productSalesCents,
    serviceCommissionRate: person.serviceCommissionRate,
    productCommissionRate: person.productCommissionRate,
  });
  const trainingPayCents = money(trainingMinutes, person.trainingRateCents);
  const totalTipsCents = cardTipsCents + cashTipsCents + giftCardTipsCents;
  const totalCents = pay.greaterOfCents + trainingPayCents + otPremium + totalTipsCents;

  const shopIds = new Set<string>([...ownSales.map((s) => s.shopId), ...ownHours.filter((h) => inRange(h.date, from, to)).map((h) => h.shopId), ...ownAdjustments.map((a) => a.shopId)]);
  const shops: EarningsShopSlice[] = [...shopIds].map((shopId) => {
    const shop = shopOf(world, shopId);
    const sales = ownSales.filter((s) => s.shopId === shopId);
    const late = ownAdjustments.filter((a) => a.shopId === shopId && a.kind === "late_cash_tip").reduce((n, a) => n + a.amountCents, 0);
    return {
      shopId,
      shopName: shop.name,
      tipTransfersEnabled: shop.tipTransfers,
      payrollCopy: shop.tipTransfers ? null : PAYROLL_TIPS_COPY,
      cardTipsCents: sales.reduce((n, s) => n + s.cardTipCents, 0),
      cashTipsCents: sales.reduce((n, s) => n + s.cashTipCents, 0) + late,
      serviceSalesCents: sales.reduce((n, s) => n + s.serviceCents, 0),
      productSalesCents: sales.reduce((n, s) => n + s.productCents, 0),
    };
  });

  const toAdjustment = (row: AdjustmentRecord): EarningsAdjustment => ({
    id: row.id,
    kind: row.kind,
    shopId: row.shopId,
    amountCents: row.amountCents,
    originalDate: row.originalDate,
    postedDate: row.postedDate,
    lateDeclaration: true,
    reducesPay: false,
    copy: row.copy,
  });
  const adjustments = ownAdjustments.map(toAdjustment);
  const refunds = adjustments.filter((a) => a.kind === "card_tip_refund");
  const partial = workweeks.some((w) => w.partial);
  const draft = periods.some((p) => p.periodStatus === "draft");
  const exactPeriod = periods.length === 1 && periods[0].start === from && periods[0].end === to;
  const isEstimate = opts?.snapshot ? periods[0]?.periodStatus === "draft" : exactPeriod ? periods[0].periodStatus === "draft" : draft || partial;
  const single = periods.length === 1 ? periods[0] : null;

  return {
    from,
    to,
    grossLabel: GROSS_LABEL,
    isEstimate,
    periods: periods.map((p) => ({
      id: p.id,
      start: p.start,
      end: p.end,
      periodStatus: p.periodStatus,
      payrollStatus: p.payrollStatus,
      isEstimate: p.periodStatus === "draft",
      snapshotId: p.snapshotId,
      computedAt: p.computedAt,
    })),
    snapshotId: exactPeriod ? single?.snapshotId ?? null : null,
    computedAt: exactPeriod ? single?.computedAt ?? null : new Date(`${world.today}T18:00:00.000Z`).toISOString(),
    ...pay,
    hourlyRateCents: person.hourlyRateCents,
    serviceCommissionRate: person.serviceCommissionRate,
    productCommissionRate: person.productCommissionRate,
    greaterOfCents: pay.greaterOfCents,
    productionHours: hoursOf(productionMinutes),
    trainingHours: hoursOf(trainingMinutes),
    trainingRateCents: person.trainingRateCents,
    trainingPayCents,
    regularHours: workweeks.reduce((n, w) => n + (clampRange(from, to, w.weekStart, w.weekEnd) ? w.regularHours : 0), 0),
    otHours: workweeks.reduce((n, w) => n + w.otHours, 0),
    otEstimatedCents: otPremium,
    otDisclosure: OT_PAY_LABEL,
    serviceSalesCents,
    productSalesCents,
    cardTipsCents,
    cashTipsCents,
    giftCardTipsCents,
    totalTipsCents,
    totalCents,
    workweeks,
    shops,
    adjustments,
    refunds,
    cashTipReminder: CASH_TIP_REMINDER,
  };
}

export function earningsDays(world: EarningsWorld, staffId: string, range: { from: string; to: string }): EarningsDay[] {
  const days: EarningsDay[] = [];
  for (const date of eachDate(range.from, range.to)) {
    const sales = world.sales.filter((s) => s.staffId === staffId && s.date === date);
    const hours = world.hours.filter((h) => h.staffId === staffId && h.date === date);
    const late = world.adjustments.filter((a) => a.staffId === staffId && a.kind === "late_cash_tip" && a.postedDate === date);
    if (!sales.length && !hours.length && !late.length) continue;
    days.push({
      date,
      cardTipsCents: sales.reduce((n, s) => n + s.cardTipCents, 0),
      cashTipsCents: sales.reduce((n, s) => n + s.cashTipCents, 0) + late.reduce((n, a) => n + a.amountCents, 0),
      serviceSalesCents: sales.reduce((n, s) => n + s.serviceCents, 0),
      productSalesCents: sales.reduce((n, s) => n + s.productCents, 0),
      productionHours: hoursOf(hours.reduce((n, h) => n + h.productionMinutes, 0)),
      trainingHours: hoursOf(hours.reduce((n, h) => n + h.trainingMinutes, 0)),
      tickets: sales.length,
    });
  }
  return days;
}

export function toTicket(world: EarningsWorld, sale: SaleRecord): EarningsTicket {
  const shop = shopOf(world, sale.shopId);
  const stripe = shop.tipTransfers;
  return {
    saleId: sale.id,
    shopId: sale.shopId,
    shopName: shop.name,
    clientFirstName: sale.clientFirstName,
    startedAt: sale.startedAt,
    serviceName: sale.serviceName,
    serviceCents: sale.serviceCents,
    productCents: sale.productCents,
    cardTipCents: sale.cardTipCents,
    cashTipCents: sale.cashTipCents,
    tipDisposition: stripe ? "stripe" : "payroll",
    transfer: stripe ? sale.transfer : null,
    payout: stripe ? sale.payout : null,
    lateDeclaration: false,
    originalDate: null,
  };
}

export function payrollCsv(earnings: EarningsResponse): string {
  const lines = [
    GROSS_LABEL,
    "period_start,period_end,payroll_status,production_hours,training_hours,training_pay_cents,hourly_pay_cents,service_commission_cents,product_commission_cents,top_up_cents,greater_of_cents,ot_estimated_cents,card_tips_cents,cash_tips_cents,gross_total_cents",
  ];
  const status = earnings.periods.map((p) => p.payrollStatus).join("|");
  lines.push(
    [
      earnings.from,
      earnings.to,
      status,
      earnings.productionHours,
      earnings.trainingHours,
      earnings.trainingPayCents,
      earnings.hourlyPayCents,
      earnings.serviceCommissionCents,
      earnings.productCommissionCents,
      earnings.topUpCents,
      earnings.greaterOfCents,
      earnings.otEstimatedCents,
      earnings.cardTipsCents,
      earnings.cashTipsCents,
      earnings.totalCents,
    ].join(","),
  );
  return `${lines.join("\n")}\n`;
}

export function payrollPdf(earnings: EarningsResponse): Uint8Array {
  const text = [
    GROSS_LABEL,
    `Range ${earnings.from} to ${earnings.to}`,
    `Gross total cents ${earnings.totalCents}`,
    `Card tips cents ${earnings.cardTipsCents}`,
    `Cash tips cents ${earnings.cashTipsCents}`,
    `Training pay cents ${earnings.trainingPayCents}`,
    earnings.periods.map((p) => `${p.start} ${p.payrollStatus}`).join("; "),
  ].join(" | ");
  const stream = `BT /F1 11 Tf 48 740 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  ];
  let body = "%PDF-1.1\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += `${obj}\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

export function nextOpenPeriod(world: EarningsWorld, originalDate: string): PeriodMeta {
  const home = world.periods.find((p) => originalDate >= p.start && originalDate <= p.end);
  if (home && home.periodStatus === "draft" && home.payrollStatus === "not_yet_processed") return home;
  const open = world.periods.find((p) => p.periodStatus === "draft" && p.payrollStatus === "not_yet_processed" && p.start > (home?.end ?? originalDate));
  if (!open) throw new Error("No open pay period");
  return open;
}
