"use server";

import { revalidatePath } from "next/cache";
import type { RuleTarget } from "@/domain/checkout-prompts";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { setPromptRule } from "@/server/checkout-prompts";
import { requireInTenant } from "@/server/tenant";

const refresh = () => revalidatePath("/admin/checkout-prompts");

/** On or off for one location, role or barber; enabled null removes the override. */
export async function setPromptRuleAction(input: {
  prompt: string;
  target: RuleTarget;
  targetId: string;
  enabled: boolean | null;
}) {
  return safe(async () => {
    const ctx = await authorize("checkout_prompts.manage");
    if (input.target === "location") assertShopAccess(ctx, input.targetId);
    if (input.target === "barber")
      await requireInTenant(ctx, "staff", input.targetId);
    await setPromptRule(input, ctx.actor);
    refresh();
    return null;
  });
}
