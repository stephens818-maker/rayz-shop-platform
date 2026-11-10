"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { createBarberGroup, deleteBarberGroup, updateBarberGroup } from "@/server/barbers";

export async function saveBarberGroupAction(id: string | null, input: { name: string; staffIds: string[] }) {
  return safe(async () => {
    const ctx = await authorize("barber_groups.manage");
    const saved = id ? (await updateBarberGroup(ctx, id, input), id) : await createBarberGroup(ctx, input);
    revalidatePath("/admin/barber-groups");
    return { id: saved };
  });
}

export async function deleteBarberGroupAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("barber_groups.manage");
    await deleteBarberGroup(ctx, id);
    revalidatePath("/admin/barber-groups");
    return null;
  });
}
