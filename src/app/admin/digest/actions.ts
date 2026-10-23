"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { saveDigestSettings, sendTestDigest } from "@/server/digest";

export async function saveDigestAction(settings: unknown) {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't change the morning digest");
    const r = await saveDigestSettings(settings, ctx.actor);
    revalidatePath("/admin/digest");
    return r;
  });
}

export async function sendTestDigestAction() {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't change the morning digest");
    return sendTestDigest(ctx.staff.id);
  });
}
