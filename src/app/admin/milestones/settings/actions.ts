"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { deleteBaseline, deleteRule, saveBaseline, saveMilestoneSettings, saveRule } from "@/server/milestones/admin";
import { runMilestones } from "@/server/milestones/engine";

const done = () => {
  revalidatePath("/admin/milestones/settings");
  revalidatePath("/admin/milestones");
};

export async function saveMilestoneSettingsAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize("milestones.settings");
    await saveMilestoneSettings(ctx, input);
    done();
    return null;
  });
}

export async function saveMilestoneRuleAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize("milestones.settings");
    const r = await saveRule(ctx, input);
    done();
    return r;
  });
}

export async function deleteMilestoneRuleAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("milestones.settings");
    await deleteRule(ctx, z.uuid().parse(id));
    done();
    return null;
  });
}

export async function saveBaselineAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize("milestones.settings");
    await saveBaseline(ctx, input);
    done();
    return null;
  });
}

export async function deleteBaselineAction(staffId: string, metric: string) {
  return safe(async () => {
    const ctx = await authorize("milestones.settings");
    await deleteBaseline(ctx, z.uuid().parse(staffId), z.string().max(40).parse(metric));
    done();
    return null;
  });
}

/** Records anything newly reached now instead of at the next hourly check, e.g. after entering Squire totals. */
export async function checkMilestonesNowAction() {
  return safe(async () => {
    await authorize("milestones.settings");
    const r = await runMilestones(new Date());
    done();
    return r;
  });
}
