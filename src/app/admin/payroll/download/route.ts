import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { approvedExport, ensurePayGroups, officialGroups, runRefusal } from "@/server/payroll/run";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * One shop's iSolved file once the run is approved (as locked, once it is): a pay period, or whole
 * workweeks for the shops given (`shop`, repeated). Dates that aren't whole workweeks, or that overlap
 * a locked run, are refused with why. Charles uploads it by hand.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff(["payroll.run", "payroll.export"]);
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const group = url.searchParams.get("group") ?? "";
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  const picked = url.searchParams.getAll("shop");
  if (!UUID.test(group) || !DATE.test(start) || !DATE.test(end) || picked.some((id) => !UUID.test(id)) || picked.length > 200) return new Response("Bad request", { status: 400 });
  const g = (await ensurePayGroups()).find((x) => x.id === group);
  if (!g) return new Response("Bad request", { status: 400 });
  const period = (await officialGroups(start, end)).some((x) => x.id === group);
  const shopIds = period ? null : picked.length ? picked : [g.shopId];
  if (shopIds && !shopIds.includes(g.shopId)) return new Response("Bad request", { status: 400 });
  const refused = await runRefusal(start, end, shopIds);
  if (refused) return new Response(refused, { status: 409 });
  const f = await approvedExport(group, start, end, undefined, shopIds);
  if (!f) return new Response(`${period ? "That pay period isn't" : "These dates aren't"} approved yet, or the figures changed since the approval, so there's nothing to download.`, { status: 409 });
  await audit(
    ctx.actor,
    "payroll.download",
    f.runId ? "payroll_run" : "payroll_approval",
    f.runId ?? f.approvalId,
    { file: f.fileName, periodStart: start, periodEnd: end, locked: !!f.runId, ...(shopIds ? { run: "weeks", shopIds } : {}) },
    null,
  );
  return new Response(new Uint8Array(f.body), {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
