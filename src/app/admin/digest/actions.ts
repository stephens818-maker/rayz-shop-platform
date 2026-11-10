"use server";

import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { sendTestMorningDashboard } from "@/server/morning-dashboard";

export async function sendTestMorningAction() {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't change the Morning Dashboard email");
    return sendTestMorningDashboard(ctx.staff.id);
  });
}
