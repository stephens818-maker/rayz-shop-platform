import { openMarketingLink } from "@/server/marketing/links";

export const dynamic = "force-dynamic";

/** A marketing message's booking link: counts the click, then on to the location's booking page. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const to = await openMarketingLink(token, req.headers.get("user-agent"));
  return new Response(null, {
    status: 302,
    headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
  });
}
