"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { reportView } from "@/domain/permissions";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { FollowUpInput, markFollowedUp } from "@/server/phone-agent";

export async function followUpCallAction(raw: z.input<typeof FollowUpInput>) {
  return safe(async () => {
    const ctx = await authorize(reportView("phone_operator"));
    await markFollowedUp(ctx.actor, ctx, raw);
    revalidatePath("/admin/phone-agent");
    return null;
  });
}
