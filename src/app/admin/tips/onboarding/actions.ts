"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { MAX_INVITES_AT_ONCE, sendOnboardingInvites, stopOnboardingReminders } from "@/server/tips/onboarding";

const inviteSchema = z.object({
  staffIds: z.array(z.string().uuid()).min(1, "Pick who to invite").max(MAX_INVITES_AT_ONCE, `Invite at most ${MAX_INVITES_AT_ONCE} people at once`),
  choice: z.enum(["sms", "email", "both"]),
});

function refresh() {
  revalidatePath("/admin/tips/onboarding");
  revalidatePath("/admin/cutover", "layout");
}

/** Sends payout setup invites to the people picked, at the shops this manager can see. */
export async function sendInvitesAction(input: z.input<typeof inviteSchema>) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    const v = inviteSchema.parse(input);
    const r = await sendOnboardingInvites({ actor: ctx.actor, staffIds: v.staffIds, choice: v.choice, allowedShopIds: ctx.shopIds });
    refresh();
    return r;
  });
}

export async function stopRemindersAction(staffId: string) {
  return safe(async () => {
    const ctx = await authorize("tips.approve");
    await stopOnboardingReminders(ctx.actor, z.string().uuid().parse(staffId), ctx.shopIds);
    refresh();
    return null;
  });
}
