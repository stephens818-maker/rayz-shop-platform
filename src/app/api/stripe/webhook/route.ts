import { handleStripeWebhook } from "@/server/payments/webhook";

export async function POST(req: Request) {
  const r = await handleStripeWebhook(await req.text(), req.headers.get("stripe-signature") ?? "", process.env.STRIPE_WEBHOOK_SECRET);
  return new Response(r.body, { status: r.status });
}
