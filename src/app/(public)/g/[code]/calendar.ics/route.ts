import { groupIcs } from "@/server/calendar-invites";

/** A family booking as one calendar invite, with the shop's address as its location. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[A-Za-z0-9-]{4,24}$/.test(code)) return new Response("Not found", { status: 404 });
  const ics = await groupIcs(code).catch(() => null);
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="rayz-${code.toUpperCase()}.ics"`, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
