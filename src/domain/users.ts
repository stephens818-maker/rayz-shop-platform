/**
 * Brand portal users: invites, status and sign-in requirements. Pure: who may change whose account,
 * so nobody locks out the brand, acts on someone above them, or turns off their own safeguards.
 * What a user may do (role, permissions, locations) is decided in permissions.ts.
 */
import { Grantor, UserAccessState, staffEditDenied } from "./permissions";

export const INVITE_TTL_DAYS = 7;
export const TOTP_MAX_FAILURES = 5;
export const TOTP_LOCK_MINUTES = 15;
export const PASSWORD_MIN = 10;

export type AccountStatus = "invited" | "active" | "deactivated" | "removed";

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  invited: "Invited",
  active: "Active",
  deactivated: "Deactivated",
  removed: "Removed",
};

export function accountStatus(s: { active: boolean; hasPassword: boolean; invitedAt: Date | null; removedAt: Date | null }): AccountStatus {
  if (s.removedAt) return "removed";
  if (!s.active) return "deactivated";
  return s.invitedAt && !s.hasPassword ? "invited" : "active";
}

/** app_invite: the staff app's sign-in link by text or email. sign_out: end every staff app session and phone (a lost phone). */
export type AccountChange = "profile" | "invite" | "deactivate" | "reactivate" | "remove" | "require_2fa" | "drop_2fa" | "reset_2fa" | "app_invite" | "sign_out";

export interface AccountTarget extends UserAccessState {
  kind: "person" | "shop";
  status: AccountStatus;
  workShopIds: readonly string[];
}

const SELF: Partial<Record<AccountChange, string>> = {
  deactivate: "You can't deactivate yourself. Ask another admin.",
  remove: "You can't remove yourself. Ask another admin.",
  drop_2fa: "You can't turn off two-step sign-in for yourself. Ask another admin.",
  reset_2fa: "You can't reset your own two-step sign-in. Ask another admin.",
};

/**
 * Whether the caller may make this change to someone's account. The Brand Owner role is covered
 * like this: at least one Brand Owner who can sign in always remains, only a Brand Owner acts on
 * another, and nobody acts on a person holding access they don't have themselves.
 */
export function accountChangeDenied(
  caller: Grantor,
  target: AccountTarget,
  change: AccountChange,
  opts: { activeOwners: number; upcomingBookings?: number },
): string | null {
  if (!caller.permissions.has("permissions.manage")) return "You can't manage users";
  if (target.kind === "shop") return "Shop logins are managed under Setup → Shop logins";
  if (target.status === "removed") return "This user was removed. Invite them again as a new user.";
  if (target.staffId === caller.staffId) {
    if (SELF[change]) return SELF[change]!;
  } else {
    const denied = staffEditDenied(caller, target);
    if (denied) return denied;
  }
  if (target.isOwner && (change === "deactivate" || change === "remove") && target.status === "active" && opts.activeOwners <= 1)
    return "This is the only Brand Owner who can sign in. Make someone else Brand Owner first.";
  if (change === "deactivate" && target.status === "deactivated") return "They're already deactivated";
  if (change === "reactivate" && target.status !== "deactivated") return "They're not deactivated";
  if (change === "invite" && target.status !== "invited") return "They've already signed up. Reset their password from their staff profile instead.";
  if ((change === "app_invite" || change === "sign_out") && target.status === "deactivated") return "They're deactivated, so they're already signed out everywhere";
  if ((change === "deactivate" || change === "remove") && (opts.upcomingBookings ?? 0) > 0)
    return `They have ${opts.upcomingBookings} upcoming appointment${opts.upcomingBookings === 1 ? "" : "s"}. Offboard them from Staff first, so the shop can move their clients.`;
  return null;
}

export function passwordProblem(password: string, email: string | null): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (password.length > 200) return "That password is too long";
  if (email && password.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) return "Don't use your email in your password";
  if (new Set(password).size < 4) return "Use a less predictable password";
  return null;
}

/** Whether a sign-in must pass an authenticator code, and whether they set one up first. */
export const twoFactorStep = (s: { twoFactorRequired: boolean; totpEnabledAt: Date | null }): "code" | "enroll" | null =>
  s.totpEnabledAt ? "code" : s.twoFactorRequired ? "enroll" : null;
