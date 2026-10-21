"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { authorize } from "@/server/auth/staff";
import { processDueJobs } from "@/server/notifications/queue";

export async function processNowAction() {
  return safe(async () => {
    const ctx = await authorize("notifications.send");
    const stats = await processDueJobs({ limit: 500 });
    await audit(ctx.actor, "notifications.process", "notification_jobs", null, stats);
    revalidatePath("/admin/notifications");
    return stats;
  });
}
