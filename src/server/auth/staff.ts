import "server-only";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { setEventActor } from "@/db/event-context";
import { roles, staff } from "@/db/schema";
import type { ReasonViewer } from "@/domain/block-reasons";
import { AdminPage, PAGE_ACCESS } from "@/domain/navigation";
import { Permission, ShopScope } from "@/domain/permissions";
import { RatingViewer } from "@/domain/ratings";
import { Actor } from "@/server/audit";
import type { NetworkManager } from "@/server/sign-in-security";
import { forbidden } from "@/server/errors";
import { clientIp } from "@/lib/client-ip";
import { assertShop } from "@/server/tenant";
import { StaffAccess, accessFor, atShop, grantor, withoutShops } from "./access";
import { HANDOFF_COOKIE, SESSION_COOKIE, SHOP_COOKIE, TRUSTED_DEVICE_COOKIE } from "./cookies";
import { lockedHandoff } from "./handoff-lock";
import { approvedShopIds, devicesFromCookie, evaluateNetwork } from "./network";
import type { Caller } from "./policy";
import { SessionRef, WEB_SESSION_TTL_SECONDS, endWebSession, liveWebSession, openWebSession } from "./sessions";
import { signToken, verifyToken } from "./tokens";

export { SESSION_COOKIE, SHOP_COOKIE };

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
  /** The owner entity an entity scope covers. */
  scopeEntityId: string | null;
  /** The region a region scope covers. */
  scopeRegionId: string | null;
  /** Access to every shop, including brand-level records that belong to no shop. */
  brandWide: boolean;
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
  maxDiscountPct: number;
  /** The sign-in this request belongs to: a web session (one per browser) or a staff app session. */
  session?: SessionRef | null;
}

/** A web session for this browser: its own row (listed and signed out on its own), named by the cookie. */
export async function startSession(staffId: string, o: { ip: string | null; userAgent: string | null; browserId: string | null }) {
  const sid = await openWebSession(staffId, { ip: o.ip, userAgent: o.userAgent, deviceKey: o.browserId });
  const token = await signToken({ sub: staffId, sid }, "staff_session", WEB_SESSION_TTL_SECONDS);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  });
  return sid;
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const p = token ? await verifyToken<{ sub: string; sid?: string }>(token, "staff_session") : null;
  if (p?.sid) await endWebSession(p.sub, p.sid);
  jar.delete(SESSION_COOKIE);
  jar.delete(SHOP_COOKIE);
}

/**
 * Permissions are read from the database on every request, so a change applies at once. So is each
 * location's sign-in restriction: shops this request can't reach are left out, and with none left
 * there's no session.
 */
export const getStaffContext = cache(async (): Promise<StaffContext | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  // A device handed to a client has no staff session until a PIN takes it back, whatever the middleware let through.
  if (await lockedHandoff(jar.get(HANDOFF_COOKIE)?.value)) return null;
  const payload = await verifyToken<{ sub: string; sid?: string; iat?: number }>(token, "staff_session");
  // Every web sign-in has its session row; one that was signed out, or a cookie from before them, is no session.
  if (!payload?.sid || !(await liveWebSession(payload.sid, payload.sub))) return null;
  const device = await devicesFromCookie(jar.get(TRUSTED_DEVICE_COOKIE)?.value);
  const ctx = await staffContextOf(payload.sub, payload.iat, { ip: clientIp(await headers()), deviceShopIds: approvedShopIds(device), shopPref: jar.get(SHOP_COOKIE)?.value ?? null });
  return ctx && { ...ctx, session: { kind: "web", id: payload.sid } };
});

/**
 * One request's context for a signed-in staff member, from the web session or the staff app's token:
 * active, not signed out everywhere since `iat`, and held to each location's sign-in rule from where
 * the request comes. `shopPref` is the shop they picked ("all" for all their shops).
 */
