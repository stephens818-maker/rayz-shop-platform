"use server";

import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { shops, staff } from "@/db/schema";
import { BLOCK_MESSAGE } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { loadStaffAccess } from "@/server/auth/access";
import { DEVICE_REQUEST_COOKIE, TRUSTED_DEVICE_COOKIE } from "@/server/auth/cookies";
import { DEVICE_TTL, approvedShopIds, deviceCookieValue, deviceTicket, devicesFromCookie, evaluateNetwork, readDeviceTicket, recordBlocked } from "@/server/auth/network";
import { endSession, startSession, verifyPassword } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { requestDevice } from "@/server/sign-in-security";

export interface LoginState {
  error: string;
  /** The sign-in was blocked by a location's rule; these shops would take an approved device. */
  blocked?: { deviceShops: { id: string; name: string }[] };
}

const cookieOpts = (maxAge: number, path = "/") => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path, maxAge });

export async function login(_prev: LoginState | null, form: FormData): Promise<LoginState | null> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const user = await verifyPassword(email, password);
  if (!user) return { error: "Email or password is incorrect" };
  const access = await loadStaffAccess(user.id);
  if (!access) return { error: "Email or password is incorrect" };
  const h = await headers();
  const jar = await cookies();
  const ip = clientIp(h);
  const device = await devicesFromCookie(jar.get(TRUSTED_DEVICE_COOKIE)?.value);
  const verdict = await evaluateNetwork(access, { ip, deviceShopIds: approvedShopIds(device) });
  if (verdict.blocked.length) {
    await recordBlocked({
      staff: user,
      roleName: access.role.name,
      verdict,
      ip,
      via: "sign_in",
      outcome: verdict.full ? "blocked" : "limited",
      userAgent: h.get("user-agent"),
      deviceIds: device?.rows.map((d) => d.id),
    });
  }
  if (verdict.full) {
    const ticket = await deviceTicket(user.id, verdict);
    if (ticket) jar.set(DEVICE_REQUEST_COOKIE, ticket, cookieOpts(15 * 60, "/login"));
    return { error: BLOCK_MESSAGE, blocked: { deviceShops: ticket ? await deviceShopsOf(verdict.blocked.filter((b) => b.require !== "ip").map((b) => b.shopId)) : [] } };
  }
  await startSession(user.id);
  await db.update(staff).set({ lastSignInAt: new Date() }).where(eq(staff.id, user.id));
  await audit({ staffId: user.id, label: `${access.role.name}:${user.displayLabel}` }, "staff.login", "staff", user.id, { ip }, access.scope === "all" ? null : (access.shopIds[0] ?? null));
  const next = String(form.get("next") ?? "");
  redirect(next.startsWith("/admin") ? next : access.permissions.has("sales.view") ? "/admin" : "/admin/calendar");
}

async function deviceShopsOf(ids: string[]) {
  const all = await db.select({ id: shops.id, name: shops.name }).from(shops);
  return all.filter((s) => ids.includes(s.id));
}

/** Shops this browser may ask device approval for, from a sign-in blocked in the last 15 minutes. */
export async function deviceRequestShops(): Promise<{ id: string; name: string }[]> {
  const t = await readDeviceTicket((await cookies()).get(DEVICE_REQUEST_COOKIE)?.value);
  return t ? deviceShopsOf(t.shopIds) : [];
}

/** After a blocked sign-in: ask a manager to approve this browser. It gets its device cookie now; it counts once approved. */
export async function requestDeviceAction(input: { shopId: string; label: string }) {
  return safe(async () => {
    const jar = await cookies();
    const t = await readDeviceTicket(jar.get(DEVICE_REQUEST_COOKIE)?.value);
    if (!t) throw forbidden("Sign in again from this device first");
    const h = await headers();
    const existing = await devicesFromCookie(jar.get(TRUSTED_DEVICE_COOKIE)?.value);
    const d = await requestDevice({
      staffId: t.staffId,
      allowedShopIds: t.shopIds,
      shopId: String(input.shopId),
      label: String(input.label ?? ""),
      ip: clientIp(h),
      userAgent: h.get("user-agent"),
      existingHash: existing?.hash ?? null,
    });
    if (d.secret) jar.set(TRUSTED_DEVICE_COOKIE, await deviceCookieValue(d.secret), cookieOpts(DEVICE_TTL));
    jar.delete({ name: DEVICE_REQUEST_COOKIE, path: "/login" });
    return { shop: d.shop };
  });
}

export async function logout() {
  await endSession();
  redirect("/login");
}
