import { isValidLocalDate } from "@/lib/time";
import { routeStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { narrowShops } from "@/server/tenant";
import { payrollCsv } from "@/server/time-clock";

/** The payroll export for a pay period: ?period=<start>&format=isolved|generic[&shop=<id>]. */
export async function GET(req: Request) {
  const ctx = await routeStaff("payroll.export");
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? "";
  const format = url.searchParams.get("format") === "generic" ? "generic" : "isolved";
  const shop = url.searchParams.get("shop");
  if (!isValidLocalDate(period)) return new Response("Pick a pay period", { status: 400 });
  try {
    const shopIds = narrowShops(ctx, shop ? [shop] : null);
    const { fileName, body } = await payrollCsv(period, shopIds, format, ctx.actor);
    return new Response(body, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
