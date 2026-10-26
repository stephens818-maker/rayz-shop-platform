"use server";

import { revalidatePath } from "next/cache";
import type { Channel } from "@/domain/marketing";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { draftBlast } from "@/server/marketing/ai-draft";
import { refineCopy, uploadEmailImage } from "@/server/marketing/email-design";
import {
  cancelBlast,
  duplicateBlast,
  pauseBlast,
  previewBlast,
  renameCampaign,
  resumeBlast,
  saveAutomation,
  saveBlast,
  scheduleBlast,
  sendTest,
  setLocationAutomation,
} from "@/server/marketing/campaigns";
import { setTemplateStatus } from "@/server/marketing/templates";
import {
  deleteSequence,
  previewSequence,
  saveSequence,
  setSequenceEnabled,
} from "@/server/marketing/sequences";

const ANY = ["campaign_center.create", "campaign_center.send"] as const;

export async function saveAutomationAction(id: string, input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Only the brand changes a campaign's wording for every location",
    );
    await saveAutomation(ctx, String(id), input);
    revalidatePath("/admin/campaign-center");
    return null;
  });
}

export async function setLocationAutomationAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      [...ANY],
      "You can't change campaigns at this location",
    );
    await setLocationAutomation(ctx, input);
    revalidatePath("/admin/campaign-center");
    return null;
  });
}

export async function saveBlastAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Writing a blast needs Campaign Center: create",
    );
    const id = await saveBlast(ctx, input);
    revalidatePath("/admin/campaign-center/blasts");
    return { id };
  });
}

export async function scheduleBlastAction(
  id: string,
  at: string | null,
  reviewed = false,
) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.send",
      "Sending a blast needs Campaign Center: send",
    );
    const when = at ? new Date(at) : null;
    if (when && Number.isNaN(when.getTime()))
      throw new AppError("bad_request", "Pick a date and time");
    const r = await scheduleBlast(ctx, String(id), when, new Date(), {
      reviewed: reviewed === true,
    });
    revalidatePath("/admin/campaign-center/blasts");
    return r;
  });
}

export async function pauseBlastAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.send",
      "Pausing a blast needs Campaign Center: send",
    );
    await pauseBlast(ctx, String(id));
    revalidatePath("/admin/campaign-center/blasts");
    return null;
  });
}

export async function resumeBlastAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.send",
      "Resuming a blast needs Campaign Center: send",
    );
    const at = await resumeBlast(ctx, String(id));
    revalidatePath("/admin/campaign-center/blasts");
    return { at: at.toISOString() };
  });
}

export async function duplicateBlastAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Copying a blast needs Campaign Center: create",
    );
    const copy = await duplicateBlast(ctx, String(id));
    revalidatePath("/admin/campaign-center/blasts");
    return { id: copy };
  });
}

export async function renameCampaignAction(id: string, name: string) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Renaming needs Campaign Center: create",
    );
    await renameCampaign(ctx, String(id), name);
    revalidatePath("/admin/campaign-center");
    revalidatePath("/admin/campaign-center/blasts");
    return null;
  });
}

export async function draftBlastAction(prompt: string) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Drafting a blast needs Campaign Center: create",
    );
    return draftBlast(ctx, prompt);
  });
}

export async function uploadEmailImageAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Adding email images needs Campaign Center: create",
    );
    return uploadEmailImage(ctx, input);
  });
}

export async function refineCopyAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Refining wording needs Campaign Center: create",
    );
    return refineCopy(ctx, input);
  });
}

export async function setTemplateStatusAction(
  id: string,
  status: "draft" | "approved" | "archived",
) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Only the brand approves templates",
    );
    if (status !== "draft" && status !== "approved" && status !== "archived")
      throw new AppError("bad_request", "Pick a status");
    await setTemplateStatus(ctx, String(id), status);
    revalidatePath("/admin/campaign-center/templates");
    return null;
  });
}

export async function cancelBlastAction(id: string) {
  return safe(async () => {
    const ctx = await authorize([...ANY], "You can't use the Campaign Center");
    await cancelBlast(ctx, String(id));
    revalidatePath("/admin/campaign-center/blasts");
    return null;
  });
}

export async function previewBlastAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize([...ANY], "You can't use the Campaign Center");
    return previewBlast(ctx, input);
  });
}

export async function sendTestAction(o: {
  campaignId: string;
  shopId: string;
  channel: Channel;
  templates?: unknown;
  promoId?: string | null;
}) {
  return safe(async () => {
    const ctx = await authorize([...ANY], "You can't use the Campaign Center");
    const r = await sendTest(ctx, o);
    return { to: r.to };
  });
}

export async function saveSequenceAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Writing a lapsed sequence needs Campaign Center: create",
    );
    const id = await saveSequence(ctx, input);
    revalidatePath("/admin/campaign-center");
    return { id };
  });
}

export async function setSequenceEnabledAction(id: string, enabled: boolean) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.send",
      "Switching a sequence on or off needs Campaign Center: send",
    );
    await setSequenceEnabled(ctx, String(id), !!enabled);
    revalidatePath("/admin/campaign-center");
    return null;
  });
}

export async function deleteSequenceAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(
      "campaign_center.create",
      "Deleting a lapsed sequence needs Campaign Center: create",
    );
    await deleteSequence(ctx, String(id));
    revalidatePath("/admin/campaign-center");
    return null;
  });
}

export async function previewSequenceAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize([...ANY], "You can't use the Campaign Center");
    return previewSequence(ctx, input);
  });
}
