import { SHOP_PART_PERMISSION } from "@/domain/permissions";
import { routeStaff } from "@/server/auth/staff";
import { staffShopPhoto } from "@/server/location-profile";
import { inTenant } from "@/server/tenant";

/** A location photo or logo in Settings, before the shop is live (the public route serves live shops only). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await routeStaff(["settings.shop", SHOP_PART_PERMISSION.details]);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!(await inTenant(ctx, "shop_photo", id))) return new Response("Not found", { status: 404 });
  const url = await staffShopPhoto(id);
  const m = url && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(url);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
