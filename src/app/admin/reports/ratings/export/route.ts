import { LOCATION } from "@/domain/report-views";
import { can, routeStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { ratingsByShop } from "@/server/ratings";
import { toCsv } from "@/server/reports";
import { resolveRatingsParams } from "../params";

export async function GET(req: Request) {
  const ctx = await routeStaff("report.client_ratings.export");
  if (ctx instanceof Response) return ctx;
  if (!can(ctx, "report.client_ratings.view")) return new Response("You don't have permission to export this report", { status: 403 });
  let p;
  try {
    const url = new URL(req.url);
    p = await resolveRatingsParams(ctx, { ...Object.fromEntries(url.searchParams), shop: url.searchParams.getAll("shop") });
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const shops = await ratingsByShop(p.query);
  const byLocation = p.loc.view === "shops";
  const rows = shops.flatMap((s) =>
    (
      [
        ["Lowest", s.lowest],
        ["Highest", s.highest],
      ] as const
    ).flatMap(([list, xs]) =>
      xs.map((r) => [...(byLocation ? [s.shop] : []), list, r.name, r.avg.toFixed(2), r.count, r.lastRatedAt.toISOString().slice(0, 10), r.lastNote ?? ""]),
    ),
  );
  const csv = toCsv([...(byLocation ? [LOCATION] : []), "List", "Client", "Average", "Ratings", "Last rated", "Latest note"], rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rayz-client-ratings${p.loc.view === "shops" ? "-by-location" : ""}-${p.period}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
