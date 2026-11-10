import { emailImage } from "@/server/marketing/email-design";

/** A marketing email's header image. Public, since email clients fetch it; an image never changes under its ID. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const img = await emailImage((await params).id);
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(img.bytes), {
    headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "X-Robots-Tag": "noindex" },
  });
}
