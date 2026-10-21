"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { CountLinesInput, StartCountInput, cancelCount, postCount, saveCountLines, startCount } from "@/server/inventory/counts";
import { whoOf } from "@/server/inventory/ledger";

async function counter() {
  return whoOf(await authorize("inventory.stocktake"));
}

const refresh = (id?: string) => {
  revalidatePath("/admin/inventory/counts");
  if (id) revalidatePath(`/admin/inventory/counts/${id}`);
  revalidatePath("/admin/inventory");
};

export async function startCountAction(raw: z.input<typeof StartCountInput>) {
  return safe(async () => {
    const who = await counter();
    const r = await startCount(who, raw);
    refresh();
    return r;
  });
}

export async function saveCountAction(id: string, raw: z.input<typeof CountLinesInput>) {
  return safe(async () => {
    const who = await counter();
    await saveCountLines(who, id, raw);
    revalidatePath(`/admin/inventory/counts/${id}`);
    return null;
  });
}

export async function postCountAction(id: string, raw: z.input<typeof CountLinesInput>, zeroUncounted = false) {
  return safe(async () => {
    const who = await counter();
    await saveCountLines(who, id, raw);
    const r = await postCount(who, id, { zeroUncounted });
    refresh(id);
    return r;
  });
}

export async function cancelCountAction(id: string) {
  return safe(async () => {
    const who = await counter();
    await cancelCount(who, id);
    refresh(id);
    return null;
  });
}
