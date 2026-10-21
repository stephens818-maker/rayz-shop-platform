import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importRuns } from "@/db/schema";
import { errorsCsv } from "@/lib/import-errors";
import { getStaffContext } from "@/server/auth/staff";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await getStaffContext();
  if (!ctx?.isAdmin) return new Response("Forbidden", { status: 403 });
  const { runId } = await params;
  const run = await db.query.importRuns.findFirst({ where: eq(importRuns.id, runId) });
  if (!run) return new Response("Not found", { status: 404 });
  const name = `${run.kind}-skipped-rows-${run.createdAt.toISOString().slice(0, 10)}.csv`;
  return new Response(errorsCsv(run.errors), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}
