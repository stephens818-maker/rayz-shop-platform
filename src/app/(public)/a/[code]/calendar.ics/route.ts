import { appointmentIcs } from "@/server/calendar-invites";

/** The appointment as a calendar invite, with the shop's address as its location. Anyone with the code, like the manage page. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return new Response("Not found", { status: 404 });
  const ics = await appointmentIcs(code).catch(() => null);
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="rayz-${code.toUpperCase()}.ics"`, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
