"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { APP_SWITCHES, saveAppSwitches } from "@/server/app-switches";
import { authorize } from "@/server/auth/staff";

export async function saveAppSwitchAction(key: string, on: boolean) {
  return safe(async () => {
    const ctx = await authorize("settings.brand");
    const saved = await saveAppSwitches(ctx.actor, { [z.enum(APP_SWITCHES).parse(key)]: z.boolean().parse(on) });
    revalidatePath("/admin/app-switches");
    return saved;
  });
}
