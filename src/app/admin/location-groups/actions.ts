"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { createLocationGroup, deleteLocationGroup, updateLocationGroup } from "@/server/locations";

export async function saveLocationGroupAction(id: string | null, input: { name: string; shopIds: string[] }) {
  return safe(async () => {
    const ctx = await authorize("locations.manage");
    const saved = id ? (await updateLocationGroup(ctx, id, input), id) : await createLocationGroup(ctx, input);
    revalidatePath("/admin/location-groups");
    return { id: saved };
  });
}

export async function deleteLocationGroupAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("locations.manage");
    await deleteLocationGroup(ctx, id);
    revalidatePath("/admin/location-groups");
    return null;
  });
}
