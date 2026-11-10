"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cleanOverrides, effectiveAccess } from "@/domain/permissions";
import { saveUserAccessAction } from "@/app/admin/permissions/actions";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { sendStaffAppInvite, signOutOfStaffApp } from "@/server/staff-api/sign-in";
import { accountOf, inviteUser, removeUser, resendInvite, resetTwoFactor, revokeInvite, setTwoFactorRequired, setUserActive, updateUserProfile } from "@/server/users";

const MANAGE = "permissions.manage" as const;
const NO = "You can't manage users";
const Id = z.string().uuid();

function revalidate() {
  revalidatePath("/admin", "layout");
}

const Name = {
  firstName: z.string().trim().min(1, "First name is required").max(40),
  lastName: z.string().trim().max(60).optional().default(""),
  displayLabel: z.string().trim().min(1, "Display name is required").max(24),
};

const InviteSchema = z.object({
  ...Name,
  email: z.string().trim().email("Enter their email"),
  roleId: Id,
  scope: z.enum(["all", "selected"]),
  shopIds: z.array(Id).default([]),
  twoFactorRequired: z.boolean().default(false),
  remote: z.boolean().default(false),
});

export async function inviteUserAction(raw: z.input<typeof InviteSchema>) {
  return safe(async () => {
    const ctx = await authorize(MANAGE, NO);
    const p = InviteSchema.parse(raw);
    if (p.scope === "selected" && !p.shopIds.length) throw new AppError("bad_request", "Pick at least one location, or all locations");
    const r = await inviteUser(ctx, p);
    revalidate();
    return r;
  });
}

export async function resendInviteAction(staffId: string) {
  return safe(async () => {
    const r = await resendInvite(await authorize(MANAGE, NO), Id.parse(staffId));
    revalidate();
    return r;
  });
}

export async function revokeInviteAction(staffId: string) {
  return safe(async () => {
    await revokeInvite(await authorize(MANAGE, NO), Id.parse(staffId));
    revalidate();
    return null;
  });
}

export async function setUserActiveAction(staffId: string, active: boolean) {
  return safe(async () => {
    await setUserActive(await authorize(MANAGE, NO), Id.parse(staffId), z.boolean().parse(active));
    revalidate();
    return null;
  });
}

export async function removeUserAction(staffId: string, confirm: string) {
  return safe(async () => {
    const ctx = await authorize(MANAGE, NO);
    const id = Id.parse(staffId);
    const { row } = await accountOf(ctx, id);
    if (confirm.trim() !== row.displayLabel) throw new AppError("bad_request", `Type "${row.displayLabel}" to confirm`);
    await removeUser(ctx, id);
    revalidate();
    return null;
  });
}

export async function setTwoFactorRequiredAction(staffId: string, on: boolean) {
  return safe(async () => {
    await setTwoFactorRequired(await authorize(MANAGE, NO), Id.parse(staffId), z.boolean().parse(on));
    revalidate();
    return null;
  });
}

export async function sendAppInviteAction(staffId: string, channel: "sms" | "email" | null) {
  return safe(async () => {
    const r = await sendStaffAppInvite(await authorize(MANAGE, NO), Id.parse(staffId), z.enum(["sms", "email"]).nullable().parse(channel));
    revalidate();
    return r;
  });
}

export async function appSignOutAction(staffId: string) {
  return safe(async () => {
    await signOutOfStaffApp(await authorize(MANAGE, NO), Id.parse(staffId));
    revalidate();
    return null;
  });
}

export async function resetTwoFactorAction(staffId: string) {
  return safe(async () => {
    await resetTwoFactor(await authorize(MANAGE, NO), Id.parse(staffId));
    revalidate();
    return null;
  });
}

const ProfileSchema = z.object({ ...Name, email: z.string().trim().email("Enter their email").or(z.literal("")).default("") });

export async function updateUserProfileAction(staffId: string, raw: z.input<typeof ProfileSchema>) {
  return safe(async () => {
    await updateUserProfile(await authorize(MANAGE, NO), Id.parse(staffId), ProfileSchema.parse(raw));
    revalidate();
    return null;
  });
}

/**
 * Remote access (exempt from each location's network rule) is the "access.remote" permission as a
 * personal override, so it goes through the same checks as any access change: nobody gives it
 * without having it, or changes their own.
 */
export async function setRemoteAccessAction(staffId: string, on: boolean) {
  return safe(async () => {
    const ctx = await authorize(MANAGE, NO);
    const id = Id.parse(staffId);
    const { row, access } = await accountOf(ctx, id);
    if (row.kind !== "person") throw new AppError("bad_request", "Shop logins are managed under Setup → Shop logins");
    const overrides = cleanOverrides(row.permissionOverrides);
    const fromRole = effectiveAccess(access.role, {}, null, access.scope).permissions.has("access.remote");
    if (on === fromRole) delete overrides["access.remote"];
    else overrides["access.remote"] = on;
    const r = await saveUserAccessAction({
      staffId: id,
      roleId: access.role.id,
      overrides,
      expires: row.permissionOverrideExpires,
      maxDiscountPct: row.maxDiscountPct,
      moneyLimits: row.moneyLimits,
      scope: access.scope,
      scopeEntityId: access.scopeEntityId,
      scopeRegionId: access.scopeRegionId,
      shopIds: access.scope === "all" ? [] : access.shopIds,
      shopRoles: access.shopRoles,
    });
    if (!r.ok) throw new AppError("forbidden", r.error);
    await audit(ctx.actor, "user.remote_access", "staff", id, { name: row.displayLabel, remoteAccess: on }, null);
    revalidate();
    return null;
  });
}
