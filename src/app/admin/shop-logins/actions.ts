"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { StaffContext, authorize, staffGrantor } from "@/server/auth/staff";
import { LoginManager, NewShopLogin, createShopLogin, resetShopLoginPassword, setShopLoginActive } from "@/server/shop-logins";

async function manager(): Promise<LoginManager> {
  const ctx: StaffContext = await authorize("logins.manage");
  return { shopIds: ctx.shopIds, brandWide: ctx.brandWide, actor: ctx.actor, grantor: staffGrantor(ctx) };
}

export async function createShopLoginAction(raw: z.input<typeof NewShopLogin>) {
  return safe(async () => {
    const r = await createShopLogin(await manager(), raw);
    revalidatePath("/admin/shop-logins");
    return r;
  });
}

export async function setShopLoginActiveAction(id: string, active: boolean) {
  return safe(async () => {
    await setShopLoginActive(await manager(), id, active);
    revalidatePath("/admin/shop-logins");
    return null;
  });
}

export async function resetShopLoginPasswordAction(id: string) {
  return safe(async () => {
    const r = await resetShopLoginPassword(await manager(), id);
    revalidatePath("/admin/shop-logins");
    return r;
  });
}
