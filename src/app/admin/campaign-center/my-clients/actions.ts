"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { sendToMyClients } from "@/server/marketing/my-clients";

export async function sendToMyClientsAction(customerIds: string[]) {
  return safe(async () => {
    const ctx = await authorize("campaign_center.own_clients", "Messaging your lapsed clients needs Campaign Center: own lapsed clients");
    const r = await sendToMyClients(ctx, Array.isArray(customerIds) ? customerIds.map(String) : []);
    revalidatePath("/admin/campaign-center/my-clients");
    return r;
  });
}
