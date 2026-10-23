"use server";

import { revalidatePath } from "next/cache";
import type { Channel } from "@/domain/marketing";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { cancelBlast, previewBlast, saveAutomation, saveBlast, scheduleBlast, sendTest, setLocationAutomation } from "@/server/marketing/campaigns";
import { saveMarketingSettings } from "@/server/marketing/settings";

const SENDERS = ["marketing.location", "marketing.manage"] as const;

export async function saveAutomationAction(id: string, input: unknown) {
  return safe(async () => {
    const ctx = await authorize("marketing.manage", "Only the brand changes a campaign's wording for every location");
    await saveAutomation(ctx, String(id), input);
    revalidatePath("/admin/marketing");
    return null;
  });
}

export async function setLocationAutomationAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize([...SENDERS], "You can't change campaigns at this location");
    await setLocationAutomation(ctx, input);
    revalidatePath("/admin/marketing");
    return null;
  });
}

export async function saveBlastAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize([...SENDERS], "You can't send marketing");
    const id = await saveBlast(ctx, input);
    revalidatePath("/admin/marketing/blasts");
    return { id };
  });
}

export async function scheduleBlastAction(id: string, at: string | null) {
  return safe(async () => {
    const ctx = await authorize([...SENDERS], "You can't send marketing");
    const when = at ? new Date(at) : null;
    if (when && Number.isNaN(when.getTime())) throw new AppError("bad_request", "Pick a date and time");
    const r = await scheduleBlast(ctx, String(id), when);
    revalidatePath("/admin/marketing/blasts");
    return r;
  });
}

export async function cancelBlastAction(id: string) {
  return safe(async () => {
    const ctx = await authorize([...SENDERS], "You can't send marketing");
    await cancelBlast(ctx, String(id));
    revalidatePath("/admin/marketing/blasts");
    return null;
  });
}

export async function previewBlastAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize([...SENDERS], "You can't send marketing");
    return previewBlast(ctx, input);
  });
}

export async function sendTestAction(o: { campaignId: string; shopId: string; channel: Channel; templates?: unknown }) {
  return safe(async () => {
    const ctx = await authorize([...SENDERS], "You can't send marketing");
    const r = await sendTest(ctx, o);
    return { to: r.to };
  });
}

export async function saveMarketingSettingsAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize("marketing.manage", "Only the brand sets the marketing rules");
    await saveMarketingSettings(input, ctx.actor);
    revalidatePath("/admin/marketing");
    return null;
  });
}
