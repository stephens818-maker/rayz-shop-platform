"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PlanInput } from "@/domain/memberships";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { CancelInput, EnrollInput, cancelMembership, enroll, keepMembership, savePlan, setMembershipsEnabled } from "@/server/memberships";

const refresh = () => revalidatePath("/admin/memberships");

export async function setMembershipsEnabledAction(on: boolean) {
  return safe(async () => {
    const ctx = await authorize("memberships.manage");
    await setMembershipsEnabled(ctx.actor, on);
    refresh();
    return null;
  });
}

export async function savePlanAction(id: string | null, raw: z.input<typeof PlanInput>) {
  return safe(async () => {
    const ctx = await authorize("memberships.manage");
    const p = await savePlan(ctx.actor, id, raw);
    refresh();
    return { id: p.id };
  });
}

export async function enrollAction(raw: z.input<typeof EnrollInput>) {
  return safe(async () => {
    const ctx = await authorize("memberships.sell");
    assertShopAccess(ctx, raw.homeShopId);
    const r = await enroll(ctx.actor, ctx, raw);
    refresh();
    return r;
  });
}

export async function cancelMembershipAction(raw: z.input<typeof CancelInput>) {
  return safe(async () => {
    const ctx = await authorize("memberships.sell");
    await cancelMembership(ctx.actor, ctx, raw);
    refresh();
    return null;
  });
}

export async function keepMembershipAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("memberships.sell");
    await keepMembership(ctx.actor, ctx, id);
    refresh();
    return null;
  });
}
