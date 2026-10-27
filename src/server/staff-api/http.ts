import "server-only";
import type { Permission } from "@/domain/permissions";
import { route } from "@/server/api";
import { StaffContext, assertShopAccess, authorizeContext } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { requireStaffApp } from "./auth";

export type StaffAppContext = StaffContext & { sessionId: string };

interface Guard {
  /** Any one of these; null for anyone signed in. */
  perms: Permission | readonly Permission[] | null;
  /** Their own records (tips, pay, the clock): a shop's shared login is refused. */
  person?: boolean;
  message?: string;
}

/**
 * X-Shop-Id names the shop the request works in. One they can't reach (not theirs, archived, or
 * blocked by the location's sign-in rule from where they are) is refused rather than quietly swapped
 * for another, and "all" needs a role that covers several shops.
 */
export function assertShopHeader(req: Request, ctx: StaffAppContext) {
  const h = req.headers.get("x-shop-id")?.trim();
  if (!h) return;
  if (h === "all") {
    if (!ctx.combinedView) throw forbidden("Your role works one shop at a time. Send one of your shops as X-Shop-Id.");
    return;
  }
  assertShopAccess(ctx, h);
  if (ctx.currentShopId !== h) throw forbidden("That shop is outside your access");
}

/**
 * A /api/staff/v1 handler: the Bearer token's staff member with their permissions as of now, held
 * to authorize()'s checks (authorizeContext) and to assertShopAccess() for X-Shop-Id before the
 * handler runs, then the same JSON errors and CORS as /api/v1. Every shop id or record a handler
 * takes is checked again inside, against the same context.
 */
export function staffRoute<P = Record<string, string>>(guard: Guard, fn: (req: Request, ctx: StaffAppContext, params: P) => Promise<Response>) {
  return route<P>(async (req, params) => {
    const ctx = await requireStaffApp(req);
    assertShopHeader(req, ctx);
    authorizeContext(ctx, guard.perms ?? [], guard.message);
    if (guard.person && ctx.staff.kind !== "person") throw new AppError("forbidden", "A shop login can't do that. Sign in to the app as yourself.");
    return fn(req, ctx, params);
  });
}

/** The shop a request names (a shopId field or query), else the X-Shop-Id shop; held to assertShopAccess. */
export function shopOf(ctx: StaffAppContext, shopId: string | null | undefined): string {
  const id = shopId || ctx.currentShopId;
  if (!id) throw new AppError("bad_request", "Pick a shop: send shopId, or one shop as X-Shop-Id", { field: "shopId" });
  assertShopAccess(ctx, id);
  return id;
}

/** Booked clients in the way of a block or time off, by first name only (the web shows a last initial). */
export const conflictsView = (list: readonly { id: string; code: string; startsAt: string; endsAt: string; status: string; shopId: string; shopName: string; staffId: string; customerName: string }[]) =>
  list.map((c) => ({ appointmentId: c.id, code: c.code, startsAt: c.startsAt, endsAt: c.endsAt, status: c.status, shopId: c.shopId, shop: c.shopName, staffId: c.staffId, firstName: c.customerName.split(" ")[0] ?? "" }));
