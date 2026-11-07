import { publicShopPhoto } from "@/server/location-profile";

/** A location's photo or logo, for its public page, the booking page, the widget and the app. A photo never changes under its ID. */
export async function GET(_req: Request, { params }: { params: Promise<{ shop: string; id: string }> }) {
  const { shop, id } = await params;
  const url = await publicShopPhoto(shop, id);
  const m = url && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(url);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), {
    headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=86400, immutable", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" },
  });
}
