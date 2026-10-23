import "server-only";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { roles, staff } from "@/db/schema";
import type { ReasonViewer } from "@/domain/block-reasons";
import { AdminPage, PAGE_ACCESS } from "@/domain/navigation";
import { Permission, ShopScope } from "@/domain/permissions";
import { RatingViewer } from "@/domain/ratings";
import { Actor } from "@/server/audit";
import { forbidden } from "@/server/errors";
import { assertShop } from "@/server/tenant";
import { StaffAccess, accessFor, atShop, grantor } from "./access";
import type { Caller } from "./policy";
import { signToken, verifyToken } from "./tokens";

export const SESSION_COOKIE = "rayz_session";
export const SHOP_COOKIE = "rayz_shop";
const SESSION_TTL = 60 * 60 * 12;

export interface StaffContext {
  staff: { id: string; firstName: string; displayLabel: string; roleId: string; roleKey: string | null; roleName: string; kind: "person" | "shop" };
  actor: Actor;
  access: StaffAccess;
  /** Row-level scope: shops this user may read and write right now. */
  shopIds: string[];
  shops: StaffAccess["shops"];
  /** Every shop they're assigned to that isn't archived: what the shop switcher offers. */
  assignedShops: StaffAccess["shops"];
  /** Whether they may work across all their shops at once; not when their role differs between them. */
  combinedView: boolean;
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
  const payload = await verifyToken<{ sub: string; iat?: number }>(token, "staff_session");
  if (!payload) return null;
  const [row] = await db
    .select({ s: staff, r: roles })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.id, payload.sub), eq(staff.active, true)));
  if (!row) return null;
  const me = row.s;
  // Token times are whole seconds, so a sign-in in the same second as a reset stays valid.
  if (me.sessionsValidAfter && (payload.iat ?? 0) < Math.floor(me.sessionsValidAfter.getTime() / 1000)) return null;
  const assigned = await accessFor(me, row.r);
  const combinedView = assigned.uniform && assigned.shopIds.length > 1;
  const pref = jar.get(SHOP_COOKIE)?.value;
  const open = assigned.shops.filter((s) => s.status !== "archived");
  let currentShopId: string | null;
  if (pref === "all" && combinedView) currentShopId = null;
  else if (pref && open.some((s) => s.id === pref)) currentShopId = pref;
  // The brand login starts over every shop; everyone else starts in their first shop.
  else currentShopId = assigned.scope === "all" && combinedView ? null : (open[0]?.id ?? assigned.shopIds[0] ?? null);
  // A different role at each shop: the tenant is the shop they're in, under that shop's role.
  const access = assigned.uniform || !currentShopId ? assigned : atShop(assigned, currentShopId);
  const role = (currentShopId && assigned.byShop.get(currentShopId)?.role) || row.r;

  return {
    staff: { id: me.id, firstName: me.firstName, displayLabel: me.displayLabel, roleId: role.id, roleKey: role.key, roleName: role.name, kind: me.kind },
    actor: { staffId: me.id, label: `${role.name}:${me.displayLabel}` },
    access,
    shopIds: access.shopIds,
    shops: access.shops,
    assignedShops: open,
    combinedView,
    currentShopId,
    scope: access.scope,
    brandWide: access.scope === "all",
    isOwner: access.isOwner,
    permissions: access.permissions,
    maxDiscountPct: access.maxDiscountPct,
  };
});

export const can = (ctx: Pick<StaffContext, "permissions">, p: Permission) => ctx.permissions.has(p);

/** Their shops that are still open for business (not archived), for pickers and day-to-day lists. Reports use all of ctx.shops. */
export const openShops = (ctx: Pick<StaffContext, "shops">) => ctx.shops.filter((s) => s.status !== "archived");
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
  const list = typeof perms === "string" ? [perms] : perms;
  if (!canAny(ctx, list) && list.some((p) => ctx.access.needsAllShops.includes(p))) throw forbidden("That changes records every shop shares, so it needs access to all shops");
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

/** For blockChangeDenied: who may block whose time. */
export const blockCaller = (ctx: StaffContext) => ({ ...caller(ctx), blocksOwn: can(ctx, "blocks.own"), blocksOthers: can(ctx, "blocks.others") });

/** For showReason: private reasons are masked unless they may see them or it's their own. */
export const reasonViewer = (ctx: StaffContext): ReasonViewer => ({ staffId: ctx.staff.id, seesPrivate: can(ctx, "blocks.private") });

/** For time off decisions and cancellations. */
export const approverOf = (ctx: StaffContext) => ({ ...caller(ctx), canApprove: can(ctx, "timeoff.approve"), isOwner: ctx.isOwner, actor: ctx.actor });
