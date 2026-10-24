import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { lockedExport } from "@/server/payroll/run";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One shop's iSolved file for a locked pay period, exactly as approved. Charles uploads it by hand. */
export async function GET(req: Request) {
  const ctx = await routeStaff("payroll.run");
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const group = url.searchParams.get("group") ?? "";
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(group) || !DATE.test(start) || !DATE.test(end)) return new Response("Bad request", { status: 400 });
  const f = await lockedExport(group, start, end);
  if (!f) return new Response("That pay period isn't approved and locked yet, so there's nothing to download.", { status: 409 });
  await audit(ctx.actor, "payroll.download", "payroll_run", f.runId, { file: f.fileName });
  return new Response(new Uint8Array(f.body), {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
