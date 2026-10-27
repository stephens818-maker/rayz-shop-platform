/**
 * Staff sign-in hardening (ST-C0c), pure: password lockout, who must use two-step sign-in, how
 * fresh a sign-in must be for reveal, export and refund, and the 30-day idle rule.
 */
import type { Permission } from "./permissions";

/** Wrong passwords in a row before the account locks; the email's rate limit matches it, so a lock never shows an account exists. */
export const PASSWORD_LOCK_EVERY = 10;
export const PASSWORD_LOCK_MINUTES = 15;
const PASSWORD_LOCK_MAX_MINUTES = 24 * 60;
/** Sign-in attempts per address, and wrong passwords per email, in the window; web and staff app each. */
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_PER_IP = 30;
export const LOGIN_PER_EMAIL = PASSWORD_LOCK_EVERY;
export const TOO_MANY_SIGN_INS = `Too many sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes, or ask a manager to help you sign in.`;

/** A lock after every 10th wrong password in a row: 15 minutes, doubling each time, at most a day. */
export function passwordLock(failures: number, now: Date): Date | null {
  if (failures <= 0 || failures % PASSWORD_LOCK_EVERY) return null;
  const minutes = Math.min(PASSWORD_LOCK_MAX_MINUTES, PASSWORD_LOCK_MINUTES * 2 ** (failures / PASSWORD_LOCK_EVERY - 1));
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Permissions that make a role privileged: managing people and access, money out, pay, exports of
 * client or pay data, brand settings. Anyone holding one at any shop must use two-step sign-in.
 */
export const PRIVILEGED_PERMISSIONS = [
  "permissions.manage",
  "logins.manage",
  "staff.manage",
  "devices.approve",
  "network.settings",
  "payroll.run",
  "payroll.approve",
  "payroll.export",
  "payroll.rates",
  "compensation.edit",
  "compensation.settings",
  "tips.approve",
  "tips.settings",
  "payouts.manage",
  "payouts.chain",
  "payments.accounts",
  "payments.banking",
  "exports.accounting",
  "clients.export",
  "clients.privacy",
  "campaign_center.export",
  "report_builder.export",
  "analytics.export",
  "settings.brand",
  "import.run",
  "locations.manage",
] as const satisfies readonly Permission[];

export const isPrivileged = (permissions: Iterable<Permission>) => {
  const set = new Set(permissions);
  return PRIVILEGED_PERMISSIONS.some((p) => set.has(p));
};

/** Whether a sign-in must pass an authenticator code, and whether they set one up first: their own setting, or a privileged role. */
export function signInFactor(s: { twoFactorRequired: boolean; totpEnabledAt: Date | null }, privileged: boolean): "code" | "enroll" | null {
  if (s.totpEnabledAt) return "code";
  return s.twoFactorRequired || privileged ? "enroll" : null;
}

/** Reveal, export and refund need a sign-in or step-up this recent. */
export const STEP_UP_MINUTES = 15;
export const STEP_UP_ACTIONS = ["reveal", "export", "refund"] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];
export const STEP_UP_LABEL: Record<StepUpAction, string> = { reveal: "show a client's hidden details", export: "export the client list", refund: "refund a sale" };
export const STEP_UP_MESSAGE = "Confirm it's you first, then try again.";

export const stepUpFresh = (at: Date | null | undefined, now: Date) => !!at && now.getTime() - at.getTime() <= STEP_UP_MINUTES * 60_000;

/** A staff app session unused this long ends: they sign in again, with their second step if they have one. */
export const IDLE_REVERIFY_DAYS = 30;
export const idleTooLong = (lastUsedAt: Date | null, now: Date) => !!lastUsedAt && now.getTime() - lastUsedAt.getTime() > IDLE_REVERIFY_DAYS * 86_400_000;

/** "Chrome on Windows" from a user agent, for someone's list of sign-ins and the new-device email. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown browser";
}
