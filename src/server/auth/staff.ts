import "server-only";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { roles, staff } from "@/db/schema";
import { AdminPage, PAGE_ACCESS } from "@/domain/navigation";
import { Permission, ShopScope } from "@/domain/permissions";
import { RatingViewer } from "@/domain/ratings";
import { Actor } from "@/server/audit";
import { forbidden } from "@/server/errors";
import { assertShop } from "@/server/tenant";
import { StaffAccess, accessFor, grantor } from "./access";
import type { Caller } from "./policy";
import { signToken, verifyToken } from "./tokens";

export const SESSION_COOKIE = "rayz_session";
export const SHOP_COOKIE = "rayz_shop";
const SESSION_TTL = 60 * 60 * 12;

export interface StaffContext {
  staff: { id: string; firstName: string; displayLabel: string; roleId: string; roleKey: string | null; roleName: string };
  actor: Actor;
  access: StaffAccess;
  /** Row-level scope: shops this user may read and write. */
  shopIds: string[];
  shops: { id: string; name: string; slug: string }[];
  /** Selected shop, or null for "all my shops" (people with more than one shop). */
  currentShopId: string | null;
  scope: ShopScope;
  /** Access to every shop, including brand-level records that belong to no shop. */
  brandWide: boolean;
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
  maxDiscountPct: number;
}

export async function verifyPassword(email: string, password: string) {
  const row = await db.query.staff.findFirst({ where: and(eq(staff.email, email.trim().toLowerCase()), eq(staff.active, true)) });
  if (!row?.passwordHash) return null;
  return (await bcrypt.compare(password, row.passwordHash)) ? row : null;
}

export async function startSession(staffId: string) {
  const token = await signToken({ sub: staffId }, "staff_session", SESSION_TTL);
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

/** Permissions are read from the database on every request, so a change applies at once. */
export const getStaffContext = cache(async (): Promise<StaffContext | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifyToken<{ sub: string }>(token, "staff_session");
  if (!payload) return null;
  const [row] = await db
    .select({ s: staff, r: roles })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.id, payload.sub), eq(staff.active, true)));
  if (!row) return null;
  const me = row.s;
  const access = await accessFor(me, row.r);
  const pref = jar.get(SHOP_COOKIE)?.value;
  let currentShopId: string | null;
  if (pref === "all" && access.shopIds.length > 1) currentShopId = null;
  else if (pref && access.shopIds.includes(pref)) currentShopId = pref;
  else currentShopId = access.shopIds[0] ?? null;

  return {
    staff: { id: me.id, firstName: me.firstName, displayLabel: me.displayLabel, roleId: row.r.id, roleKey: row.r.key, roleName: row.r.name },
    actor: { staffId: me.id, label: `${row.r.name}:${me.displayLabel}` },
    access,
    shopIds: access.shopIds,
    shops: access.shops,
    currentShopId,
    scope: access.scope,
    brandWide: access.scope === "all",
    isOwner: access.isOwner,
    permissions: access.permissions,
    maxDiscountPct: access.maxDiscountPct,
  };
});

export const can = (ctx: Pick<StaffContext, "permissions">, p: Permission) => ctx.permissions.has(p);
export const canAny = (ctx: Pick<StaffContext, "permissions">, ps: readonly Permission[]) => ps.some((p) => ctx.permissions.has(p));

/** Any signed-in staff member. Pages redirect to sign-in; nothing here checks a permission. */
export async function requireStaff(): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** For pages: signed in and holding at least one of these permissions, or back to the dashboard. */
export async function requirePage(perms: Permission | readonly Permission[]): Promise<StaffContext> {
  const ctx = await requireStaff();
  if (!canAny(ctx, typeof perms === "string" ? [perms] : perms)) redirect("/admin?denied=1");
  return ctx;
}

/** For admin pages: the requirement comes from PAGE_ACCESS, the same table the sidebar uses. */
export async function guardPage(page: AdminPage): Promise<StaffContext> {
  const need = PAGE_ACCESS[page] as readonly Permission[] | null;
  return need ? requirePage(need) : requireStaff();
}

/** For server actions: signed in and holding at least one of these permissions, or a forbidden error. */
export async function authorize(perms: Permission | readonly Permission[], message?: string): Promise<StaffContext> {
  const ctx = await requireStaff();
  assertCan(ctx, perms, message);
  return ctx;
}

export function assertCan(ctx: Pick<StaffContext, "permissions">, perms: Permission | readonly Permission[], message = "You don't have permission to do that") {
  if (!canAny(ctx, typeof perms === "string" ? [perms] : perms)) throw forbidden(message);
}

/** For route handlers: the context, or the response to send instead. */
export async function routeStaff(perms: Permission | readonly Permission[] | null): Promise<StaffContext | Response> {
  const ctx = await getStaffContext();
  if (!ctx) return new Response("Sign in required", { status: 401 });
  if (perms && !canAny(ctx, typeof perms === "string" ? [perms] : perms)) return new Response("You don't have permission to do that", { status: 403 });
  return ctx;
}

export const assertShopAccess = (ctx: Pick<StaffContext, "shopIds">, shopId: string) => assertShop(ctx, shopId);

/** The shop to operate on for single-shop pages; "all my shops" falls back to the first shop. */
export function workingShopId(ctx: StaffContext, requested?: string | null): string | null {
  if (requested && ctx.shopIds.includes(requested)) return requested;
  return ctx.currentShopId ?? ctx.shopIds[0] ?? null;
}

/** Shops a report may cover: one shop, or every shop this person can see. */
export function reportShopIds(ctx: StaffContext, requested?: string | null): string[] {
  if (requested && requested !== "all") {
    assertShopAccess(ctx, requested);
    return [requested];
  }
  if (requested === "all") return ctx.shopIds;
  return ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
}

export function ratingViewer(ctx: StaffContext): RatingViewer {
  return {
    staffId: ctx.staff.id,
    shopIds: ctx.shopIds,
    canRate: can(ctx, "clients.rate"),
    seesAll: can(ctx, "clients.ratings_all"),
    moderates: can(ctx, "clients.ratings_moderate"),
  };
}

export function caller(ctx: StaffContext): Caller {
  return { staffId: ctx.staff.id, brandWide: ctx.brandWide, shopIds: ctx.shopIds };
}

export const staffGrantor = (ctx: StaffContext) => grantor(ctx.access);
