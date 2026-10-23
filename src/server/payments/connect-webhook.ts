import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shopPaymentAccounts } from "@/db/schema";
import { applyAccountUpdate, markDeauthorized, recordPayout, refreshAccount } from "./connect";

/**
 * Events from the shops' connected accounts (a Connect webhook endpoint, its own signing secret):
 * onboarding and verification status, disconnects, and payouts to each shop's bank. Each event
 * names its account, which maps to exactly one shop; events for accounts that aren't ours are
 * acknowledged and ignored.
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
  if (account && !(await db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.stripeAccountId, account), columns: { shopId: true } })))
    return { status: 200, body: "ignored" };
  switch (event.type) {
    case "account.updated":
      await applyAccountUpdate(event.data.object as Stripe.Account);
      break;
    case "capability.updated":
    case "account.external_account.created":
    case "account.external_account.updated":
    case "account.external_account.deleted": {
      const a = account ? await db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.stripeAccountId, account) }) : null;
      if (a) await refreshAccount(a.shopId).catch(() => null);
      break;
    }
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
