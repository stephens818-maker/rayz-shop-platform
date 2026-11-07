import { z } from "zod";
import { CATEGORIES } from "@/domain/analytics";
import { todayLocal } from "@/lib/time";
import { rawEventsCsv } from "@/server/analytics";
import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { isBrandLevelViewer } from "@/server/client-privacy";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Params = z.object({
  from: isoDate,
  to: isoDate,
  category: z.enum(Object.keys(CATEGORIES) as [string, ...string[]]).nullish(),
  shop: z.uuid().nullish(),
});

/**
 * The raw event log as CSV, for a BI tool: one row per event, every column in EVENT_COLUMNS. For
 * brand-level roles with "Download the raw event log"; every download is in the audit log.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff("analytics.export");
  if (ctx instanceof Response) return ctx;
  if (!ctx.brandWide || !isBrandLevelViewer(ctx))
    return new Response(
      "The raw event log can only be downloaded by brand-level roles with access to every location",
      { status: 403 },
    );
  const url = new URL(req.url);
  const today = todayLocal();
  const p = Params.safeParse({
    from: url.searchParams.get("from") ?? today,
    to: url.searchParams.get("to") ?? today,
    category: url.searchParams.get("category") || null,
    shop: url.searchParams.get("shop") || null,
  });
  if (!p.success)
    return new Response("Pick the dates as YYYY-MM-DD", { status: 400 });
  const [from, to] =
    p.data.from <= p.data.to
      ? [p.data.from, p.data.to]
      : [p.data.to, p.data.from];
  if (p.data.shop && !ctx.shopIds.includes(p.data.shop))
    return new Response("That location isn't yours", { status: 403 });
  await audit(
    ctx.actor,
    "analytics.export",
    "analytics_events",
    null,
    { from, to, category: p.data.category ?? null, shop: p.data.shop ?? null },
    ctx.currentShopId,
  );
  const body = rawEventsCsv({
    from,
    to,
    category: p.data.category ?? null,
    shopIds: p.data.shop ? [p.data.shop] : undefined,
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rayz-events-${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
