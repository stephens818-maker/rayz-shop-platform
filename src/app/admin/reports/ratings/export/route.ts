import { LOCATION, viewOf } from "@/domain/report-views";
import { audit } from "@/server/audit";
import { can, routeStaff } from "@/server/auth/staff";
import { clientListDenied, clientPolicy, recordClientAccess } from "@/server/client-privacy";
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
  const refused = clientListDenied(ctx);
  if (refused) return new Response(refused, { status: 403 });
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

  const policy = await clientPolicy(ctx);
  if (!policy.stars({ avg: 0, count: 0 })) return new Response("Client ratings aren't shown to you", { status: 403 });
  const notes = policy.ratingDetail;
  const shops = await ratingsByShop({ ...p.query, name: policy.name });
  const byLocation = p.loc.view === "shops";
  const rows = shops.flatMap((s) =>
    (
      [
        ["Lowest", s.lowest],
        ["Highest", s.highest],
      ] as const
    ).flatMap(([list, xs]) =>
      xs.map((r) => [...(byLocation ? [s.shop] : []), list, r.name, r.avg.toFixed(2), r.count, r.lastRatedAt.toISOString().slice(0, 10), ...(notes ? [r.lastNote ?? ""] : [])]),
    ),
  );
  const csv = toCsv([...(byLocation ? [LOCATION] : []), "List", "Client", "Average", "Ratings", "Last rated", ...(notes ? ["Latest note"] : [])], rows);
  const customerIds = [...new Set(shops.flatMap((s) => [...s.lowest, ...s.highest].map((r) => r.customerId)))];
  const fields = ["ratings", ...(notes ? ["rating notes"] : [])];
  await recordClientAccess(ctx, { kind: "export", detail: { export: "client_ratings", clients: customerIds.length, fields } });
  await audit(ctx.actor, "client.export", "customer", null, { export: "client_ratings", period: p.period, clients: customerIds.length, customerIds, fields }, ctx.currentShopId);
  return csvResponse(csv, `rayz-client-ratings${byLocation ? "-by-location" : ""}-${p.period}`);
}
