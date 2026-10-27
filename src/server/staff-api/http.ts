import "server-only";
import { setEventActor } from "@/db/event-context";
import type { Permission } from "@/domain/permissions";
import { route } from "@/server/api";
import { StaffContext, canAny } from "@/server/auth/staff";
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
 * A /api/staff/v1 handler: the Bearer token's staff member with their permissions as of now, checked
 * here on the server before the handler runs, then the same JSON errors and CORS as /api/v1.
 */
export function staffRoute<P = Record<string, string>>(guard: Guard, fn: (req: Request, ctx: StaffAppContext, params: P) => Promise<Response>) {
  return route<P>(async (req, params) => {
    const ctx = await requireStaffApp(req);
    const list = guard.perms === null ? [] : typeof guard.perms === "string" ? [guard.perms] : guard.perms;
    if (list.length && !canAny(ctx, list)) throw forbidden(guard.message ?? "You don't have permission to do that");
    if (guard.person && ctx.staff.kind !== "person") throw new AppError("forbidden", "A shop login can't do that. Sign in to the app as yourself.");
    setEventActor(ctx.staff.id);
    return fn(req, ctx, params);
  });
}