export async function staffContextOf(staffId: string, iat: number | undefined, where: { ip: string | null; deviceShopIds: string[]; shopPref: string | null }): Promise<StaffContext | null> {
  const [row] = await db
    .select({ s: staff, r: roles })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.id, staffId), eq(staff.active, true)));
  if (!row) return null;
  const me = row.s;
  // Token times are whole seconds, so a sign-in in the same second as a reset stays valid.
  if (me.sessionsValidAfter && (iat ?? 0) < Math.floor(me.sessionsValidAfter.getTime() / 1000)) return null;
  const all = await accessFor(me, row.r);
  const verdict = await evaluateNetwork(all, { ip: where.ip, deviceShopIds: where.deviceShopIds });
  if (verdict.full) return null;
  const assigned = withoutShops(all, new Set(verdict.blocked.map((b) => b.shopId)));
  // Brand-wide people keep the all-shops view when a shop runs its own version of their role: there they get what they can do somewhere.
  const combinedView = (assigned.uniform || assigned.scope === "all") && assigned.shopIds.length > 1;
  const pref = where.shopPref;
  const open = assigned.shops.filter((s) => s.status !== "archived");
  let currentShopId: string | null;
  if (pref === "all" && combinedView) currentShopId = null;
  else if (pref && open.some((s) => s.id === pref)) currentShopId = pref;
  // The brand login starts over every shop; everyone else starts in their first shop.
  else currentShopId = assigned.scope === "all" && combinedView ? null : (open[0]?.id ?? assigned.shopIds[0] ?? null);
  // A different role at each shop: the tenant is the shop they're in, under that shop's role. Brand-wide people keep every shop in scope.
  const here = currentShopId ? assigned.byShop.get(currentShopId) : undefined;
  const access = assigned.uniform || !currentShopId ? assigned : assigned.scope === "all" && here ? { ...assigned, isOwner: here.isOwner, permissions: here.permissions, maxDiscountPct: here.maxDiscountPct, limits: here.limits } : atShop(assigned, currentShopId);
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
    scopeEntityId: access.scopeEntityId,
    scopeRegionId: access.scopeRegionId,
    brandWide: access.scope === "all",
    isOwner: access.isOwner,
    permissions: access.permissions,
    maxDiscountPct: access.maxDiscountPct,
  };
}

export const can = (ctx: Pick<StaffContext, "permissions">, p: Permission) => ctx.permissions.has(p);

/** Their dollar limits at a shop, under the role they hold there. */
export const limitsAt = (ctx: Pick<StaffContext, "access">, shopId: string) => (ctx.access.byShop.get(shopId) ?? ctx.access).limits;

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
  return authorizeContext(await requireStaff(), perms, message);
}

/**
 * authorize() for a context already in hand (the staff app's Bearer session): the same permission
 * check, the same refusal of brand-wide records to someone without every shop, the same event actor.
 * An empty list is anyone signed in.
 */
export function authorizeContext<C extends StaffContext>(ctx: C, perms: Permission | readonly Permission[], message?: string): C {
  const list = typeof perms === "string" ? [perms] : perms;
  if (list.length) {
    if (!canAny(ctx, list) && list.some((p) => ctx.access.needsAllShops.includes(p))) throw forbidden("That changes records every shop shares, so it needs access to all shops");
    assertCan(ctx, list, message);
  }
  setEventActor(ctx.staff.id);
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

/** For the sign-in restriction: the brand sets rules, managers approve devices at their shops. */
export const networkManager = (ctx: StaffContext): NetworkManager => ({
  actor: ctx.actor,
  staffId: ctx.staff.id,
  shopIds: ctx.shopIds,
  canSetRules: can(ctx, "network.settings"),
  canApprove: can(ctx, "devices.approve"),
});

/** For time off decisions and cancellations. */
export const approverOf = (ctx: StaffContext) => ({ ...caller(ctx), canApprove: can(ctx, "timeoff.approve"), isOwner: ctx.isOwner, actor: ctx.actor });
