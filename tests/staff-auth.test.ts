import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES, type Permission } from "@/domain/permissions";
import {
  IDLE_REVERIFY_DAYS,
  LOGIN_PER_EMAIL,
  PASSWORD_LOCK_EVERY,
  STEP_UP_MINUTES,
  deviceLabel,
  idleTooLong,
  isPrivileged,
  passwordLock,
  signInFactor,
  stepUpFresh,
} from "@/domain/staff-auth";

const now = new Date("2026-10-27T15:00:00Z");
const minutesOn = (d: Date | null) => (d ? Math.round((d.getTime() - now.getTime()) / 60_000) : null);

describe("password lockout (ST-C0c)", () => {
  it("locks on every 10th wrong password in a row, 15 minutes doubling, at most a day", () => {
    expect(minutesOn(passwordLock(9, now))).toBeNull();
    expect(minutesOn(passwordLock(10, now))).toBe(15);
    expect(minutesOn(passwordLock(11, now))).toBeNull();
    expect(minutesOn(passwordLock(20, now))).toBe(30);
    expect(minutesOn(passwordLock(30, now))).toBe(60);
    expect(minutesOn(passwordLock(200, now))).toBe(24 * 60);
  });
  it("locks at the email's rate limit, so a lock never tells an account exists", () => {
    expect(PASSWORD_LOCK_EVERY).toBe(LOGIN_PER_EMAIL);
  });
});

describe("two-step sign-in", () => {
  it("a code once set up; setting one up first when it's required or the role is privileged", () => {
    expect(signInFactor({ twoFactorRequired: false, totpEnabledAt: null }, false)).toBeNull();
    expect(signInFactor({ twoFactorRequired: true, totpEnabledAt: null }, false)).toBe("enroll");
    expect(signInFactor({ twoFactorRequired: false, totpEnabledAt: null }, true)).toBe("enroll");
    expect(signInFactor({ twoFactorRequired: false, totpEnabledAt: new Date() }, false)).toBe("code");
  });
  it("owners, admins, managers and the bookkeeper are privileged; barbers, the front desk and shop logins aren't", () => {
    const privileged = Object.fromEntries(ROLE_TEMPLATES.map((t) => [t.key, isPrivileged(t.permissions as Permission[])]));
    expect(privileged).toMatchObject({ brand_owner: true, shop_manager: true, bookkeeper: true, barber: false, front_desk: false, shop_login: false });
  });
});

describe("step-up and idle sessions", () => {
  it("a sign-in or step-up counts for 15 minutes", () => {
    expect(stepUpFresh(new Date(now.getTime() - STEP_UP_MINUTES * 60_000), now)).toBe(true);
    expect(stepUpFresh(new Date(now.getTime() - STEP_UP_MINUTES * 60_000 - 1), now)).toBe(false);
    expect(stepUpFresh(null, now)).toBe(false);
  });
  it("a staff app session unused 30 days ends", () => {
    expect(idleTooLong(new Date(now.getTime() - IDLE_REVERIFY_DAYS * 86_400_000), now)).toBe(false);
    expect(idleTooLong(new Date(now.getTime() - IDLE_REVERIFY_DAYS * 86_400_000 - 1), now)).toBe(true);
  });
  it("names the browser for the sign-in list and the new-device email", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(deviceLabel(null)).toBe("Unknown browser");
  });
});
