import { LOCATION, viewOf } from "@/domain/report-views";
import { can, routeStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { ratingsByShop } from "@/server/ratings";
import { ratingsGivenTable, tableCsv } from "@/server/report-data";
import { toCsv } from "@/server/reports";
import { resolveRatingsParams } from "../params";

const csvResponse = (csv: string, name: string) =>
  new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "no-store" } });

/** The rated-client lists, or with `table=given` the ratings each barber gave, in the page's view. */
export async function GET(req: Request) {
  const ctx = await routeStaff("report.client_ratings.export");
  if (ctx instanceof Response) return ctx;
  if (!can(ctx, "report.client_ratings.view")) return new Response("You don't have permission to export this report", { status: 403 });
  const url = new URL(req.url);
  let p;
  try {
    p = await resolveRatingsParams(ctx, { ...Object.fromEntries(url.searchParams), shop: url.searchParams.getAll("shop"), staff: url.searchParams.getAll("staff") });
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const view = { combined: "", shops: "-by-location", barbers: "-by-barber", shops_barbers: "-by-location-and-barber" }[viewOf(p.loc)];
  if (url.searchParams.get("table") === "given") return csvResponse(tableCsv(await ratingsGivenTable(p.scope, p.loc)), `rayz-ratings-given${view}-${p.period}`);

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
  return csvResponse(csv, `rayz-client-ratings${byLocation ? "-by-location" : ""}-${p.period}`);
}
