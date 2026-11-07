"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Permission } from "@/domain/permissions";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { whoOf } from "@/server/inventory/ledger";
import { PoEditInput, ReceiveInput, SendInput, approvePo, cancelPo, closePoShort, createPos, receivePo, sendPo, updatePo } from "@/server/inventory/purchasing";

async function staffFor(perms: Permission | Permission[]) {
  return whoOf(await authorize(perms));
}

const refresh = (id?: string) => {
  revalidatePath("/admin/purchase-orders");
  if (id) revalidatePath(`/admin/purchase-orders/${id}`);
  revalidatePath("/admin/inventory");
  revalidatePath("/admin/inventory/low-stock");
};

/** Draft orders for one or more shops at once (each shop gets its own order). */
export async function createPosAction(input: { picks: { shopId: string; vendorId: string }[]; fill: "suggested" | "empty"; notes?: string | null }) {
  return safe(async () => {
    const who = await staffFor("po.create");
    const r = await createPos(who, input);
    refresh();
    return r;
  });
}

export async function updatePoAction(id: string, raw: z.input<typeof PoEditInput>) {
  return safe(async () => {
    const who = await staffFor("po.create");
    const r = await updatePo(who, id, raw);
    refresh(id);
    return r;
  });
}

export async function approvePoAction(id: string) {
  return safe(async () => {
    const who = await staffFor("po.approve");
    await approvePo(who, id);
    refresh(id);
    return null;
  });
}

export async function sendPoAction(id: string, raw: z.input<typeof SendInput>) {
  return safe(async () => {
    const who = await staffFor("po.send");
    const r = await sendPo(who, id, raw);
    refresh(id);
    revalidatePath("/admin/notifications");
    return r;
  });
}

export async function receivePoAction(id: string, raw: z.input<typeof ReceiveInput>) {
  return safe(async () => {
    const who = await staffFor("po.receive");
    const r = await receivePo(who, id, raw);
    refresh(id);
    return r;
  });
}

/** Cancelling an order or closing it short changes what's coming, so it's for whoever places orders. */
export async function cancelPoAction(id: string, reason: string) {
  return safe(async () => {
    const who = await staffFor(["po.create", "po.approve"]);
    await cancelPo(who, id, reason);
    refresh(id);
    return null;
  });
}

export async function closePoShortAction(id: string, reason: string) {
  return safe(async () => {
    const who = await staffFor(["po.create", "po.receive"]);
    await closePoShort(who, id, reason);
    refresh(id);
    return null;
  });
}
