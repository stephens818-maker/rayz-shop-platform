import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { finalPayFile } from "@/server/payroll/final-pay";

const UUID = /^[0-9a-f-]{36}$/i;

/** One shop's one-row iSolved file for an approved final pay. Charles uploads it by hand as an off-cycle run. */
export async function GET(req: Request) {
  const ctx = await routeStaff(["payroll.run", "payroll.export"]);
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const group = url.searchParams.get("group") ?? "";
  if (!UUID.test(id) || !UUID.test(group)) return new Response("Bad request", { status: 400 });
  if (!ctx.brandWide) return new Response("Final pay files are brand-wide.", { status: 403 });
  const f = await finalPayFile(id, group);
  if (!f) return new Response("Not found", { status: 404 });
  await audit(ctx.actor, "payroll.final_pay_download", "payroll_final_pay", f.finalPayId, { file: f.fileName, shop: f.shop }, null);
  return new Response(new Uint8Array(f.body), {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
