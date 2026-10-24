import "server-only";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import type { Permission } from "@/domain/permissions";
import { Actor } from "./audit";
import { loadStaffAccess, staffWithAccessTo } from "./auth/access";
import { AppError, forbidden } from "./errors";
import { checkPin } from "./time-clock";

/** What a manager's PIN can approve for someone who can't do it on their own. */
export type ApprovalPermission = Extract<Permission, "sales.refund" | "sales.reassign">;
export const APPROVAL_LABEL: Record<ApprovalPermission, string> = { "sales.refund": "refunds and voids", "sales.reassign": "reassigning tickets" };

export interface Approval {
  staffId: string;
  pin: string;
}

/** A shared shop login always needs a manager; so does anyone without the permission at this shop. */
export function needsManager(ctx: { staff: { kind: string }; permissions: ReadonlySet<Permission> }, perm: ApprovalPermission) {
  return ctx.staff.kind === "shop" || !ctx.permissions.has(perm);
}

/** People who can approve here: active, with a time clock PIN and the permission at this shop. */
export async function approvers(shopId: string, perm: ApprovalPermission, exceptStaffId?: string | null) {
  const ids = await staffWithAccessTo([shopId]);
  if (!ids.length) return [];
  const rows = await db
    .select({ id: staff.id, label: staff.displayLabel })
    .from(staff)
    .where(and(inArray(staff.id, ids), eq(staff.active, true), eq(staff.kind, "person"), isNotNull(staff.clockPinHash)))
    .orderBy(asc(staff.displayLabel));
  const ok = await Promise.all(
    rows.map(async (r) => {
      if (r.id === exceptStaffId) return null;
      const a = await loadStaffAccess(r.id);
      return a && (a.isOwner || a.byShop.get(shopId)?.permissions.has(perm)) ? r : null;
    }),
  );
  return ok.filter((r): r is { id: string; label: string } => !!r);
}

/**
 * Who is acting, with the approving manager when one is needed. Wrong PINs count toward the
 * manager's time clock lockout, like every other PIN.
 */
export async function approvedActor(
  ctx: { actor: Actor; staff: { id: string; kind: string }; permissions: ReadonlySet<Permission> },
  shopId: string,
  perm: ApprovalPermission,
  approval: Approval | null | undefined,
  now = new Date(),
): Promise<Actor> {
  if (!needsManager(ctx, perm)) return ctx.actor;
  if (!approval?.staffId || !approval.pin) throw new AppError("forbidden", `A manager's PIN is needed for ${APPROVAL_LABEL[perm]}`, { approval: perm });
  const list = await approvers(shopId, perm, ctx.staff.id);
  const who = list.find((p) => p.id === approval.staffId);
  if (!who) throw forbidden(`Pick a manager who can approve ${APPROVAL_LABEL[perm]} at this shop`);
  await checkPin(who.id, approval.pin, now);
  return { ...ctx.actor, approvedBy: { staffId: who.id, label: who.label } };
}
