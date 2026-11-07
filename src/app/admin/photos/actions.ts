"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { requireStaff } from "@/server/auth/staff";
import { saveShopPhoto, saveStaffPhoto } from "@/server/shop-photos";

export async function saveStaffPhotoAction(staffId: string, dataUrl: string) {
  return safe(async () => {
    await saveStaffPhoto(await requireStaff(), staffId, dataUrl);
    revalidatePath(`/admin/staff/${staffId}`);
    return null;
  });
}

export async function saveShopPhotoAction(shopId: string, dataUrl: string) {
  return safe(async () => {
    await saveShopPhoto(await requireStaff(), shopId, dataUrl);
    revalidatePath("/admin/booking-links");
    return null;
  });
}
