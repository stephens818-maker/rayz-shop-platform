import { postmarkEvent } from "@/domain/notification-delivery";
import { verifyBasicAuth } from "@/lib/webhook-auth";
import { handleEmailEvent } from "@/server/notifications/email-events";

/** Postmark's delivery, bounce and spam complaint webhooks, with the basic credentials in POSTMARK_WEBHOOK_AUTH ("user:password"). */
export async function POST(req: Request) {
  const expected = process.env.POSTMARK_WEBHOOK_AUTH;
  if (!expected) return new Response("Postmark webhooks aren't set up", { status: 503 });
  if (!verifyBasicAuth(req.headers.get("authorization"), expected)) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="postmark"' } });
  const body: unknown = await req.json().catch(() => null);
  if (!body) return new Response("Bad JSON", { status: 400 });
  const e = postmarkEvent(body);
  if (e) await handleEmailEvent(e, "postmark");
  return Response.json({ ok: true });
}
