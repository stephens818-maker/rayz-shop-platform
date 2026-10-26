"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FIELD_KINDS } from "@/domain/compensation";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { saveCustomField, setCustomFieldActive } from "@/server/compensation";

const field = z.object({
  label: z.string().max(100),
  kind: z.enum(FIELD_KINDS),
  options: z.array(z.string().max(100)).max(50),
  position: z.number().int(),
});

function refresh() {
  revalidatePath("/admin/compensation");
  revalidatePath("/admin/staff", "layout");
}

export async function saveFieldAction(id: string | null, input: z.input<typeof field>) {
  return safe(async () => {
    const ctx = await authorize("compensation.settings");
    const saved = await saveCustomField(id === null ? null : z.uuid().parse(id), field.parse(input), ctx.actor, ctx);
    refresh();
    return saved;
  });
}

export async function setFieldActiveAction(id: string, active: boolean) {
  return safe(async () => {
    const ctx = await authorize("compensation.settings");
    await setCustomFieldActive(z.uuid().parse(id), z.boolean().parse(active), ctx.actor);
    refresh();
  });
}
