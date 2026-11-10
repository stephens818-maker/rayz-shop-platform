"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { whoOf } from "@/server/inventory/ledger";
import { VendorInput, VendorProductInput, removeVendorProduct, saveVendor, saveVendorProduct, setVendorActive } from "@/server/inventory/purchasing";

async function buyer() {
  return whoOf(await authorize("vendors.manage"));
}

const refresh = (id?: string) => {
  revalidatePath("/admin/vendors");
  if (id) revalidatePath(`/admin/vendors/${id}`);
};

export async function saveVendorAction(id: string | null, raw: VendorInput) {
  return safe(async () => {
    const who = await buyer();
    const v = await saveVendor(who, id, raw);
    refresh(v.id);
    return { id: v.id };
  });
}

export async function setVendorActiveAction(id: string, active: boolean) {
  return safe(async () => {
    const who = await buyer();
    await setVendorActive(who, id, active);
    refresh(id);
    return null;
  });
}

export async function saveVendorProductAction(vendorId: string, raw: z.input<typeof VendorProductInput>) {
  return safe(async () => {
    const who = await buyer();
    await saveVendorProduct(who, vendorId, raw);
    refresh(vendorId);
    return null;
  });
}

export async function removeVendorProductAction(vendorId: string, productId: string) {
  return safe(async () => {
    const who = await buyer();
    await removeVendorProduct(who, vendorId, productId);
    refresh(vendorId);
    return null;
  });
}
