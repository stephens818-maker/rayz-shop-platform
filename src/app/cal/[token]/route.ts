import { feedIcs } from "@/server/calendar-feeds";

/** /cal/<token>.ics: a customer's subscribed calendar. The token is the only credential; turning the feed off or making a new one ends it. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ics = await feedIcs(token.replace(/\.ics$/, "")).catch(() => null);
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=900", "X-Robots-Tag": "noindex" } });
}
