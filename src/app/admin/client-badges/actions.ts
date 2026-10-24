"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { deleteCustomBadge, runBadgeJob, saveBadgeSettings, saveCustomBadge } from "@/server/badges";

const MESSAGE = "You can't change client badges";

export async function saveBadgeSettingsAction(settings: unknown) {
  return safe(async () => {
    const ctx = await authorize("badges.settings", MESSAGE);
    const r = await saveBadgeSettings(ctx, settings);
    revalidatePath("/admin/client-badges");
    return r;
  });
}

export async function saveCustomBadgeAction(badge: unknown) {
  return safe(async () => {
    const ctx = await authorize("badges.settings", MESSAGE);
    const id = await saveCustomBadge(ctx, badge);
    revalidatePath("/admin/client-badges");
    return id;
  });
}

export async function deleteCustomBadgeAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("badges.settings", MESSAGE);
    await deleteCustomBadge(ctx, id);
    revalidatePath("/admin/client-badges");
    return true;
  });
}

/** Works through stale badges for up to a minute; the nightly job finishes anything left. */
export async function recomputeBadgesAction() {
  return safe(async () => {
    await authorize("badges.settings", MESSAGE);
    const r = await runBadgeJob(new Date(), { budgetMs: 60_000 });
    revalidatePath("/admin/client-badges");
    return r;
  });
}
