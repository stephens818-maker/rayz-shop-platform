import Stripe from "stripe";
import { applyAccountUpdate, markDeauthorized, recordPayout } from "./connect";

/**
 * Events from the shops' connected accounts (a Connect webhook endpoint, its own signing secret):
 * onboarding and verification status, disconnects, and payouts to each shop's bank.
 */
export async function handleConnectWebhook(rawBody: string, signature: string, secret: string | undefined) {
  if (!secret) return { status: 400, body: "Stripe Connect webhook secret not configured" };
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return { status: 400, body: "Bad signature" };
  }
  const account = event.account;
  switch (event.type) {
    case "account.updated":
      await applyAccountUpdate(event.data.object as Stripe.Account);
      break;
    case "account.application.deauthorized":
      if (account) await markDeauthorized(account);
      break;
    case "payout.created":
    case "payout.updated":
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled":
      if (account) await recordPayout(account, event.data.object as Stripe.Payout);
      break;
  }
  return { status: 200, body: "ok" };
}
