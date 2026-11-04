"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { requireStaff } from "@/server/auth/staff";
import { moderateStaffMessage, openDirectMessage, postStaffChat } from "@/server/staff-chat";

export async function postChatAction(channelId: string, body: string) {
  return safe(async () => {
    await postStaffChat(await requireStaff(), channelId, body);
    revalidatePath("/admin/chat");
    return null;
  });
}

export async function openDmAction(otherId: string) {
  return safe(async () => {
    const id = await openDirectMessage(await requireStaff(), otherId);
    revalidatePath("/admin/chat");
    return id;
  });
}

export async function moderateChatAction(messageId: string, action: "delete" | "report") {
  return safe(async () => {
    await moderateStaffMessage(await requireStaff(), messageId, action);
    revalidatePath("/admin/chat");
    return null;
  });
}
