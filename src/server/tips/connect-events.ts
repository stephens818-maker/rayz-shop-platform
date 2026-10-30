import type Stripe from "stripe";
import { applyStaffAccountUpdate, applyStaffDeauthorized, applyStaffExternalAccount, refreshStaffAccount, staffAccountByStripeId } from "./accounts";
import { applyStaffPayoutEvent } from "./payouts";

/**
 * Connect webhook events for an employee's own Stripe account (ST-C12), already verified and
 * deduplicated by the Connect endpoint (onceOnly). Each one saves Stripe's view of the account and
 * moves it through the seven states (accountState), audited on every change: account.updated and
 * capability.updated (the transfers capability), deauthorization (rejected from then on), bank
 * accounts and cards (type, last 4 and name only), and the payouts of their tips.
 */
export async function handleStaffConnectEvent(event: Stripe.Event, account: string) {
  switch (event.type) {
    case "account.updated":
      await applyStaffAccountUpdate(event.data.object as Stripe.Account);
      break;
    case "capability.updated": {
      const a = await staffAccountByStripeId(account);
      if (a) await refreshStaffAccount(a.staffId).catch(() => null);
      break;
    }
    case "account.application.deauthorized":
      await applyStaffDeauthorized(account);
      break;
    case "account.external_account.created":
    case "account.external_account.updated":
    case "account.external_account.deleted":
      await applyStaffExternalAccount(account, event.type, event.data.object as Stripe.BankAccount | Stripe.Card);
      break;
    case "payout.created":
    case "payout.updated":
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled":
      await applyStaffPayoutEvent(account, event.data.object as Stripe.Payout);
      break;
  }
  return { status: 200, body: "ok" };
}

export const isStaffAccount = async (account: string) => !!(await staffAccountByStripeId(account));
