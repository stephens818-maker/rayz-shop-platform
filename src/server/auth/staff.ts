import "server-only";
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { shops, staff, staffShops } from "@/db/schema";
import { Actor } from "@/server/audit";
import { forbidden } from "@/server/errors";
import type { Caller } from "./policy";
import { signToken, verifyToken } from "./tokens";

export const SESSION_COOKIE = "rayz_session";
export const SHOP_COOKIE = "rayz_shop";
const SESSION_TTL = 60 * 60 * 12;

export type Role = "brand_admin" | "shop_manager" | "barber";

export interface StaffContext {
  staff: { id: string; firstName: string; displayLabel: string; role: Role; managerShopId: string | null };
  actor: Actor;
  /** Row-level scope: shops this user may read/write. */
  shopIds: string[];
  shops: { id: string; name: string; slug: string }[];
  /** Selected shop, or null for brand-wide view (brand admins only). */
  currentShopId: string | null;
  isAdmin: boolean;
  isManager: boolean;
  isBarber: boolean;
}

export async function verifyPassword(email: string, password: string) {
  const row = await db.query.staff.findFirst({ where: and(eq(staff.email, email.trim().toLowerCase()), eq(staff.active, true)) });
  if (!row?.passwordHash) return null;
  return (await bcrypt.compare(password, row.passwordHash)) ? row : null;
}

export async function startSession(staffId: string, role: Role) {
  const token = await signToken({ sub: staffId, role }, "staff_session", SESSION_TTL);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

export async function endSession() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(SHOP_COOKIE);
}

export const getStaffContext = cache(async (): Promise<StaffContext | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifyToken<{ sub: string }>(token, "staff_session");
  if (!payload) return null;
  const me = await db.query.staff.findFirst({ where: and(eq(staff.id, payload.sub), eq(staff.active, true)) });
  if (!me) return null;

  let shopRows: { id: string; name: string; slug: string }[];
  if (me.role === "brand_admin") {
    shopRows = await db.select({ id: shops.id, name: shops.name, slug: shops.slug }).from(shops).orderBy(shops.name);
  } else if (me.role === "shop_manager") {
    shopRows = me.managerShopId
      ? await db.select({ id: shops.id, name: shops.name, slug: shops.slug }).from(shops).where(eq(shops.id, me.managerShopId))
      : [];
  } else {
    const links = await db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, me.id));
    shopRows = links.length
      ? await db
          .select({ id: shops.id, name: shops.name, slug: shops.slug })
          .from(shops)
          .where(inArray(shops.id, links.map((l) => l.shopId)))
          .orderBy(shops.name)
      : [];
  }
  const shopIds = shopRows.map((s) => s.id);
  const pref = jar.get(SHOP_COOKIE)?.value;
  let currentShopId: string | null;
  if (pref === "all" && me.role === "brand_admin") currentShopId = null;
  else if (pref && shopIds.includes(pref)) currentShopId = pref;
  else currentShopId = me.role === "brand_admin" ? (shopIds[0] ?? null) : (shopIds[0] ?? null);

  return {
    staff: { id: me.id, firstName: me.firstName, displayLabel: me.displayLabel, role: me.role, managerShopId: me.managerShopId },
    actor: { staffId: me.id, label: `${me.role}:${me.displayLabel}` },
    shopIds,
    shops: shopRows,
    currentShopId,
    isAdmin: me.role === "brand_admin",
    isManager: me.role === "shop_manager",
    isBarber: me.role === "barber",
  };
});

export async function requireStaff(roles?: Role[]): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (roles && !roles.includes(ctx.staff.role)) redirect("/admin?denied=1");
  return ctx;
}

export function assertShopAccess(ctx: StaffContext, shopId: string) {
  if (!ctx.shopIds.includes(shopId)) throw forbidden("That shop is outside your access");
}

/** The shop to operate on for single-shop pages; brand admins in "all" mode fall back to the first shop. */
export function workingShopId(ctx: StaffContext, requested?: string | null): string | null {
  if (requested && ctx.shopIds.includes(requested)) return requested;
  return ctx.currentShopId ?? ctx.shopIds[0] ?? null;
}

/** Shops a report may cover: one shop, or all allowed shops in brand view. */
export function reportShopIds(ctx: StaffContext, requested?: string | null): string[] {
  if (requested && requested !== "all") {
    assertShopAccess(ctx, requested);
    return [requested];
  }
  if (requested === "all" && ctx.isAdmin) return ctx.shopIds;
  return ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
}

export function canManage(ctx: StaffContext) {
  return ctx.isAdmin || ctx.isManager;
}

export function ratingViewer(ctx: StaffContext) {
  return { staffId: ctx.staff.id, role: ctx.staff.role, shopIds: ctx.shopIds };
}

export function caller(ctx: StaffContext): Caller {
  return { staffId: ctx.staff.id, isAdmin: ctx.isAdmin, shopIds: ctx.shopIds };
}
