import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importRuns } from "@/db/schema";
import { errorsCsv } from "@/lib/import-errors";
import { can, canAny, routeStaff } from "@/server/auth/staff";

const CATALOG_KINDS = ["catalog", "catalog_stock"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Skipped rows of a Squire import (import.run) or a catalog upload (the uploader, or anyone with every shop). */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await routeStaff(["import.run", "catalog.manage", "inventory.manage"]);
  if (ctx instanceof Response) return ctx;
  const { runId } = await params;
  if (!UUID.test(runId)) return new Response("Not found", { status: 404 });
  const run = await db.query.importRuns.findFirst({ where: eq(importRuns.id, runId) });
  if (!run) return new Response("Not found", { status: 404 });
  const allowed = CATALOG_KINDS.includes(run.kind)
    ? canAny(ctx, ["catalog.manage", "inventory.manage"]) && (ctx.brandWide || run.staffId === ctx.staff.id)
    : can(ctx, "import.run");
  if (!allowed) return new Response("You don't have permission to do that", { status: 403 });
  const name = `${run.kind}-skipped-rows-${run.createdAt.toISOString().slice(0, 10)}.csv`;
  return new Response(errorsCsv(run.errors), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}
