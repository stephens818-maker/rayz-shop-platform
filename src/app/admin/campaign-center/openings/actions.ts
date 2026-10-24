"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import {
  approveOpenings,
  mayConfigureOpenings,
  previewOpenings,
  rejectOpenings,
  removeFromOpeningsWaitlist,
  sendOpenings,
  textOpeningsWaitlist,
  withdrawOpenings,
} from "@/server/marketing/openings";
import { saveOpeningsSettings } from "@/server/marketing/settings";

const PAGE = "/admin/campaign-center/openings";
const NEED = "Sending openings needs Campaign Center: We have openings";

export async function previewOpeningsAction(input: unknown) {
  return safe(async () => previewOpenings(await authorize("campaign_center.openings", NEED), input));
}

export async function sendOpeningsAction(input: unknown) {
  return safe(async () => {
    const r = await sendOpenings(await authorize("campaign_center.openings", NEED), input);
    revalidatePath(PAGE);
    return r;
  });
}

export async function approveOpeningsAction(id: string) {
  return safe(async () => {
    const r = await approveOpenings(await authorize("campaign_center.send"), String(id));
    revalidatePath(PAGE);
    return r;
  });
}

export async function rejectOpeningsAction(id: string, note: string) {
  return safe(async () => {
    await rejectOpenings(await authorize("campaign_center.send"), String(id), String(note ?? ""));
    revalidatePath(PAGE);
    return null;
  });
}

export async function withdrawOpeningsAction(id: string) {
  return safe(async () => {
    await withdrawOpenings(await authorize("campaign_center.openings", NEED), String(id));
    revalidatePath(PAGE);
    return null;
  });
}

export async function textOpeningsWaitlistAction(id: string) {
  return safe(async () => {
    const r = await textOpeningsWaitlist(await authorize("campaign_center.openings", NEED), String(id));
    revalidatePath(PAGE);
    return r;
  });
}

export async function removeOpeningsWaitlistAction(entryId: string) {
  return safe(async () => {
    await removeFromOpeningsWaitlist(await authorize("campaign_center.openings", NEED), String(entryId));
    revalidatePath(PAGE);
    return null;
  });
}

export async function saveOpeningsSettingsAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize("campaign_center.create");
    if (!mayConfigureOpenings(ctx)) throw forbidden("The brand sets the We have openings rules: Campaign Center: create with access to all shops");
    const r = await saveOpeningsSettings(input, ctx.actor);
    revalidatePath(PAGE);
    revalidatePath("/admin/campaign-center/settings");
    return r;
  });
}
