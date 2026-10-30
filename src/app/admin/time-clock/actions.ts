"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ShopClockSettingsSchema } from "@/domain/time-clock";
import { safe } from "@/server/action";
import { nfcTagUrl, retireNfcTag } from "@/server/clock-codes";
import { authorize } from "@/server/auth/staff";
import { assertShop } from "@/server/tenant";
import { saveShopClock } from "@/server/time-clock";

export async function saveShopClockAction(input: { shopId: string; settings: z.infer<typeof ShopClockSettingsSchema>; latitude: number | null; longitude: number | null }) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    const v = z
      .object({ shopId: z.uuid(), settings: ShopClockSettingsSchema, latitude: z.number().min(-90).max(90).nullable(), longitude: z.number().min(-180).max(180).nullable() })
      .parse(input);
    assertShop(ctx, v.shopId);
    await saveShopClock(v.shopId, { settings: v.settings, latitude: v.latitude, longitude: v.longitude }, ctx.actor);
    revalidatePath("/admin/time-clock");
    return null;
  });
}

/** P1: the link to write to the shop's NFC sticker; retiring it makes every older sticker stop working. */
export async function nfcTagAction(shopId: string, retire = false) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    const id = z.uuid().parse(shopId);
    assertShop(ctx, id);
    const url = retire ? await retireNfcTag(id, ctx.actor) : await nfcTagUrl(id);
    if (retire) revalidatePath("/admin/time-clock");
    return { url };
  });
}
