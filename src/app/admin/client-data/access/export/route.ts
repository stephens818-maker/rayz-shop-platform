import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { clientListDenied } from "@/server/client-privacy";
import { accessEntries, parseAccessFilters, whoLabel } from "@/server/client-access-report";
import { toCsv } from "@/server/reports";

export async function GET(req: Request) {
  const ctx = await routeStaff("clients.privacy");
  if (ctx instanceof Response) return ctx;
  const refused = clientListDenied(ctx);
  if (refused) return new Response(refused, { status: 403 });
  const f = parseAccessFilters(Object.fromEntries(new URL(req.url).searchParams));
  const rows = await accessEntries(f, 50_000);
  const csv = toCsv(
    ["When", "Who", "What", "Field", "Client", "Client ID", "Reason", "Shop"],
    rows.map((r) => [r.at.toISOString(), whoLabel(r.actorLabel), r.what, r.fieldName, r.client, r.customerId, r.reason, r.shop ?? "All shops"]),
  );
  await audit(
    ctx.actor,
    "client_data.access_export",
    "client_access_log",
    null,
    { days: f.days, who: f.staffId ?? null, kind: f.kind ?? null, client: f.customerId ?? null, rows: rows.length },
    null,
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rayz-client-data-access-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
