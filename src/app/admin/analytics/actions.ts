"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { runBackfill } from "@/server/analytics";
import { audit } from "@/server/audit";
import { authorize } from "@/server/auth/staff";

/** Logs the history already on file now, instead of waiting for the nightly job. */
export async function runBackfillAction() {
  return safe(async () => {
    const ctx = await authorize(
      "analytics.settings",
      "You can't change the event log settings",
    );
    const r = await runBackfill({ budgetMs: 45_000 });
    await audit(ctx.actor, "analytics.backfill", "analytics_events", null, {
      done: r.done,
      remaining: r.remaining,
    });
    revalidatePath("/admin/analytics");
    return r;
  });
}
