"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { DEVICE_COOKIE, checkPin, clearPin, clockState, deviceFromToken, punch, registerDevice, revokeDevice, setPin, type PunchResult } from "@/server/time-clock";

const PunchType = z.enum(["in", "out", "break_start", "break_end"]);
const Gps = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable() }).nullable();
const Photo = z.string().max(400_000).nullable();

/** The caller's public address as the hosting proxy reports it (Vercel sets x-forwarded-for; its first entry is the client). */
async function requestIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || null;
}

async function thisDevice() {
  return deviceFromToken((await cookies()).get(DEVICE_COOKIE)?.value);
}

function refresh() {
  revalidatePath("/admin/clock", "layout");
  revalidatePath("/admin/timesheets", "layout");
}

/** A punch from the signed-in person's own phone or browser. */
export async function punchAction(input: { shopId: string; type: string; gps: { lat: number; lng: number; accuracyM: number | null } | null; photo: string | null; confirmTimeOff?: boolean }) {
  return safe<PunchResult>(async () => {
    const ctx = await authorize("timeclock.punch");
    const v = z.object({ shopId: z.uuid(), type: PunchType, gps: Gps, photo: Photo, confirmTimeOff: z.boolean().optional() }).parse(input);
    const device = await thisDevice();
    const r = await punch({
      staffId: ctx.staff.id,
      shopId: v.shopId,
      type: v.type,
      source: "self",
      evidence: { deviceShopId: device?.shopId ?? null, ip: await requestIp(), gps: v.gps },
      deviceId: device?.shopId === v.shopId ? device.id : null,
      photo: v.photo,
      confirmTimeOff: v.confirmTimeOff,
      actor: ctx.actor,
    });
    refresh();
    return r;
  });
}

async function kioskDevice() {
  const ctx = await authorize("timeclock.kiosk");
  const device = await thisDevice();
  if (!device || !ctx.shopIds.includes(device.shopId)) throw forbidden("This browser isn't registered as one of your shops' time clock devices.");
  return { ctx, device };
}

/** On the front-desk clock: checks someone's PIN and says what they can punch next. */
export async function kioskStatusAction(input: { staffId: string; pin: string }) {
  return safe(async () => {
    await kioskDevice();
    const v = z.object({ staffId: z.uuid(), pin: z.string().max(12) }).parse(input);
    await checkPin(v.staffId, v.pin);
    const s = await clockState(v.staffId);
    return { state: s.state, next: s.next, shop: s.shift?.shop ?? null, since: s.shift?.start.toISOString() ?? null };
  });
}

/** A punch on the front-desk clock, as the person whose PIN was typed. */
export async function kioskPunchAction(input: { staffId: string; pin: string; type: string; photo: string | null; confirmTimeOff?: boolean }) {
  return safe<PunchResult>(async () => {
    const { ctx, device } = await kioskDevice();
    const v = z.object({ staffId: z.uuid(), pin: z.string().max(12), type: PunchType, photo: Photo, confirmTimeOff: z.boolean().optional() }).parse(input);
    await checkPin(v.staffId, v.pin);
    const r = await punch({
      staffId: v.staffId,
      shopId: device.shopId,
      type: v.type,
      source: "kiosk",
      evidence: { deviceShopId: device.shopId, ip: await requestIp(), gps: null },
      deviceId: device.id,
      photo: v.photo,
      confirmTimeOff: v.confirmTimeOff,
      actor: { staffId: v.staffId, label: `kiosk:${device.label} (${ctx.staff.displayLabel})` },
    });
    refresh();
    return r;
  });
}

export async function setPinAction(pin: string) {
  return safe(async () => {
    const ctx = await authorize("timeclock.punch");
    await setPin(ctx.staff.id, z.string().max(12).parse(pin), ctx.actor);
    refresh();
    return null;
  });
}

export async function clearPinAction(staffId: string, shopId: string) {
  return safe(async () => {
    const ctx = await authorize("timesheet.edit");
    if (!ctx.shopIds.includes(shopId)) throw forbidden();
    if (staffId === ctx.staff.id) throw forbidden("Reset your own PIN on your Time clock page.");
    await clearPin(z.uuid().parse(staffId), ctx.actor, shopId);
    refresh();
    return null;
  });
}

/** Makes this browser one of a shop's front-desk clocks: a long-lived cookie holds its token. */
export async function registerDeviceAction(input: { shopId: string; label: string }) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    const v = z.object({ shopId: z.uuid(), label: z.string().max(60) }).parse(input);
    if (!ctx.shopIds.includes(v.shopId)) throw forbidden();
    const d = await registerDevice(v.shopId, v.label, ctx.actor);
    (await cookies()).set(DEVICE_COOKIE, d.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 400 * 86_400 });
    refresh();
    revalidatePath("/admin/time-clock");
    return d.id;
  });
}

export async function revokeDeviceAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("settings.shop");
    await revokeDevice(z.uuid().parse(id), ctx.shopIds, ctx.actor);
    revalidatePath("/admin/time-clock");
    return null;
  });
}
