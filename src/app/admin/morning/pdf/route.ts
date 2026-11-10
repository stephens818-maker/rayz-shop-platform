import { renderMorningPdf } from "@/domain/morning-render";
import { reportExport, reportView } from "@/domain/permissions";
import { isValidLocalDate, todayLocal } from "@/lib/time";
import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { morningDashboardFor, morningShops } from "@/server/morning-dashboard";

/** The Morning Dashboard as a PDF, for the same shops and morning as the page. */
export async function GET(req: Request) {
  const ctx = await routeStaff([reportView("morning_dashboard")]);
  if (ctx instanceof Response) return ctx;
  if (!ctx.permissions.has(reportExport("morning_dashboard"))) return new Response("You don't have permission to export this report", { status: 403 });
  const url = new URL(req.url);
  const today = todayLocal();
  const raw = url.searchParams.get("date");
  const date = raw && isValidLocalDate(raw) && raw <= today ? raw : today;
  const eligible = morningShops(ctx.access).filter((id) => ctx.shopIds.includes(id));
  const ids = url.searchParams.getAll("shop").flatMap((s) => s.split(",")).filter(Boolean);
  const shopIds = ids.length === 0 || ids.includes("all") ? eligible : eligible.filter((id) => ids.includes(id));
  if (!shopIds.length) return new Response("You can't see the Morning Dashboard for those shops", { status: 403 });
  const d = await morningDashboardFor(ctx.access, ctx.staff.firstName, shopIds, date);
  if (!d) return new Response("Nothing to show", { status: 404 });
  await audit(ctx.actor, "report.export", "report", "morning_dashboard", { format: "pdf", date, shops: shopIds }, ctx.currentShopId);
  return new Response(Buffer.from(renderMorningPdf(d)), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="rayz-morning-dashboard-${date}.pdf"`, "Cache-Control": "no-store" },
  });
}
