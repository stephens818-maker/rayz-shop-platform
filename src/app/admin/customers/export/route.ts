import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, shops, staff } from "@/db/schema";
import { compactSegment } from "@/domain/client-filters";
import { BUILTIN_FIELDS, customFieldKey } from "@/domain/client-privacy";
import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { clientPolicy, recordClientAccess } from "@/server/client-privacy";
import { clientListQuery } from "@/server/client-list";
import { ratingSummaries } from "@/server/ratings";
import { toCsv } from "@/server/reports";

/**
 * The client list as a CSV, for people with "export the client list" (the Brand Owner, unless they
 * give it to someone): all of it, or the clients a search and filters on the list found (`q`, `f`). Each detail is exported as the exporter sees it: hidden ones are left out and
 * masked ones stay masked. Every export is audited with the clients and fields it contained.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff("clients.export");
  if (ctx instanceof Response) return ctx;
  const policy = await clientPolicy(ctx);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const list = await clientListQuery(ctx, policy, { q, f: url.searchParams.get("f") });
  if (list.problem) return new Response(list.problem, { status: 403 });
  const rows = await db
    .select({
      c: customers,
      shop: shops.name,
      preferred: staff.displayLabel,
      visits: sql<number>`(select count(*)::int from appointments a where a.customer_id = ${customers.id} and a.status = 'completed')`,
      lastVisit: sql<
        string | null
      >`(select to_char(max(starts_at) at time zone 'America/Chicago', 'YYYY-MM-DD') from appointments a where a.customer_id = ${customers.id} and a.status = 'completed')`,
    })
    .from(customers)
    .leftJoin(shops, eq(shops.id, customers.homeShopId))
    .leftJoin(staff, eq(staff.id, customers.preferredStaffId))
    .where(list.where)
    .orderBy(asc(customers.lastName), asc(customers.firstName));

  const builtins = BUILTIN_FIELDS.filter((f) => f.key !== "ratings" && f.key !== "photo" && policy.level(f.key) !== "hidden");
  const custom = policy.custom.filter((f) => policy.level(customFieldKey(f.id)) !== "hidden");
  const withRatings = policy.level("ratings") !== "hidden";
  const ratings = withRatings ? await ratingSummaries(rows.map((r) => r.c.id)) : new Map();
  const raw = (r: (typeof rows)[number], key: string) =>
    ({ phone: r.c.phone, email: r.c.email, address: r.c.address, birthday: r.c.birthday, notes: r.c.notes, preferred_barber: r.preferred })[key] ?? null;

  const headers = [
    "Client #",
    "First name",
    "Last name",
    "Nickname",
    ...builtins.map((f) => f.label),
    ...custom.map((f) => f.label),
    "Home shop",
    "Source",
    "Client since",
    "Texts",
    "Emails",
    "Visits",
    "Last visit",
    ...(withRatings ? ["Staff rating", "Ratings"] : []),
  ];
  const data = rows.map((r) => {
    const rating = withRatings ? policy.stars(ratings.get(r.c.id)) : null;
    return [
      r.c.number,
      r.c.firstName,
      r.c.lastName,
      r.c.nickname,
      ...builtins.map((f) => policy.show(f.key, raw(r, f.key))),
      ...custom.map((f) => policy.show(customFieldKey(f.id), r.c.customFields[f.id])),
      r.shop,
      r.c.source,
      r.c.createdAt.toISOString().slice(0, 10),
      r.c.smsOptIn ? "yes" : "no",
      r.c.emailOptIn ? "yes" : "no",
      r.visits,
      r.lastVisit,
      ...(withRatings ? [rating?.count ? rating.avg.toFixed(1) : "", rating?.count ?? 0] : []),
    ];
  });

  const fields = [
    ...builtins.map((f) => `${f.key}:${policy.level(f.key)}`),
    ...custom.map((f) => `${f.label}:${policy.level(customFieldKey(f.id))}`),
    ...(withRatings ? [`ratings:${policy.level("ratings")}`] : []),
  ];
  const customerIds = rows.map((r) => r.c.id);
  const filtered = { ...(q ? { search: true } : {}), ...(Object.keys(compactSegment(list.seg)).length ? { filter: compactSegment(list.seg) } : {}) };
  await recordClientAccess(ctx, { kind: "export", detail: { export: "client_list", clients: customerIds.length, fields, ...filtered } });
  await audit(ctx.actor, "client.export", "customer", null, { export: "client_list", clients: customerIds.length, fields, customerIds, ...filtered }, ctx.currentShopId);
  const name = `rayz-clients-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(toCsv(headers, data), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}
