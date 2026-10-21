import { getStaffContext } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { ratingsByShop } from "@/server/ratings";
import { toCsv } from "@/server/reports";
import { resolveRatingsParams } from "../params";

export async function GET(req: Request) {
  const ctx = await getStaffContext();
  if (!ctx) return new Response("Sign in required", { status: 401 });
  if (ctx.isBarber) return new Response("Managers only", { status: 403 });
  let p;
  try {
    p = resolveRatingsParams(ctx, Object.fromEntries(new URL(req.url).searchParams));
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const shops = await ratingsByShop({ shopIds: p.shopIds, minRatings: p.min, since: p.since, limit: 10 });
  const rows = shops.flatMap((s) =>
    (
      [
        ["Lowest", s.lowest],
        ["Highest", s.highest],
      ] as const
    ).flatMap(([list, xs]) => xs.map((r) => [s.shop, list, r.name, r.avg.toFixed(2), r.count, r.lastRatedAt.toISOString().slice(0, 10), r.lastNote ?? ""])),
  );
  const csv = toCsv(["Shop", "List", "Client", "Average", "Ratings", "Last rated", "Latest note"], rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rayz-client-ratings-${p.period}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
