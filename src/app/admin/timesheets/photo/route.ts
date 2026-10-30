import { routeStaff } from "@/server/auth/staff";
import { punchPhoto } from "@/server/time-clock";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The photo taken with a punch (?id=<punch>), for managers at that punch's shop. */
export async function GET(req: Request) {
  const ctx = await routeStaff(["timesheet.edit", "timesheet.approve"]);
  if (ctx instanceof Response) return ctx;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const dataUrl = await punchPhoto(id, ctx.shopIds);
  const m = dataUrl?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
