"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { replyInThread } from "@/server/messaging";
import { requireInTenant } from "@/server/tenant";

/** A reply from the shop's number; the client's number stays on the server. */
export async function replyAction(threadId: string, body: string) {
  return safe(async () => {
    const ctx = await authorize("inbox.view", "You can't reply to client texts");
    await requireInTenant(ctx, "message_thread", threadId);
    const r = await replyInThread(threadId, String(body ?? ""), { staffId: ctx.staff.id, actor: ctx.actor });
    revalidatePath("/admin/inbox");
    revalidatePath(`/admin/inbox/${threadId}`);
    return r;
  });
}
