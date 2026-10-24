"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEMPLATE_KINDS, TemplateKind } from "@/domain/message-templates";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { saveTemplate } from "@/server/message-templates";

const Kind = z.enum(TEMPLATE_KINDS as [TemplateKind, ...TemplateKind[]]);
const Body = z.object({ subject: z.string().max(200), body: z.string().max(2000) });

export async function saveTemplateAction(kind: string, t: { subject: string; body: string } | null) {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't edit client messages");
    const r = await saveTemplate(Kind.parse(kind), t ? Body.parse(t) : null, ctx.actor);
    revalidatePath("/admin/messages");
    return r;
  });
}
