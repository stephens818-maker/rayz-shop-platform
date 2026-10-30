import { handleConnectWebhook } from "@/server/payments/connect-webhook";

export async function POST(req: Request) {
  const r = await handleConnectWebhook(await req.text(), req.headers.get("stripe-signature") ?? "", process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
  return new Response(r.body, { status: r.status });
}
