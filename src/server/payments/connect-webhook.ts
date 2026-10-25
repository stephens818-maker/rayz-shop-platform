import Stripe from "stripe";
import { applyStaffAccountUpdate, applyStaffExternalAccount, refreshStaffAccount, staffAccountByStripeId } from "@/server/tips/accounts";
import { applyStaffPayoutEvent } from "@/server/tips/payouts";
import { accountHolder, applyAccountUpdate, markDeauthorized, recordPayout, refreshAccount, refreshEntityAccount } from "./connect";

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
  const account = event.account;
  if (account && (await staffAccountByStripeId(account))) return staffEvent(event, account);
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

/** An employee's own Express account: onboarding status and the payouts of their tips. */
async function staffEvent(event: Stripe.Event, account: string) {
  switch (event.type) {
    case "account.updated":
      await applyStaffAccountUpdate(event.data.object as Stripe.Account);
      break;
    case "capability.updated": {
      const a = await staffAccountByStripeId(account);
      if (a) await refreshStaffAccount(a.staffId).catch(() => null);
      break;
    }
    case "account.external_account.created":
    case "account.external_account.updated":
    case "account.external_account.deleted":
      await applyStaffExternalAccount(account, event.type, event.data.object as Stripe.BankAccount | Stripe.Card);
      break;
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled":
      await applyStaffPayoutEvent(account, event.data.object as Stripe.Payout);
      break;
  }
  return { status: 200, body: "ok" };
}
