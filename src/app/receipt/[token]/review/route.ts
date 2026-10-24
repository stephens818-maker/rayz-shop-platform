import { openReviewLink } from "@/server/reviews";

export const dynamic = "force-dynamic";

/** "Leave a review": counts the click, then on to the location's Google review page. The token never reaches Google. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const to = await openReviewLink(token, req.headers.get("user-agent"));
  return new Response(null, {
    status: 302,
    headers: {
      Location: to,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
