import Stripe from "stripe";
import { handleStaffConnectEvent, isStaffAccount } from "@/server/tips/connect-events";
import { accountHolder, applyAccountUpdate, markDeauthorized, recordPayout, refreshAccount, refreshEntityAccount } from "./connect";
import { onceOnly } from "./stripe-events";

/**
 * Events from the shops' connected accounts (a Connect webhook endpoint, its own signing secret):
 * onboarding and verification status, disconnects, and payouts to each shop's bank. Each event
 * names its account, which maps to exactly one shop, one owner entity, or one employee's tip payout account;
 * events for accounts that aren't ours are acknowledged and ignored.
 */
export async function handleConnectWebhook(rawBody: string, signature: string, secret: string | undefined) {
  if (!secret) return { status: 400, body: "Stripe Connect webhook secret not configured" };
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return { status: 400, body: "Bad signature" };
  }
  return onceOnly(event, () => connectEvent(event));
}

async function connectEvent(event: Stripe.Event) {
  const account = event.account;
  if (account && (await isStaffAccount(account))) return handleStaffConnectEvent(event, account);
  const holder = account ? await accountHolder(account) : null;
  if (account && !holder) return { status: 200, body: "ignored" };
  switch (event.type) {
    case "account.updated":
      await applyAccountUpdate(event.data.object as Stripe.Account);
      break;
    case "capability.updated":
    case "account.external_account.created":
    case "account.external_account.updated":
    case "account.external_account.deleted": {
      if (holder?.kind === "shop") await refreshAccount(holder.id).catch(() => null);
      if (holder?.kind === "entity") await refreshEntityAccount(holder.id).catch(() => null);
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
