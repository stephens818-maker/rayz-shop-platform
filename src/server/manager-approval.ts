import "server-only";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import type { MoneyLimits, Permission } from "@/domain/permissions";
import { Actor } from "./audit";
import { type StaffAccess, loadStaffAccess, staffWithAccessTo } from "./auth/access";
import { AppError, forbidden } from "./errors";
import { checkPin } from "./time-clock";

/** What a manager's PIN can approve for someone who can't do it on their own. */
export type ApprovalPermission = Extract<Permission, "sales.refund" | "sales.void" | "sales.reassign">;
export const APPROVAL_LABEL: Record<ApprovalPermission, string> = { "sales.refund": "refunds", "sales.void": "voids", "sales.reassign": "reassigning tickets" };
/** The dollar limit that caps each approval, where there is one. */
const LIMIT_OF: Partial<Record<ApprovalPermission, keyof MoneyLimits>> = { "sales.refund": "refundCents", "sales.void": "refundCents" };

export interface Approval {
  staffId: string;
  pin: string;
}

export interface Approver {
  id: string;
  label: string;
  /** The most they may approve, in cents; null is no limit. */
  limitCents: number | null;
}

type Ctx = { actor: Actor; staff: { id: string; kind: string }; permissions: ReadonlySet<Permission>; access?: Pick<StaffAccess, "byShop" | "limits"> };

/** A shared shop login always needs a manager; so does anyone without the permission at this shop. */
export function needsManager(ctx: { staff: { kind: string }; permissions: ReadonlySet<Permission> }, perm: ApprovalPermission) {
  return ctx.staff.kind === "shop" || !ctx.permissions.has(perm);
}

/** Their own dollar limit for this at the shop; null is no limit. */
export function ownLimit(ctx: Ctx, shopId: string, perm: ApprovalPermission): number | null {
  const key = LIMIT_OF[perm];
  if (!key || !ctx.access) return null;
  return (ctx.access.byShop.get(shopId)?.limits ?? ctx.access.limits)[key];
}

/** People who can approve here: active, with a time clock PIN and the permission at this shop, with their limit. */
export async function approvers(shopId: string, perm: ApprovalPermission, exceptStaffId?: string | null): Promise<Approver[]> {
  const ids = await staffWithAccessTo([shopId]);
  if (!ids.length) return [];
  const rows = await db
    .select({ id: staff.id, label: staff.displayLabel })
    .from(staff)
    .where(and(inArray(staff.id, ids), eq(staff.active, true), eq(staff.kind, "person"), isNotNull(staff.clockPinHash)))
    .orderBy(asc(staff.displayLabel));
  const key = LIMIT_OF[perm];
  const ok = await Promise.all(
    rows.map(async (r): Promise<Approver | null> => {
      if (r.id === exceptStaffId) return null;
      const a = await loadStaffAccess(r.id);
      const here = a?.byShop.get(shopId);
      if (!a || !(a.isOwner || here?.permissions.has(perm))) return null;
      return { ...r, limitCents: a.isOwner || !key || !here ? null : here.limits[key] };
    }),
  );
  return ok.filter((r): r is Approver => !!r);
}

/**
 * Who is acting, with the approving manager when one is needed, and the dollar limit that applies:
 * theirs, or the approving manager's when a PIN was given. A PIN that's given is always checked,
 * and wrong ones count toward the manager's time clock lockout, like every other PIN.
 */
export async function approvedFor(ctx: Ctx, shopId: string, perm: ApprovalPermission, approval: Approval | null | undefined, now = new Date()): Promise<{ actor: Actor; limitCents: number | null }> {
  const needed = needsManager(ctx, perm);
  const given = !!approval?.staffId && !!approval.pin;
  if (!needed && !given) return { actor: ctx.actor, limitCents: ownLimit(ctx, shopId, perm) };
  if (!given) throw new AppError("forbidden", `A manager's PIN is needed for ${APPROVAL_LABEL[perm]}`, { approval: perm });
  const list = await approvers(shopId, perm, ctx.staff.id);
  const who = list.find((p) => p.id === approval!.staffId);
  if (!who) throw forbidden(`Pick a manager who can approve ${APPROVAL_LABEL[perm]} at this shop`);
  await checkPin(who.id, approval!.pin, now);
  const mine = needed ? 0 : ownLimit(ctx, shopId, perm);
  const limitCents = mine === null || who.limitCents === null ? null : Math.max(mine, who.limitCents);
  return { actor: { ...ctx.actor, approvedBy: { staffId: who.id, label: who.label } }, limitCents };
}

export async function approvedActor(ctx: Ctx, shopId: string, perm: ApprovalPermission, approval: Approval | null | undefined, now = new Date()): Promise<Actor> {
  return (await approvedFor(ctx, shopId, perm, approval, now)).actor;
}