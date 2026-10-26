"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import type { BrandNetworkSettings, ShopNetworkRule } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { safe } from "@/server/action";
import { TRUSTED_DEVICE_COOKIE } from "@/server/auth/cookies";
import { DEVICE_TTL, deviceCookieValue, devicesFromCookie } from "@/server/auth/network";
import { authorize, networkManager } from "@/server/auth/staff";
import { DeviceDecision, decideDevice, saveShopRule, trustThisDevice } from "@/server/sign-in-security";

function refresh() {
  revalidatePath("/admin/sign-in-security");
  revalidatePath("/admin/settings");
}

export async function saveShopRuleAction(shopId: string, rule: ShopNetworkRule) {
  return safe(async () => {
    const ctx = await authorize("network.settings");
    const saved = await saveShopRule(networkManager(ctx), z.uuid().parse(shopId), rule);
    refresh();
    return saved;
  });
}

export async function decideDeviceAction(id: string, decision: DeviceDecision) {
  return safe(async () => {
    const ctx = await authorize(["devices.approve", "network.settings"]);
    await decideDevice(networkManager(ctx), z.uuid().parse(id), z.enum(["approve", "decline", "revoke"]).parse(decision));
    refresh();
    return null;
  });
}

/** Approves the browser the manager is signed in on, for one of their shops. */
export async function trustThisDeviceAction(input: { shopId: string; label: string }) {
  return safe(async () => {
    const ctx = await authorize(["devices.approve", "network.settings"]);
    const jar = await cookies();
    const h = await headers();
    const existing = await devicesFromCookie(jar.get(TRUSTED_DEVICE_COOKIE)?.value);
    const d = await trustThisDevice(networkManager(ctx), {
      shopId: z.uuid().parse(input.shopId),
      label: String(input.label ?? ""),
      ip: clientIp(h),
      userAgent: h.get("user-agent"),
      existingHash: existing?.hash ?? null,
    });
    if (d.secret)
      jar.set(TRUSTED_DEVICE_COOKIE, await deviceCookieValue(d.secret), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: DEVICE_TTL });
    refresh();
    return null;
  });
}
