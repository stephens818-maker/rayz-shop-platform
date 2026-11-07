"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { closeHelpRequest } from "@/server/identity-help";

const Close = z.object({ status: z.enum(["resolved", "dismissed"]), resolution: z.string().max(500).nullable().optional(), confirmCustomerId: z.uuid().nullable().optional() });

export async function closeHelpRequestAction(id: string, input: z.infer<typeof Close>) {
  return safe(async () => {
    const ctx = await authorize("clients.merge");
    await closeHelpRequest(ctx.actor, z.uuid().parse(id), Close.parse(input));
    revalidatePath("/admin/customers/sign-in-help");
    return null;
  });
}
