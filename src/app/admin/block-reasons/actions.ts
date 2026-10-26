"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { archiveReason, moveReason, saveReason } from "@/server/block-reasons";

const NO_EDIT = "You can't edit the block reasons list";

function refresh() {
  for (const p of ["/admin/block-reasons", "/admin/calendar", "/admin/my-time", "/admin/time-off", "/admin"]) revalidatePath(p);
}

const Reason = z.object({
  id: z.string().uuid().nullable(),
  label: z.string(),
  color: z.string(),
  usedFor: z.enum(["blocks", "time_off", "both", "clock"]),
  countsAsLunch: z.boolean(),
  noticeExempt: z.boolean(),
  private: z.boolean(),
});

/** Add a reason or change one (name, color, what it's for, lunch, notice and privacy). */
export async function saveReasonAction(input: z.input<typeof Reason>) {
  return safe(async () => {
    const ctx = await authorize("blocks.reasons", NO_EDIT);
    const r = await saveReason(Reason.parse(input), ctx.actor, ctx);
    refresh();
    return r;
  });
}

export async function archiveReasonAction(id: string, archived: boolean) {
  return safe(async () => {
    const ctx = await authorize("blocks.reasons", NO_EDIT);
    await archiveReason(z.string().uuid().parse(id), archived, ctx.actor);
    refresh();
    return null;
  });
}

export async function moveReasonAction(id: string, dir: -1 | 1) {
  return safe(async () => {
    const ctx = await authorize("blocks.reasons", NO_EDIT);
    await moveReason(z.string().uuid().parse(id), dir === -1 ? -1 : 1, ctx.actor);
    refresh();
    return null;
  });
}
