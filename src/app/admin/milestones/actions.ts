"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { requireStaff } from "@/server/auth/staff";
import { saveMyMilestonePrefs } from "@/server/milestones/admin";
import { cheerMilestone, markSeen, uncheerMilestone } from "@/server/milestones/views";

const Ids = z.array(z.uuid()).max(100);

/** Dismisses their congratulations notice. */
export async function dismissCongratsAction(ids: string[]) {
  return safe(async () => {
    const ctx = await requireStaff();
    const n = await markSeen(ctx, Ids.parse(ids));
    revalidatePath("/admin");
    revalidatePath("/admin/milestones");
    return { n };
  });
}

export async function cheerAction(milestoneId: string, message: string | null) {
  return safe(async () => {
    const ctx = await requireStaff();
    await cheerMilestone(ctx, z.uuid().parse(milestoneId), z.string().max(500).nullable().parse(message));
    revalidatePath("/admin/milestones");
    return null;
  });
}

export async function uncheerAction(milestoneId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await uncheerMilestone(ctx, z.uuid().parse(milestoneId));
    revalidatePath("/admin/milestones");
    return null;
  });
}

/** Their birthday (month and day) and whether teammates and clients see their milestones. */
export async function saveMyMilestonePrefsAction(input: { birthday?: { month: number; day: number } | null; shared?: boolean }) {
  return safe(async () => {
    const ctx = await requireStaff();
    await saveMyMilestonePrefs(ctx, input);
    revalidatePath("/admin/milestones");
    return null;
  });
}
