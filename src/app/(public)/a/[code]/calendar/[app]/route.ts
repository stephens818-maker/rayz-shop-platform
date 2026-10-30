import { appointmentCalendarLink } from "@/server/calendar-invites";

/** /a/<code>/calendar/google and /a/<code>/calendar/outlook: on to the calendar's "add event" page. Anyone with the code, like the manage page. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string; app: string }> }) {
  const { code, app } = await params;
  if (!/^[A-Za-z0-9]{4,16}$/.test(code) || (app !== "google" && app !== "outlook")) return new Response("Not found", { status: 404 });
  const url = await appointmentCalendarLink(code, app).catch(() => null);
  if (!url) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
