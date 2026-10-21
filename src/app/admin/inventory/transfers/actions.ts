"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Permission } from "@/domain/permissions";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { whoOf } from "@/server/inventory/ledger";
import { ReceiveTransferInput, TransferInput, cancelTransfer, createTransfer, receiveTransfer, sendTransfer, updateTransfer } from "@/server/inventory/transfers";

async function staffFor(perms: Permission | Permission[]) {
  return whoOf(await authorize(perms));
}

const refresh = (id?: string) => {
  revalidatePath("/admin/inventory/transfers");
  if (id) revalidatePath(`/admin/inventory/transfers/${id}`);
  revalidatePath("/admin/inventory");
};

export async function createTransferAction(raw: z.input<typeof TransferInput>) {
  return safe(async () => {
    const who = await staffFor("inventory.transfer");
    const r = await createTransfer(who, raw);
    refresh();
    return r;
  });
}

export async function updateTransferAction(id: string, raw: { note?: string | null; lines: { productId: string; qty: number }[] }) {
  return safe(async () => {
    const who = await staffFor("inventory.transfer");
    await updateTransfer(who, id, raw);
    refresh(id);
    return null;
  });
}

export async function sendTransferAction(id: string) {
  return safe(async () => {
    const who = await staffFor("inventory.transfer");
    const r = await sendTransfer(who, id);
    refresh(id);
    return r;
  });
}

/** The receiving shop checks in what arrived, like a delivery, so receiving staff can do it too. */
export async function receiveTransferAction(id: string, raw: z.input<typeof ReceiveTransferInput>) {
  return safe(async () => {
    const who = await staffFor(["inventory.transfer", "po.receive"]);
    const r = await receiveTransfer(who, id, raw);
    refresh(id);
    return r;
  });
}

export async function cancelTransferAction(id: string) {
  return safe(async () => {
    const who = await staffFor("inventory.transfer");
    await cancelTransfer(who, id);
    refresh(id);
    return null;
  });
}
