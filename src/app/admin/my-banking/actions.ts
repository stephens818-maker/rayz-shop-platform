"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TIP_METHODS } from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { setPayoutChoice, simulateStaffOnboarding, staffDashboardUrl, staffOnboardingUrl } from "@/server/tips/accounts";

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

const choiceSchema = z.object({ method: z.enum(TIP_METHODS).nullable(), instant: z.boolean() });

export async function setMyPayoutMethodAction(input: z.input<typeof choiceSchema>) {
  return safe(async () => {
    const ctx = await me();
    const v = choiceSchema.parse(input);
    await setPayoutChoice(ctx.staff.id, v, ctx.actor);
    revalidatePath("/admin/my-tips");
    return null;
  });
}

/** Stripe-hosted setup of the employee's own debit card or bank account. In the simulator it finishes at once. */
export async function startStripeSetupAction() {
  return safe(async () => {
    const ctx = await me();
    const url = await staffOnboardingUrl(ctx.staff.id, ctx.actor, await origin());
    if (!url) await simulateStaffOnboarding(ctx.staff.id, ctx.actor);
    revalidatePath("/admin/my-tips");
    return { url };
  });
}

export async function stripeDashboardAction() {
  return safe(async () => {
    const ctx = await me();
    return { url: await staffDashboardUrl(ctx.staff.id) };
  });
}
