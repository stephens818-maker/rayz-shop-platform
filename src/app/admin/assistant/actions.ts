"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { askAssistant, assistantConversation, assistantStart, decideAssistantAction, saveAssistantSettings } from "@/server/assistant";
import { authorize, requireStaff } from "@/server/auth/staff";

export async function askAssistantAction(conversationId: string | null, question: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    return askAssistant(ctx, { conversationId, question });
  });
}

export async function assistantConversationAction(conversationId: string | null) {
  return safe(async () => {
    const ctx = await requireStaff();
    const [conversation, suggestions] = await Promise.all([assistantConversation(ctx, conversationId), assistantStart(ctx)]);
    return { conversation, suggestions };
  });
}

export async function decideAssistantActionAction(id: string, confirm: boolean) {
  return safe(async () => {
    const ctx = await requireStaff();
    return decideAssistantAction(ctx, id, confirm);
  });
}

export async function saveAssistantSettingsAction(settings: unknown) {
  return safe(async () => {
    const ctx = await authorize("assistant.settings", "You can't change Rayz Assistant's settings");
    const r = await saveAssistantSettings(ctx, settings);
    revalidatePath("/admin/assistant/settings");
    return r;
  });
}
