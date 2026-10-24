"use server";

import { revalidatePath } from "next/cache";
import { analyticsSettingsInput } from "@/domain/analytics";
import { safe } from "@/server/action";
import { runBackfill, saveAnalyticsSettings } from "@/server/analytics";
import { audit } from "@/server/audit";
import { authorize } from "@/server/auth/staff";

export async function saveAnalyticsSettingsAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "analytics.settings",
      "You can't change the event log settings",
    );
    const r = await saveAnalyticsSettings(
      analyticsSettingsInput.parse(input),
      ctx.actor,
    );
    revalidatePath("/admin/analytics");
    return r;
  });
}

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
