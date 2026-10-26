"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ShopClockSettingsSchema, parseColumnMapping } from "@/domain/time-clock";
import { safe } from "@/server/action";
import { nfcTagUrl, retireNfcTag } from "@/server/clock-codes";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { assertShop } from "@/server/tenant";
import { loadClockRules, saveClockRules, saveShopClock } from "@/server/time-clock";

const Rules = z.object({
  unpaidBreakFromMinutes: z.number().int().min(0).max(240),
  autoMealMinutes: z.number().int().min(0).max(120),
  autoMealAfterHours: z.number().int().min(1).max(16),
  forgotOutAfterMinutes: z.number().int().min(10).max(720),
  maxShiftHours: z.number().int().min(4).max(24),
  graceMinutes: z.number().int().min(0).max(60),
  mapping: z.string().max(4000),
});

export async function saveClockRulesAction(input: z.infer<typeof Rules>) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = Rules.parse(input);
    const { columns, problems } = parseColumnMapping(v.mapping);
    if (problems.length) throw new AppError("bad_request", problems.join(" "));
    const current = await loadClockRules();
    await saveClockRules({ ...current, ...v, isolvedColumns: columns }, ctx.actor);
    revalidatePath("/admin/time-clock");
    return null;
  });
}

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
