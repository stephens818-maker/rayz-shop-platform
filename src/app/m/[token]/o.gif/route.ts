import { openMarketingEmail } from "@/server/marketing/links";

export const dynamic = "force-dynamic";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** A marketing email's tracking image: counts the open, answers a transparent pixel. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await openMarketingEmail(token, req.headers.get("user-agent")).catch(() => undefined);
  return new Response(GIF, {
    status: 200,
    headers: { "Content-Type": "image/gif", "Content-Length": String(GIF.length), "Cache-Control": "no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
  });
}
