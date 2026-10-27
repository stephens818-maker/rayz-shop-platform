"use server";

import { cookies, headers } from "next/headers";
import { z } from "zod";
import { clientIp } from "@/lib/client-ip";
import { safe } from "@/server/action";
import { redeemPairing } from "@/server/clock-pairing";
import { DEVICE_COOKIE } from "@/server/time-clock";

/** The tablet's side of pairing: a manager's code makes this browser the shop's front-desk clock. */
export async function pairThisDeviceAction(code: string) {
  return safe(async () => {
    const r = await redeemPairing({ code: z.string().max(20).parse(code), ip: clientIp(await headers()) });
    (await cookies()).set(DEVICE_COOKIE, r.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 400 * 86_400 });
    return { shop: r.device.shop, label: r.device.label };
  });
}
