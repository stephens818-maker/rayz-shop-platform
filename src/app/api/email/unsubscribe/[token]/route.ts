import { unsubscribeByEmailLink } from "@/server/notifications/email-events";

/** One-click unsubscribe from a mail app (List-Unsubscribe-Post, RFC 8058): no page, no confirm. */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (await unsubscribeByEmailLink(token)) ? new Response(null, { status: 204 }) : new Response("Not found", { status: 404 });
}
