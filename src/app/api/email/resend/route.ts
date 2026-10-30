import { resendEvent } from "@/domain/notification-delivery";
import { verifySvix } from "@/lib/webhook-auth";
import { handleEmailEvent } from "@/server/notifications/email-events";

/** Resend's delivery, bounce and complaint events, signed with RESEND_WEBHOOK_SECRET (Svix). */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("Resend webhooks aren't set up", { status: 503 });
  const payload = await req.text();
  const signed = verifySvix(secret, { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") }, payload);
  if (!signed) return new Response("Bad signature", { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const e = resendEvent(body);
  if (e) await handleEmailEvent(e, "resend");
  return Response.json({ ok: true });
}
