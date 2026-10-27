"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TIP_METHODS } from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { connectMode } from "@/server/payments/connect";
import { refreshStaffAccount, setPayoutChoice, simulateDestinationChange, simulateStaffOnboarding, staffAccount, staffDashboardUrl, staffOnboardingUrl } from "@/server/tips/accounts";

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return appBaseUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function me() {
  const ctx = await authorize("tips.own");
  if (ctx.staff.kind !== "person") throw forbidden("A shop login doesn't earn tips.");
  return ctx;
}

function revalidate() {
  revalidatePath("/admin/my-banking");
  revalidatePath("/admin/my-tips");
}

const choiceSchema = z.object({ method: z.enum(TIP_METHODS).nullable(), instant: z.boolean(), acceptInstantFee: z.string().max(200).nullish() });

export async function setMyPayoutMethodAction(input: z.input<typeof choiceSchema>) {
  return safe(async () => {
    const ctx = await me();
    const v = choiceSchema.parse(input);
    await setPayoutChoice(ctx.staff.id, v, ctx.actor);
    revalidate();
    return null;
  });
}

/** Stripe-hosted setup of the employee's own debit card or bank account, also used to add what Stripe asks for later. In the simulator it finishes at once. */
export async function startStripeSetupAction() {
  return safe(async () => {
    const ctx = await me();
    const url = await staffOnboardingUrl(ctx.staff.id, ctx.actor, await origin());
    if (!url) await simulateStaffOnboarding(ctx.staff.id, ctx.actor);
    revalidate();
    return { url };
  });
}

/**
 * Stripe's Express dashboard, where the employee changes their card or bank. An account with no
 * Stripe dashboard (the default, ST-I9) changes them in the staff app's embedded account management
 * instead. In the simulator it switches between a test card and a test bank.
 */
export async function changeDestinationAction() {
  return safe(async () => {
    const ctx = await me();
    const a = await staffAccount(ctx.staff.id);
    if (a?.simulated && connectMode() === "simulator") {
      await simulateDestinationChange(ctx.staff.id, ctx.actor);
      revalidate();
      return { url: null };
    }
    if (a?.dashboard === "none" && a.detailsSubmitted) throw new AppError("conflict", "Change your card or bank in the staff app: Banking, then Manage payout account.");
    const url = await staffDashboardUrl(ctx.staff.id);
    if (!url) throw new AppError("conflict", "Stripe didn't open your payout dashboard. Finish setup first, or try again.");
    return { url };
  });
}

export async function refreshBankingAction() {
  return safe(async () => {
    const ctx = await me();
    await refreshStaffAccount(ctx.staff.id);
    revalidate();
    return { url: null };
  });
}
