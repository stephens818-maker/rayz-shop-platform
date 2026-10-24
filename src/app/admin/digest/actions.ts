"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { saveMorningSettings, sendTestMorningDashboard } from "@/server/morning-dashboard";

export async function saveMorningSettingsAction(settings: unknown) {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't change the Morning Dashboard email");
    const r = await saveMorningSettings(settings, ctx.actor);
    revalidatePath("/admin/digest");
    return r;
  });
}

export async function sendTestMorningAction() {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't change the Morning Dashboard email");
    return sendTestMorningDashboard(ctx.staff.id);
  });
}
