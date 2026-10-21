import { getStaffContext } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { byBarber, byShop, cents, dailyTotals, monthlyTotals, payrollTips, salesSummary, tenderBreakdown, toCsv } from "@/server/reports";
import { resolveScope } from "../scope";

export async function GET(req: Request) {
  const ctx = await getStaffContext();
  if (!ctx) return new Response("Sign in required", { status: 401 });
  const url = new URL(req.url);
  const p = Object.fromEntries(url.searchParams) as Record<string, string>;
  const type = p.type ?? "summary";
  let scope;
  try {
    scope = resolveScope(ctx, p);
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  if (type === "payroll" && ctx.isBarber) return new Response("Managers only", { status: 403 });
  let csv: string;
  switch (type) {
    case "barbers": {
      const r = await byBarber(scope);
      csv = toCsv(
        ["Barber", "Tickets", "Services", "Net services", "Net products", "Tips", "Avg ticket"],
        r.map((x) => [x.label, x.tickets, x.services, cents(x.netServicesCents), cents(x.netProductsCents), cents(x.tipsCents), cents(x.avgTicketCents)]),
      );
      break;
    }
    case "shops": {
      const r = await byShop(scope);
      csv = toCsv(
        ["Shop", "Tickets", "Gross", "Refunds", "Net services", "Net products", "Tips"],
        r.map((x) => [x.name, x.tickets, cents(x.grossCents), cents(x.refundCents), cents(x.netServicesCents), cents(x.netProductsCents), cents(x.tipsCents)]),
      );
      break;
    }
    case "daily": {
      const r = await dailyTotals(scope);
      csv = toCsv(
        ["Date", "Tickets", "Gross", "Refunds", "Net", "Tips", "Card", "Cash"],
        r.map((x) => [x.day, x.tickets, cents(x.grossCents), cents(x.refundCents), cents(x.netCents), cents(x.tipsCents), cents(x.cardCents), cents(x.cashCents)]),
      );
      break;
    }
    case "monthly": {
      const r = await monthlyTotals(scope);
      csv = toCsv(
        ["Month", "Tickets", "Gross", "Refunds", "Net services", "Net products", "Tips"],
        r.map((x) => [x.month, x.tickets, cents(x.grossCents), cents(x.refundCents), cents(x.netServicesCents), cents(x.netProductsCents), cents(x.tipsCents)]),
      );
      break;
    }
    case "payroll": {
      const r = await payrollTips(scope);
      csv = toCsv(
        ["Period start", "Period end", "Staff ID", "Barber", "Shop", "Tickets", "Service sales", "Product sales", "Card tips", "Cash tips", "Gift card tips", "Tip refunds (already subtracted)", "Total tips"],
        r.rows.map((x) => [
          x.periodStart,
          x.periodEnd,
          x.staffCode,
          x.label,
          x.shop,
          x.tickets,
          cents(x.serviceSalesCents),
          cents(x.productSalesCents),
          cents(x.cardTipsCents),
          cents(x.cashTipsCents),
          cents(x.giftCardTipsCents),
          cents(x.tipRefundsCents),
          cents(x.totalTipsCents),
        ]),
      );
      break;
    }
    default: {
      const [s, t] = await Promise.all([salesSummary(scope), tenderBreakdown(scope)]);
      csv = toCsv(
        ["Metric", "Value"],
        [
          ["From", scope.from],
          ["To", scope.to],
          ["Tickets", s.tickets],
          ["Gross sales", cents(s.grossSalesCents)],
          ["Discounts", cents(s.discountCents)],
          ["Refunds", cents(s.refundCents)],
          ["Net services", cents(s.netServicesCents)],
          ["Net products", cents(s.netProductsCents)],
          ["Tax", cents(s.taxCents)],
          ["Tips", cents(s.tipsCents)],
          ["Card surcharges", cents(s.cardFeeCents)],
          ["Gift cards sold", cents(s.giftCardsSoldCents)],
          ["Card", cents(t.cardCents)],
          ["Card (credit)", cents(t.cardCreditCents)],
          ["Card (debit/prepaid)", cents(t.cardDebitCents)],
          ["Cash", cents(t.cashCents)],
          ["Gift card redemptions", cents(t.giftCardCents)],
        ],
      );
    }
  }
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rayz-${type}-${scope.from}-to-${scope.to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
