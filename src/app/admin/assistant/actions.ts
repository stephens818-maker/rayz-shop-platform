"use server";

import { safe } from "@/server/action";
import { askAssistant, assistantConversation, assistantStart, decideAssistantAction } from "@/server/assistant";
import { requireStaff } from "@/server/auth/staff";

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
